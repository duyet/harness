import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
const { STATE_DIR, LAST_INGRESS_FILE, INGRESS_QUEUE_FILE, ISSUES_DIR, VERSION } = await import("../../src/shared.ts");
assert.equal(STATE_DIR, join(home, ".local", "state", "herdr-harness"));
const { handleGatewayRequest } = await import("../../src/gateway.ts");
const bind = { hostname: "127.0.0.1", port: 8787 };
const routes = ["/chat", "/ingress/matrix", "/ingress/telegram", "/ingress/sentry", "/ingress/bugsink"];

function request(path: string, method = "GET", body?: string) {
  return handleGatewayRequest(new Request(`http://localhost${path}`, { method, body }), bind);
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function snapshot(path = STATE_DIR): unknown {
  if (!existsSync(path)) return null;
  if (!statSync(path).isDirectory()) return readFileSync(path).toString("base64");
  return readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))]);
}

let queued = 0;
async function accepted(path: string, body: Record<string, unknown>) {
  const response = await request(path, "POST", JSON.stringify(body));
  assert.equal(response.status, path === "/chat" ? 200 : 202, path);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const result = await response.json();
  assert.equal(result.ok, true, path);
  const source = path.split("/").pop();
  if (source === "sentry" || source === "bugsink") {
    assert.equal(result.source, source);
    assert.equal(result.queued, true);
    assert.equal(result.draft.source, source);
    assert.equal(result.draft.status, "mock-draft");
    assert.equal(result.draft.playbook, "desk:sentry-issues");
    // The 202 answers with a projection, not the draft. The absolute path is
    // not on it (plan 029: an unauthenticated route must not hand out
    // $HOME/username), so the file is found by the name derived from the
    // fingerprint and containment is asserted on the stored copy, which does
    // record where it was written.
    assert.equal("path" in result.draft, false);
    const draftPath = join(ISSUES_DIR, `${source}-${result.draft.fingerprint}.json`);
    const stored = readJson(draftPath);
    assert.equal(stored.path, draftPath);
    assert.equal(dirname(stored.path), ISSUES_DIR);
    assert.equal(stored.fingerprint, result.draft.fingerprint);
    assert.deepEqual(stored.raw, body);
    assert.equal("raw" in result.draft, false);
    assert.equal("body" in result.draft, false);
  } else {
    queued++;
    assert.equal(result.queued, queued);
    const event = readJson(LAST_INGRESS_FILE);
    const queue = readJson(INGRESS_QUEUE_FILE);
    assert.equal(queue.length, queued);
    assert.deepEqual(queue.at(-1), event);
    assert.deepEqual(event.body, body);
    assert.equal(event.source, source);
    assert.equal(result.lastEvent, event.at);
    assert(Number.isFinite(Date.parse(result.lastEvent)));
    for (const key of ["text", "sender", "channel", "freeform"]) {
      assert.deepEqual(result.task[key], event[key]);
    }
    assert.equal(result.task.id, event.taskId);
    if (source === "chat") {
      assert.equal(result.reply, result.task.freeform
        ? `stub: freeform via fixture-default — ${result.task.text ?? "(empty)"}`
        : "stub: routed task fixture-task → adapter fixture-adapter (fixture). No LLM.");
      assert.equal("source" in result, false);
    } else {
      assert.equal(result.source, source);
    }
  }
  assert.equal(existsSync(join(STATE_DIR, "gateway.json")), false);
  return result;
}

if (mode === "happy") {
  const before = snapshot();
  for (const path of ["/", "/chat"]) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(await response.text(), /<!doctype html>/i);
  }
  assert.deepEqual(await (await request("/health")).json(), {
    ok: true, service: "harness-gateway", version: VERSION, bind,
  });
  const status = await request("/status");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { ok: true, listening: true, version: VERSION, bind, lastEvent: null, lastDelivery: null });
  for (const [path, method, body] of [["/missing", "GET"], ["/missing", "POST", "{"], ["/health", "POST", "{"], ["/ingress/matrix", "GET"], ["/chat", "PUT", "{"]]) {
    const response = await request(path!, method, body);
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(await response.json(), { ok: false, error: "not found" });
  }
  assert.deepEqual(snapshot(), before);
  for (const path of routes) {
    const result = await accepted(path, {});
    if (result.task) {
      assert.equal(result.task.freeform, true);
      assert.equal(result.task.adapterId, "fixture-default");
      assert.equal(result.task.text, null);
      assert.equal(result.route, null);
    }
  }
  const chat = await accepted("/chat", { text: "hello", extra: [1] });
  assert.deepEqual(chat.task, { id: null, text: "hello", sender: "chat-ui", channel: "local", adapterId: "fixture-default", freeform: true });
  const matrix = await accepted("/ingress/matrix", { content: { body: "matrix hello" }, sender: "fixture-sender", room_id: "fixture-room" });
  assert.deepEqual(matrix.task, { id: null, text: "matrix hello", sender: "fixture-sender", channel: "fixture-room", adapterId: "fixture-default", freeform: true });
  const telegram = await accepted("/ingress/telegram", { message: { text: "telegram hello", chat: { id: 42 }, from: { username: "fixture-user" } } });
  assert.deepEqual(telegram.task, { id: null, text: "telegram hello", sender: "fixture-user", channel: "42", adapterId: "fixture-default", freeform: true });
  for (const path of routes.slice(3)) {
    const result = await accepted(path, { event_id: "fixture-event", project: "fixture", message: "example error", level: "warning" });
    assert.equal(result.draft.fingerprint, "fixture-event");
    assert.equal(result.draft.title, `[${result.source}] fixture: example error`);
    assert.deepEqual(result.draft.labels, ["mock", result.source, "warning", "desk:sentry-issues"]);
  }
  // /status answers with a projection, not the stored event: every field the
  // chat page reads survives, and the body and route do not. The full event is
  // still available locally through `harness summary --json`.
  const stored = readJson(LAST_INGRESS_FILE);
  const projected = (await (await request("/status")).json()).lastEvent;
  assert.deepEqual(projected, {
    at: stored.at,
    source: stored.source,
    taskId: stored.taskId,
    channel: stored.channel,
    sender: stored.sender,
    freeform: stored.freeform,
    text: stored.text,
  });
  assert.equal("body" in projected, false);
  assert.equal("route" in projected, false);
} else if (mode === "invalid" || mode === "invalid-seeded") {
  assert.equal(existsSync(STATE_DIR), false, "fixture must start without state");
  if (mode === "invalid-seeded") {
    for (const path of routes) await accepted(path, {});
    mkdirSync(join(STATE_DIR, "sentinel", "empty"), { recursive: true });
    writeFileSync(join(STATE_DIR, "sentinel", "bytes"), Buffer.from([0, 255, 10]));
  }
  const before = snapshot();
  async function rejected(path: string, body: string, error: string) {
    const label = `${path} ${JSON.stringify(body)}`;
    const response = await request(path, "POST", body);
    assert.equal(response.status, 400, label);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/, label);
    assert.deepEqual(await response.json(), { ok: false, error }, label);
    assert.deepEqual(snapshot(), before, `${label}: state changed`);
  }
  for (const path of routes) {
    for (const body of ["{", "{bad", "}", "", " \n"]) {
      await rejected(path, body, "invalid JSON");
    }
    for (const body of ["null", "[]", "[1,2]", "7", "0", `"text"`, `""`, "true", "false"]) {
      await rejected(path, body, "expected JSON object");
    }
  }
  for (const value of [[], [1], "", "text", 0, 7, false, true]) {
    await rejected("/ingress/matrix", JSON.stringify({ content: value }), "invalid payload shape");
    await rejected("/ingress/telegram", JSON.stringify({ message: value }), "invalid payload shape");
    for (const key of ["chat", "from"]) {
      for (const body of [{ [key]: value }, { message: null, [key]: value }, { message: { [key]: value } }]) {
        await rejected("/ingress/telegram", JSON.stringify(body), "invalid payload shape");
      }
    }
  }
} else if (mode === "compatible") {
  for (const body of [{}, { content: null }, { content: {} }]) {
    const result = await accepted("/ingress/matrix", { ...body, body: "fallback" });
    assert.equal(result.task.text, "fallback");
  }
  for (const body of [
    {}, { message: null }, { message: {} }, { chat: null, from: null },
    { message: { chat: null, from: null } },
    { message: null, chat: { id: 42 }, from: { id: 9 } },
    { message: {}, chat: "ignored", from: [] },
  ]) {
    const result = await accepted("/ingress/telegram", { ...body, text: "fallback" });
    assert.equal(result.task.text, "fallback");
    if (body.message === null && body.chat) {
      assert.equal(result.task.sender, "9");
      assert.equal(result.task.channel, "42");
    }
  }
  for (const path of routes.slice(0, 3)) {
    for (const alias of [{ taskId: "fixture-task" }, { task_id: "fixture-task" }, { text: "task: fixture-task" }, { text: "/run fixture-task" }]) {
      const body = path === "/ingress/matrix" && "text" in alias
        ? { content: { body: alias.text } }
        : path === "/ingress/telegram" ? { message: alias } : alias;
      const result = await accepted(path, body);
      assert.equal(result.task.id, "fixture-task", `${path} ${JSON.stringify(body)}`);
      assert.equal(result.task.adapterId, "fixture-adapter");
      assert.equal(result.task.freeform, false);
      assert.deepEqual(result.route, { kind: "fixture" });
    }
  }
  await accepted("/chat", { content: [], message: false, chat: 7, from: "extra" });
  for (const path of routes.slice(3)) await accepted(path, { message: 7, content: [], extra: true });
} else if (mode === "storage") {
  // A file in place of the state directory fails writes even when run as root.
  mkdirSync(dirname(STATE_DIR), { recursive: true });
  writeFileSync(STATE_DIR, "not a directory\n");
  const before = snapshot();
  for (const path of routes) {
    await assert.rejects(() => request(path, "POST", "{}"), (error: unknown) => {
      assert(error instanceof Error, path);
      assert.match(String(error), /EEXIST|ENOTDIR/, path);
      return true;
    }, path);
    assert.deepEqual(snapshot(), before, path);
  }
} else if (mode === "depth") {
  // The nesting ceiling, mirrored from src/gateway.ts; keep the two in step.
  const MAX_DEPTH = 64;
  // `levels` nested containers, the request body's own level being 1 — the
  // same count `exceedsJsonDepth` makes. `tag` rides along as an `event_id` so
  // the two error routes key each payload to its own draft: without it the
  // fingerprint falls back to a 200-char prefix of the serialization, which
  // 40 levels of nesting already fills. It is set on the outermost object
  // rather than in a wrapper, so it adds a key but not a level.
  function nested(levels: number, tag: string): Record<string, unknown> {
    let node: Record<string, unknown> = { message: tag };
    for (let i = 1; i < levels; i += 1) node = { n: node };
    node.event_id = tag;
    return node;
  }

  assert.equal(existsSync(STATE_DIR), false, "fixture must start without state");

  // At and below the ceiling every route takes its ordinary path, byte for
  // byte as before: this is the half of the contract that must not move.
  // From 2 up, because a depth-1 body is `{message: <string>}`, which
  // `telegramShape` rejects on its own terms — that is the pre-existing
  // "invalid payload shape" rule the `invalid` mode covers, not a depth one.
  for (const levels of [2, 8, 32, MAX_DEPTH - 1, MAX_DEPTH]) {
    for (const path of routes) await accepted(path, nested(levels, `depth-${levels}`));
  }
  const stored = snapshot();
  assert.notDeepEqual(stored, null, "accepted payloads must have been stored");

  async function tooDeep(path: string, body: string) {
    const label = `${path} (${Buffer.byteLength(body, "utf8")} bytes)`;
    const response = await request(path, "POST", body);
    assert.equal(response.status, 400, label);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/, label);
    assert.deepEqual(await response.json(), { ok: false, error: "JSON nesting too deep" }, label);
    // The refusal is upstream of the first write, so it costs the route nothing.
    assert.deepEqual(snapshot(), stored, `${label}: a refused request wrote state`);
  }

  for (const levels of [MAX_DEPTH + 1, 500]) {
    for (const path of routes) await tooDeep(path, JSON.stringify(nested(levels, `deep-${levels}`)));
  }

  // The plan's own reproduction: ~40,000 levels in 80,006 bytes — under the
  // 256 KB ceiling and under every other check here, which is exactly why it
  // reached `capBody`'s `JSON.stringify` and threw a `RangeError` into Bun's
  // HTML 500 page. The two assertions below are the premise of the regression:
  // if a future engine parses or serializes this cleanly, the reproducer is
  // stale and the number needs raising rather than the test quietly weakening.
  const crash = `{"d":${"[".repeat(40_000)}${"]".repeat(40_000)}}`;
  assert(Buffer.byteLength(crash, "utf8") < 256 * 1024, "the reproducer must stay under the byte ceiling");
  assert.doesNotThrow(() => JSON.parse(crash), "parsing was never the failure; serializing was");
  assert.throws(() => JSON.stringify(JSON.parse(crash)), RangeError, "the reproducer must still defeat JSON.stringify");
  for (const path of routes) await tooDeep(path, crash);

  // A deep payload that also satisfies a route's own shape check is still
  // refused: the depth gate runs before normalization, not instead of it.
  await tooDeep("/ingress/telegram", JSON.stringify({ message: { chat: { id: [nested(200, "shape")] }, from: { username: "deep" } } }));
  await tooDeep("/ingress/matrix", JSON.stringify({ content: { body: nested(200, "shape") } }));
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}
console.log(JSON.stringify({ ok: true, mode }));
