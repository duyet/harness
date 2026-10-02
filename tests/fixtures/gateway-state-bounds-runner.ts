import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spyOn } from "bun:test";

const [mode, home, cwd] = process.argv.slice(2);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);

function unexpected(name: string): never {
  throw new Error(`Unexpected side effect: ${name}`);
}

spyOn(Bun, "serve").mockImplementation(() => unexpected("Bun.serve"));
// Bun's `typeof fetch` is the call signature plus a non-standard `preconnect`,
// so a bare arrow is not a fetch. This stub refuses both, as it always has.
spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(() => unexpected("fetch"), { preconnect: () => unexpected("fetch") }),
);

const { STATE_DIR, INGRESS_QUEUE_FILE, LAST_INGRESS_FILE, LAST_DELIVERY_FILE } = await import("../../src/shared.ts");
assert.equal(STATE_DIR, join(home, ".local", "state", "herdr-harness"));
const { handleGatewayRequest } = await import("../../src/gateway.ts");
const bind = { hostname: "127.0.0.1", port: 8787 };

// Distinctive enough that finding it anywhere in a /status response means the
// raw payload leaked through the projection.
const MARKER = "harness-ingress-marker-8f3a2b";
// Stands in for the report body the delivery record carries.
const DELIVERY_MARKER = "harness-delivery-marker-c4d9e1";
const BODY_MAX_BYTES = 4 * 1024;
const TEXT_MAX_CHARS = 200;
const QUEUE_MAX_EVENTS = 50;
const QUEUE_MAX_BYTES = 2 * 1024 * 1024;
// Mirrors the budget in src/gateway.ts; keep the two in step.
const ORIGINAL_KEYS = [
  "at", "body", "channel", "freeform", "route", "sender", "source", "taskId", "text",
];

function request(path: string, method = "GET", body?: string) {
  return handleGatewayRequest(new Request(`http://localhost${path}`, { method, body }), bind);
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sizeOf(path: string): number {
  return statSync(path).size;
}

async function post(path: string, body: Record<string, unknown>) {
  const response = await request(path, "POST", JSON.stringify(body));
  assert.equal(response.status, path === "/chat" ? 200 : 202, path);
  const result = await response.json();
  assert.equal(result.ok, true, path);
  return result;
}

async function getStatus() {
  const response = await request("/status");
  assert.equal(response.status, 200);
  // A body can only be read once; keep the raw text so the marker check sees
  // exactly the bytes a caller would receive.
  const raw = await response.text();
  return { json: JSON.parse(raw) as Record<string, any>, raw };
}

// A telegram body of `blobBytes` with the marker at the very tail — past the
// 4 KB cap, so both "the prefix cut before it" and "/status never carried it"
// are real assertions rather than accidents of payload ordering.
function bigTelegram(label: string, blobBytes: number) {
  return {
    message: {
      text: `burst ${label}`,
      chat: { id: 42 },
      from: { username: "fixture-user" },
      blob: `${"x".repeat(blobBytes)}${MARKER}`,
    },
  };
}

let detail: Record<string, unknown> = {};

if (mode === "verbatim") {
  // Characterization: ordinary events keep exactly today's fields and files.
  const telegram = {
    message: { text: "hello there", chat: { id: 7 }, from: { username: "alice" } },
  };
  const telegramResult = await post("/ingress/telegram", telegram);
  assert.equal(telegramResult.queued, 1);
  const telegramEvent = readJson(LAST_INGRESS_FILE);
  assert.deepEqual(Object.keys(telegramEvent).sort(), ORIGINAL_KEYS);
  assert.deepEqual(telegramEvent.body, telegram);
  assert.equal(telegramEvent.text, "hello there");
  assert.equal(telegramEvent.source, "telegram");
  assert.equal(telegramEvent.channel, "7");
  assert.equal(telegramEvent.sender, "alice");

  const chatBody = { text: "hello from chat", extra: [1] };
  const chatResult = await post("/chat", chatBody);
  assert.equal(chatResult.queued, 2);
  const chatEvent = readJson(LAST_INGRESS_FILE);
  assert.deepEqual(Object.keys(chatEvent).sort(), ORIGINAL_KEYS);
  assert.deepEqual(chatEvent.body, chatBody);
  assert.equal(chatEvent.text, "hello from chat");
  assert.equal(chatEvent.source, "chat");

  // Queue mirrors the last event, still verbatim, still two deep.
  const queue = readJson(INGRESS_QUEUE_FILE);
  assert.equal(queue.length, 2);
  assert.deepEqual(queue.at(-1), chatEvent);
  assert.deepEqual(queue[0], telegramEvent);
  assert.deepEqual(JSON.parse(readFileSync(INGRESS_QUEUE_FILE, "utf8")), queue);

  // A small event still projects every field the chat page reads.
  const status = await getStatus();
  assert.equal(status.json.lastEvent.at, chatEvent.at);
  assert.equal(status.json.lastEvent.source, "chat");
  assert.equal(status.json.lastEvent.taskId, null);
  assert.equal(status.json.lastEvent.text, "hello from chat");
  assert.equal("body" in status.json.lastEvent, false);
  assert.equal("route" in status.json.lastEvent, false);
  assert.equal("bodyTruncated" in status.json.lastEvent, false);
} else if (mode === "oversized") {
  // One oversized event: capped body, honest size, capped text.
  const raw = {
    message: {
      text: "y".repeat(TEXT_MAX_CHARS + 100),
      chat: { id: 99 },
      from: { username: "big-user" },
      blob: `${"x".repeat(64 * 1024)}${MARKER}`,
    },
  };
  const originalBytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
  const result = await post("/ingress/telegram", raw);
  assert.equal(result.queued, 1);

  const event = readJson(LAST_INGRESS_FILE);
  assert.equal(event.bodyTruncated, true);
  assert.equal(event.bodyBytes, originalBytes);
  assert(Buffer.byteLength(event.body, "utf8") <= BODY_MAX_BYTES, "capped body over budget");
  assert(event.body.startsWith('{"message":{"text":"yyy'), "capped body should keep the first chunk");
  assert.equal(event.body.includes(MARKER), false, "capped body should cut before the tail");

  // text is capped on its own, not at the body's cut point.
  assert.equal(event.textTruncated, true);
  assert.equal(event.textBytes, Buffer.byteLength(raw.message.text, "utf8"));
  assert.equal(event.text, `${"y".repeat(TEXT_MAX_CHARS)}…`);
  assert.equal(event.text.length, TEXT_MAX_CHARS + 1);

  // The POST response still echoes the caller's own uncapped text.
  assert.equal(result.task.text, raw.message.text);

  // Case 4: /status projects, and the payload never reaches it.
  const status = await getStatus();
  assert.equal(status.raw.includes(MARKER), false, "/status echoed the raw body");
  assert.equal(status.raw.includes(event.body.slice(0, 200)), false, "/status echoed the body prefix");
  const projected = status.json.lastEvent;
  assert.deepEqual(Object.keys(projected).sort(), [
    "at", "bodyBytes", "bodyTruncated", "channel", "freeform", "sender", "source", "taskId",
    "text", "textBytes", "textTruncated",
  ]);
  assert.equal(projected.at, event.at);
  assert.equal(projected.source, "telegram");
  assert.equal(projected.taskId, null);
  assert.equal(projected.channel, "99");
  assert.equal(projected.sender, "big-user");
  assert.equal(projected.freeform, true);
  assert.equal(projected.text, event.text);
  assert.equal(projected.bodyTruncated, true);
  assert.equal(projected.bodyBytes, originalBytes);
  assert.equal(projected.textTruncated, true);
  assert.equal(projected.textBytes, event.textBytes);
  detail = { originalBytes, marker: MARKER };
} else if (mode === "delivery") {
  // Nothing delivered yet: the field is present and null, not an empty
  // projection, so a caller can tell "no delivery" from "delivery with no data".
  const empty = await getStatus();
  assert.equal(empty.json.lastDelivery, null);

  // A planted record whose paths all sit under the fixture home. The home
  // embeds a random temp segment, so any path surviving into a response is
  // visible as a leak without depending on the real username.
  mkdirSync(STATE_DIR, { recursive: true });
  const delivery = {
    kind: "summary",
    at: new Date().toISOString(),
    summaryPath: join(STATE_DIR, "last-summary.md"),
    summaryJsonPath: join(STATE_DIR, "last-summary.json"),
    deliveryPath: join(STATE_DIR, "last-delivery.json"),
    bytes: 4321,
    excerpt: `# harness daily summary\n\n${DELIVERY_MARKER}`,
  };
  writeFileSync(LAST_DELIVERY_FILE, `${JSON.stringify(delivery, null, 2)}\n`);

  // An ordinary event alongside it, so the delivery projection is measured
  // next to the lastEvent projection rather than in place of it.
  await post("/ingress/telegram", {
    message: { text: "status probe", chat: { id: 5 }, from: { username: "probe-user" } },
  });

  const status = await getStatus();
  assert.equal(status.raw.includes(STATE_DIR), false, "/status leaked STATE_DIR");
  assert.equal(status.raw.includes(home), false, "/status leaked the fixture home");
  assert.equal(status.raw.includes("last-summary.md"), false, "/status leaked summaryPath");
  assert.equal(status.raw.includes("last-summary.json"), false, "/status leaked summaryJsonPath");
  assert.equal(status.raw.includes("last-delivery.json"), false, "/status leaked deliveryPath");

  const projected = status.json.lastDelivery;
  assert.deepEqual(Object.keys(projected).sort(), ["at", "bytes", "excerpt", "kind"]);
  assert.equal(projected.kind, "summary");
  assert.equal(projected.at, delivery.at);
  assert.equal(projected.bytes, 4321);
  assert.match(projected.excerpt, /harness daily summary/);

  // lastEvent's projection is unchanged by this change.
  const event = status.json.lastEvent;
  assert.equal(event.source, "telegram");
  assert.equal(event.channel, "5");
  assert.equal(event.sender, "probe-user");
  assert.equal(event.text, "status probe");
  assert.equal("body" in event, false);

  // The stub pickup answers on the same unauthenticated surface, so it must not
  // carry the path back either.
  const pickup = await post("/chat", { text: "/summary" });
  assert.deepEqual(Object.keys(pickup.lastSummary).sort(), ["at", "excerpt"]);
  const pickupRaw = JSON.stringify(pickup);
  assert.equal(pickupRaw.includes(STATE_DIR), false, "/chat pickup leaked STATE_DIR");
  assert.equal(pickupRaw.includes("last-summary.md"), false, "/chat pickup leaked summaryPath");
  assert.match(pickup.lastSummary.excerpt, /harness daily summary/);
  detail = { projectionKeys: Object.keys(projected).sort() };
} else if (mode === "burst") {
  // Case 3 + 6: 60 large events stay bounded and the count window still holds.
  for (let i = 0; i < 60; i++) {
    const result = await post("/ingress/telegram", bigTelegram(`burst-${i}`, 64 * 1024));
    assert.equal(result.ok, true);
  }
  const queue = readJson(INGRESS_QUEUE_FILE);
  assert.equal(queue.length, QUEUE_MAX_EVENTS);
  assert(
    sizeOf(INGRESS_QUEUE_FILE) < QUEUE_MAX_BYTES,
    `queue ${sizeOf(INGRESS_QUEUE_FILE)} exceeds ${QUEUE_MAX_BYTES}`,
  );
  assert(sizeOf(LAST_INGRESS_FILE) < 8 * 1024, `last-ingress.json is ${sizeOf(LAST_INGRESS_FILE)}`);
  assert.equal(queue.at(-1).text, "burst burst-59");
  assert.equal(queue[0].text, "burst burst-10", "count window should drop the oldest 10");
  for (const event of queue) {
    assert.equal(event.bodyTruncated, true);
    assert(Buffer.byteLength(event.body, "utf8") <= BODY_MAX_BYTES);
  }
  detail = {
    queueBytes: sizeOf(INGRESS_QUEUE_FILE),
    lastBytes: sizeOf(LAST_INGRESS_FILE),
  };
} else if (mode === "budget-evict") {
  // The byte budget on its own. A queue seeded with pre-bound (unbounded-body)
  // events is how a queue written by an older build reaches this path, since
  // capped events alone cannot outgrow the budget within the count window.
  const seeded = Array.from({ length: QUEUE_MAX_EVENTS }, (_, i) => ({
    at: new Date().toISOString(),
    source: "telegram",
    taskId: null,
    text: `seeded-${i}`,
    sender: "seed",
    channel: "0",
    freeform: true,
    route: { error: "freeform intent", defaultAdapter: "seed", freeform: true },
    body: `${MARKER}`.padEnd(60 * 1024, "x"),
  }));
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(INGRESS_QUEUE_FILE, `${JSON.stringify(seeded, null, 2)}\n`);
  assert(sizeOf(INGRESS_QUEUE_FILE) > QUEUE_MAX_BYTES, "fixture must exceed the budget to be a test");

  const result = await post("/ingress/telegram", bigTelegram("newest", 1024));
  assert.equal(result.ok, true);
  const queue = readJson(INGRESS_QUEUE_FILE);
  assert.equal(queue.at(-1).text, "burst newest", "the newest event must survive");
  assert(
    sizeOf(INGRESS_QUEUE_FILE) <= QUEUE_MAX_BYTES,
    `queue ${sizeOf(INGRESS_QUEUE_FILE)} still exceeds ${QUEUE_MAX_BYTES}`,
  );
  assert(
    queue.every((e: { text: string }) => e.text !== "seeded-0"),
    "oldest seeded events should be dropped",
  );
  assert.equal(queue.length < QUEUE_MAX_EVENTS, true);
  detail = { kept: queue.length, queueBytes: sizeOf(INGRESS_QUEUE_FILE) };
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}
console.log(JSON.stringify({ ok: true, mode, ...detail }));