import { strict as assert } from "node:assert";
import { connect } from "node:net";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spyOn } from "bun:test";

const [mode, home, cwd] = process.argv.slice(2);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);

// Thresholds mirrored from src/gateway.ts; keep the two in step.
const SENDER_MAX_CHARS = 200;
const CHANNEL_MAX_CHARS = 200;
const TASK_ID_MAX_CHARS = 512;
const TEXT_MAX_CHARS = 200;
const REQUEST_MAX_BYTES = 256 * 1024;
// An ordinary event must serialize to exactly today's keys.
const ORIGINAL_KEYS = [
  "at", "body", "channel", "freeform", "route", "sender", "source", "taskId", "text",
];
// Finding either marker in a response means an uncapped value leaked through.
const MARKER = "harness-ingress-cap-marker-4c1d9e";
const TAIL = "harness-ingress-cap-tail-77b0a2";

// Every source, so "which cap does this field pass through?" has one answer.
const SOURCES = ["/ingress/matrix", "/ingress/telegram", "/chat"] as const;

// The socket mode drives a real server; the others call the handler in-process
// with the network mocked out, matching tests/gateway-state-bounds.test.ts.
const live = mode === "socket";
if (!live) {
  const unexpected = (name: string): never => {
    throw new Error(`Unexpected side effect: ${name}`);
  };
  spyOn(Bun, "serve").mockImplementation(() => unexpected("Bun.serve"));
  // Bun's `typeof fetch` is the call signature plus a non-standard `preconnect`,
  // so a bare arrow is not a fetch. This stub refuses both, as it always has.
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(() => unexpected("fetch"), { preconnect: () => unexpected("fetch") }),
  );
}

const { STATE_DIR, INGRESS_QUEUE_FILE, LAST_INGRESS_FILE } = await import("../../src/shared.ts");
assert.equal(STATE_DIR, join(home, ".local", "state", "herdr-harness"));
const { handleGatewayRequest, startGatewayServer } = await import("../../src/gateway.ts");
const bind = { hostname: "127.0.0.1", port: 8787 };

function request(path: string, method = "GET", body?: string, headers?: Record<string, string>) {
  return handleGatewayRequest(new Request(`http://localhost${path}`, { method, body, headers }), bind);
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function post(path: string, body: Record<string, unknown>) {
  const response = await request(path, "POST", JSON.stringify(body));
  assert.equal(response.status, path === "/chat" ? 200 : 202, path);
  const result = await response.json();
  assert.equal(result.ok, true, path);
  return result as Record<string, any>;
}

async function getStatus() {
  const response = await request("/status");
  assert.equal(response.status, 200);
  // A body can only be read once; keep the raw text so the marker and size
  // checks see exactly the bytes a caller would receive.
  const raw = await response.text();
  return { json: JSON.parse(raw) as Record<string, any>, raw };
}

// Every oversized value pads past the cap and keeps the distinctive runs at the
// tail, so "the cap cut before them" and "they were never capped" are different
// outcomes rather than the same short string.
const big = (head: string, size: number) => `${head}${"x".repeat(size)}${MARKER}${TAIL}`;

function oversizedSender() {
  return big("s", 8 * 1024);
}

function oversizedChannel() {
  return big("c", 8 * 1024);
}

function oversizedTaskId() {
  return big("t", 4 * 1024);
}

let detail: Record<string, unknown> = {};

if (mode === "verbatim") {
  // Case 1: ordinary matrix and telegram events keep exactly today's shape —
  // no new flag appears, and the projection is the same set of fields.
  const telegram = {
    message: { text: "hello there", chat: { id: 7 }, from: { username: "alice" } },
  };
  const telegramResult = await post("/ingress/telegram", telegram);
  assert.equal(telegramResult.queued, 1);
  const telegramEvent = readJson(LAST_INGRESS_FILE);
  assert.deepEqual(Object.keys(telegramEvent).sort(), ORIGINAL_KEYS);
  assert.deepEqual(telegramEvent.body, telegram);
  assert.equal(telegramEvent.text, "hello there");
  assert.equal(telegramEvent.sender, "alice");
  assert.equal(telegramEvent.channel, "7");
  assert.equal(telegramEvent.taskId, null);

  const matrix = {
    content: { body: "task: fixture-task" },
    sender: "@bob:example.org",
    room_id: "!room:example.org",
  };
  const matrixResult = await post("/ingress/matrix", matrix);
  assert.equal(matrixResult.queued, 2);
  const matrixEvent = readJson(LAST_INGRESS_FILE);
  assert.deepEqual(Object.keys(matrixEvent).sort(), ORIGINAL_KEYS);
  assert.equal(matrixEvent.sender, "@bob:example.org");
  assert.equal(matrixEvent.channel, "!room:example.org");
  // The chat page header reads taskId straight off /status; it must survive.
  assert.equal(matrixEvent.taskId, "fixture-task");
  assert.equal(matrixResult.task.id, "fixture-task");

  const projected = (await getStatus()).json.lastEvent;
  assert.deepEqual(Object.keys(projected).sort(), [
    "at", "channel", "freeform", "sender", "source", "taskId", "text",
  ]);
  assert.equal(projected.taskId, "fixture-task");
  assert.equal(projected.sender, "@bob:example.org");
  assert.equal(projected.channel, "!room:example.org");
  detail = { marker: MARKER };
} else if (mode === "sender") {
  // Case 2: an oversized matrix sender is capped, flagged and reported.
  const sender = oversizedSender();
  await post("/ingress/matrix", { content: { body: "hello" }, sender });
  const event = readJson(LAST_INGRESS_FILE);
  assert.equal(event.senderTruncated, true);
  assert.equal(event.senderBytes, Buffer.byteLength(sender, "utf8"));
  assert.equal(event.sender, `${sender.slice(0, SENDER_MAX_CHARS)}…`);
  assert.equal(event.sender.length, SENDER_MAX_CHARS + 1);
  assert.equal(event.sender.includes(MARKER), false, "capped sender should cut before the marker");
  // Only the capped field carries a flag; nothing else was touched.
  assert.equal("channelTruncated" in event, false);
  assert.equal("taskIdTruncated" in event, false);
  assert.equal("textTruncated" in event, false);

  const projected = (await getStatus()).json.lastEvent;
  assert.equal(projected.senderTruncated, true);
  assert.equal(projected.senderBytes, event.senderBytes);
  assert.equal(projected.sender, event.sender);
  detail = { senderBytes: event.senderBytes, projectedBytes: projected.sender.length };
} else if (mode === "channel") {
  // Case 3: same for a Telegram chat.id, which arrives through String(chat.id).
  const channel = oversizedChannel();
  await post("/ingress/telegram", {
    message: { text: "hello", chat: { id: channel }, from: { username: "alice" } },
  });
  const event = readJson(LAST_INGRESS_FILE);
  assert.equal(event.channelTruncated, true);
  assert.equal(event.channelBytes, Buffer.byteLength(channel, "utf8"));
  assert.equal(event.channel, `${channel.slice(0, CHANNEL_MAX_CHARS)}…`);
  assert.equal(event.channel.includes(MARKER), false);
  assert.equal("senderTruncated" in event, false);

  const projected = (await getStatus()).json.lastEvent;
  assert.equal(projected.channelTruncated, true);
  assert.equal(projected.channelBytes, event.channelBytes);
  detail = { channelBytes: event.channelBytes };
} else if (mode === "task-id") {
  // Case 4: both direct branches and the regex branch, plus the rule that a
  // realistic id still resolves and a capped one stops matching honestly.
  const direct = oversizedTaskId();
  await post("/ingress/matrix", { content: { body: "hello" }, taskId: direct });
  let event = readJson(LAST_INGRESS_FILE);
  assert.equal(event.taskIdTruncated, true);
  assert.equal(event.taskIdBytes, Buffer.byteLength(direct, "utf8"));
  assert.equal(event.taskId, `${direct.slice(0, TASK_ID_MAX_CHARS)}…`);

  const snake = oversizedTaskId();
  await post("/ingress/telegram", {
    message: { text: "hello", chat: { id: 1 }, from: { username: "alice" } },
    task_id: snake,
  });
  event = readJson(LAST_INGRESS_FILE);
  assert.equal(event.taskIdTruncated, true);
  assert.equal(event.taskIdBytes, Buffer.byteLength(snake, "utf8"));

  // The regex branch reads uncapped text, so it needs the cap too.
  const derived = "a".repeat(4 * 1024);
  const derivedResult = await post("/ingress/matrix", {
    content: { body: `task: ${derived}` },
  });
  event = readJson(LAST_INGRESS_FILE);
  assert.equal(event.taskIdTruncated, true);
  assert.equal(event.taskIdBytes, derived.length);
  assert.equal(event.taskId, `${"a".repeat(TASK_ID_MAX_CHARS)}…`);
  // A capped id can no longer match a config task, and it says so rather than
  // resolving to the wrong one — the route error names the value it compared.
  assert.equal(derivedResult.task.freeform, true);
  assert.match(event.route.error, /^unknown task: a+…$/);

  // A long-but-realistic id (well under the cap) resolves unchanged, with no
  // flag — capping a lookup key must not cost a working route.
  const longId = `long-task-${"z".repeat(300)}`;
  const resolvedResult = await post("/ingress/matrix", { content: { body: "hi" }, taskId: longId });
  event = readJson(LAST_INGRESS_FILE);
  assert.equal(event.taskId, longId);
  assert.equal("taskIdTruncated" in event, false);
  assert.equal(resolvedResult.task.freeform, false);
  assert.equal(resolvedResult.task.adapterId, "fixture-adapter");

  // And a short one still routes, byte-identical to before.
  const shortResult = await post("/ingress/matrix", { content: { body: "hi" }, taskId: "fixture-task" });
  assert.equal(shortResult.task.id, "fixture-task");
  assert.equal(shortResult.task.freeform, false);

  const projected = (await getStatus()).json.lastEvent;
  assert.equal(projected.taskId, "fixture-task");
  assert.equal("taskIdTruncated" in projected, false);
  detail = { taskIdBytes: event.taskIdBytes ?? null, longIdLength: longId.length };
} else if (mode === "sources") {
  // Cases 5 + 6: every ingress source caps what it takes from the caller, and
  // /status stays small and never silently shortens anything. `sender` is the
  // one that differs by source — /chat ignores the caller's and names itself —
  // so the three are asserted separately rather than through one loop body.
  const text = "t".repeat(TEXT_MAX_CHARS + 500);
  const sender = oversizedSender();
  const bodies: Record<string, Record<string, unknown>> = {
    "/ingress/matrix": { content: { body: text }, sender },
    "/ingress/telegram": { message: { text, chat: { id: 3 }, from: { username: sender } } },
    "/chat": { text, sender },
  };
  // matrix and telegram copy the caller's sender and must cap it; /chat stores
  // its own literal, so an oversized `sender` there is discarded, not cut.
  const carriesSender: Record<string, boolean> = {
    "/ingress/matrix": true,
    "/ingress/telegram": true,
    "/chat": false,
  };
  const observed: Array<{ path: string; statusBytes: number }> = [];
  for (const path of SOURCES) {
    const result = await post(path, bodies[path]!);
    const event = readJson(LAST_INGRESS_FILE);
    assert.equal(event.textTruncated, true, path);
    assert.equal(event.textBytes, Buffer.byteLength(text, "utf8"), path);
    assert.equal(event.text, `${text.slice(0, TEXT_MAX_CHARS)}…`, path);
    if (carriesSender[path]) {
      assert.equal(event.senderTruncated, true, path);
      assert.equal(event.senderBytes, Buffer.byteLength(sender, "utf8"), path);
      assert.equal(event.sender.includes(MARKER), false, path);
    } else {
      assert.equal(event.sender, "chat-ui", path);
      assert.equal("senderTruncated" in event, false, path);
    }
    // The response echoes the caller's own uncapped text, but the sender the
    // normalizer produced — the cap runs there, not at the response.
    assert.equal(result.task.text, text, path);
    assert.equal(result.task.sender, event.sender, path);
    assert.equal(result.task.sender.includes(MARKER), false, path);

    const status = await getStatus();
    assert.equal(status.raw.includes(MARKER), false, `${path}: /status echoed the payload`);
    assert.equal(status.raw.includes(TAIL), false, `${path}: /status echoed the payload`);
    // Nothing was shortened without saying so: for every field this source
    // actually takes from the caller, a value shorter than the one sent must
    // carry its flag. (/chat's sender is not the caller's value at all, so it
    // is not in this set.)
    const projected = status.json.lastEvent;
    const carried: Array<[("sender" | "text"), string]> = [["text", text]];
    if (carriesSender[path]) carried.push(["sender", sender]);
    for (const [field, full] of carried) {
      if (projected[field] === full) continue;
      assert.equal(projected[`${field}Truncated`], true, `${path}: ${field} shortened unflagged`);
      assert(projected[`${field}Bytes`] > projected[field].length, `${path}: ${field}Bytes missing`);
    }
    observed.push({ path, statusBytes: Buffer.byteLength(status.raw, "utf8") });
  }
  assert.equal(readJson(INGRESS_QUEUE_FILE).length, SOURCES.length);
  for (const entry of observed) {
    assert(entry.statusBytes < 4 * 1024, `${entry.path}: /status was ${entry.statusBytes} bytes`);
  }
  detail = { marker: MARKER, statusBytes: observed };
} else if (mode === "content-length") {
  // Case 7: a declared oversized body is refused with 413 before it is read,
  // leaving the queue exactly as it was.
  await post("/ingress/telegram", { message: { text: "first", chat: { id: 1 }, from: { username: "a" } } });
  const before = readFileSync(INGRESS_QUEUE_FILE, "utf8");
  const lastBefore = readFileSync(LAST_INGRESS_FILE, "utf8");

  const declared = String(REQUEST_MAX_BYTES + 1);
  const response = await request(
    "/ingress/telegram",
    "POST",
    JSON.stringify({ message: { text: "big", chat: { id: 2 }, from: { username: oversizedSender() } } }),
    { "content-length": declared },
  );
  assert.equal(response.status, 413);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  // Same envelope shape as the 400s, with a distinct status code.
  const envelope = await response.json();
  assert.deepEqual(Object.keys(envelope).sort(), ["error", "ok"]);
  assert.equal(envelope.ok, false);
  assert.match(String(envelope.error), /request body exceeds 262144 bytes/);

  // Nothing was written and the queue is untouched.
  assert.equal(readFileSync(INGRESS_QUEUE_FILE, "utf8"), before);
  assert.equal(readFileSync(LAST_INGRESS_FILE, "utf8"), lastBefore);
  assert.equal(readJson(INGRESS_QUEUE_FILE).length, 1);

  // An honest, in-budget request still works — the ceiling is not a blanket
  // refusal for the routes' real traffic.
  const ok = await request(
    "/ingress/telegram",
    "POST",
    JSON.stringify({ message: { text: "second", chat: { id: 3 }, from: { username: "b" } } }),
    { "content-length": String(128) },
  );
  assert.equal(ok.status, 202);
  assert.equal(readJson(INGRESS_QUEUE_FILE).length, 2);
  detail = { declared, statusBytes: Buffer.byteLength(JSON.stringify(envelope), "utf8") };
} else if (mode === "socket") {
  // Case 8: the real server. Bun's maxRequestBodySize only refuses a declared
  // oversize, so the counted read is what bounds a client that sends a body
  // larger than the ceiling with no Content-Length to check.
  const quiet = console.error;
  console.error = () => {};
  process.env.HARNESS_GATEWAY_HOST = "127.0.0.1";
  process.env.HARNESS_GATEWAY_PORT = "0";
  const server = startGatewayServer();
  console.error = quiet;
  // Bun reports the port it actually bound, which is optional until the listener
  // is up; an absent one is not a port, and the assertion below rejects it as
  // the same failure it always was.
  const port = server.port ?? 0;
  assert(port > 0, "expected an ephemeral port");

  // Loopback only; no name resolution and nothing outside the fixture.
  const raw = (head: string, body: string) =>
    new Promise<string>((resolve) => {
      let out = "";
      const socket = connect({ host: "127.0.0.1", port }, () => socket.write(head + body));
      // A 413 arrives with no body and the peer keeps the connection open, so
      // the backstop is the only exit; clearing it keeps the runner's event loop
      // empty and lets the process exit the moment the last case is done.
      const backstop = setTimeout(() => { socket.destroy(); resolve(out); }, 2_000);
      const finish = () => { clearTimeout(backstop); socket.destroy(); resolve(out); };
      socket.on("data", (d) => { out += d.toString("utf8"); });
      socket.on("close", finish);
      socket.on("error", finish);
    });

  function chunked(text: string) {
    let out = "";
    for (let i = 0; i < text.length; i += 8192) {
      const piece = text.slice(i, i + 8192);
      out += `${piece.length.toString(16)}\r\n${piece}\r\n`;
    }
    return `${out}0\r\n\r\n`;
  }
  const CHUNKED_HEAD =
    "POST /ingress/telegram HTTP/1.1\r\nHost: localhost\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n";

  // No Content-Length at all, above the ceiling: the handler's counted read is
  // the only thing that can catch this. Modest oversize still gets the JSON
  // envelope; a body far past the ceiling is one the server drops the
  // connection on instead of answering, which is equally bounded and is pinned
  // here so the difference is a characterized behavior rather than a surprise.
  const oversized = await raw(CHUNKED_HEAD, chunked(JSON.stringify({
    message: { text: "big", chat: { id: 1 }, from: { username: oversizedSender() } },
  }).padEnd(REQUEST_MAX_BYTES * 2, "x")));
  assert.match(oversized.split("\r\n")[0]!, /^HTTP\/1\.1 413/);

  // A declared oversize is refused by the server before the handler runs.
  const declared = await raw(
    "POST /ingress/telegram HTTP/1.1\r\nHost: localhost\r\ncontent-type: application/json\r\ncontent-length: 9999999\r\n\r\n",
    "",
  );
  assert.match(declared.split("\r\n")[0]!, /^HTTP\/1\.1 413/);

  // A 5x-ceiling flood: either answer is fine, writing nothing is not optional.
  const flood = await raw(CHUNKED_HEAD, chunked(JSON.stringify({
    message: { text: "flood", chat: { id: 2 }, from: { username: "a" } },
  }).padEnd(REQUEST_MAX_BYTES * 5, "x")));
  assert(
    flood.startsWith("HTTP/1.1 413") || flood === "",
    `flood answered unexpectedly: ${JSON.stringify(flood.slice(0, 60))}`,
  );

  // None of the three refusals wrote an ingress event.
  assert.equal(existsSync(LAST_INGRESS_FILE), false);
  assert.equal(existsSync(INGRESS_QUEUE_FILE), false);

  // An ordinary chunked body — the shape a real client sends — still gets in.
  const ordinaryBody = JSON.stringify({
    message: { text: "ok", chat: { id: 4 }, from: { username: "alice" } },
  });
  const ordinary = await raw(CHUNKED_HEAD, chunked(ordinaryBody));
  assert.match(ordinary.split("\r\n")[0]!, /^HTTP\/1\.1 202/);
  const stored = readJson(LAST_INGRESS_FILE);
  assert.equal(stored.text, "ok");
  assert.equal(stored.sender, "alice");
  assert.equal(statSync(INGRESS_QUEUE_FILE).size < 8 * 1024, true);

  server.stop(true);
  detail = { marker: MARKER, portWasEphemeral: true };
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}

console.log(JSON.stringify({ ok: true, mode, ...detail }));
