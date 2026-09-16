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
spyOn(globalThis, "fetch").mockImplementation(() => unexpected("fetch"));
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
    assert.equal(dirname(result.draft.path), ISSUES_DIR);
    assert.deepEqual(result.draft.raw, body);
    assert.deepEqual(readJson(result.draft.path), result.draft);
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
  assert.deepEqual(await status.json(), { ok: true, listening: true, version: VERSION, bind, lastEvent: null });
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
  assert.deepEqual((await (await request("/status")).json()).lastEvent, readJson(LAST_INGRESS_FILE));
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
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}
console.log(JSON.stringify({ ok: true, mode }));
