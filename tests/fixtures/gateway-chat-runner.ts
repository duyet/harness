import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spyOn } from "bun:test";

const [mode, home, cwd, fakeBin] = process.argv.slice(2);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);

function unexpected(name: string): never {
  throw new Error(`Unexpected side effect: ${name}`);
}

spyOn(Bun, "serve").mockImplementation(() => unexpected("Bun.serve"));
spyOn(globalThis, "fetch").mockImplementation(() => unexpected("fetch"));

const { STATE_DIR } = await import("../../src/shared.ts");
assert.equal(STATE_DIR, join(home, ".local", "state", "herdr-harness"));
const { handleGatewayRequest } = await import("../../src/gateway.ts");
const bind = { hostname: "127.0.0.1", port: 8787 };

// Mock adapter binaries live in fakeBin and append to MOCK_MARKER when run.
const marker = join(home, "adapter-marker.txt");
process.env.MOCK_MARKER = marker;
process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH}`;

async function postChat(body: Record<string, unknown>) {
  const response = await handleGatewayRequest(
    new Request("http://localhost/chat", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    bind,
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  return result;
}

if (mode === "stub") {
  const routed = await postChat({ text: "task: fixture-task" });
  assert.equal(routed.mode, "stub");
  assert.equal(routed.adapterId, "fixture-adapter");
  assert.equal(routed.task.adapterId, "fixture-adapter");
  assert.equal(
    routed.reply,
    "stub: routed task fixture-task → adapter fixture-adapter (fixture-chat). No LLM.",
  );
  assert.equal("execute" in routed, false);
  assert.equal("executeError" in routed, false);
  const freeform = await postChat({ text: "hello world" });
  assert.equal(freeform.mode, "stub");
  assert.equal(freeform.reply, "stub: freeform via fixture-adapter — hello world");
  const disabled = await postChat({ text: "task: fixture-task", execute: false });
  assert.equal(disabled.mode, "stub");
  // The adapter binary was resolvable on PATH but never spawned.
  assert.equal(existsSync(marker), false);
} else if (mode === "execute-field") {
  const routed = await postChat({ text: "task: fixture-task", execute: true });
  assert.equal(routed.mode, "executed");
  assert.equal(routed.adapterId, "fixture-adapter");
  assert.equal("executeError" in routed, false);
  assert.match(routed.reply, /^mock-adapter-reply:/);
  assert.match(routed.reply, /<task: fixture-task>/);
  assert.equal(routed.execute.command[0], "fixture-chat");
  assert.deepEqual(routed.execute.command.at(-1), "task: fixture-task");
  assert.equal(routed.execute.status, 0);
  assert.equal(routed.execute.timedOut, false);
  assert.equal(routed.execute.timeoutMs, 10_000);
  const stringFlag = await postChat({ text: "hi there", execute: "true" });
  assert.equal(stringFlag.mode, "executed");
  assert.match(stringFlag.reply, /<hi there>/);
  const full = await postChat({ text: "task: full-task", execute: true });
  assert.equal(full.mode, "executed");
  assert.deepEqual(full.execute.command, [
    "fixture-chat",
    "via-arg",
    "--model",
    "fixture-model",
    "--flag-a",
    "--flag-b",
    "task: full-task",
  ]);
  assert(existsSync(marker), "adapter binary should have run");
} else if (mode === "execute-env") {
  process.env.HARNESS_CHAT_EXECUTE = "1";
  const routed = await postChat({ text: "task: fixture-task" });
  assert.equal(routed.mode, "executed");
  assert.match(routed.reply, /^mock-adapter-reply:/);
  const freeform = await postChat({ text: "env hello" });
  assert.equal(freeform.mode, "executed");
  assert.match(freeform.reply, /<env hello>/);
  assert(existsSync(marker));
} else if (mode === "execute-missing") {
  const res = await postChat({ text: "task: ghost-task", execute: true });
  assert.equal(res.mode, "stub");
  assert.equal(
    res.reply,
    "stub: routed task ghost-task → adapter ghost-adapter (fixture-absent-bin). No LLM.",
  );
  assert.match(res.executeError, /spawn failed|ENOENT/i);
  assert.equal(res.execute.timedOut, false);
  assert.equal(existsSync(marker), false);
} else if (mode === "execute-nonzero") {
  const res = await postChat({ text: "task: fail-task", execute: true });
  assert.equal(res.mode, "stub");
  assert.equal(
    res.reply,
    "stub: routed task fail-task → adapter fail-adapter (fixture-fail). No LLM.",
  );
  assert.match(res.executeError, /exit 3/);
  assert.match(res.executeError, /fixture-adapter-failed/);
  assert.equal(res.execute.status, 3);
  assert(existsSync(marker), "failing adapter should still have run");
} else if (mode === "execute-timeout") {
  process.env.HARNESS_CHAT_TIMEOUT_MS = "300";
  const started = Date.now();
  const res = await postChat({ text: "task: hang-task", execute: true });
  const elapsed = Date.now() - started;
  assert.equal(res.mode, "stub");
  assert.match(res.executeError, /timed out after 300ms/);
  assert.equal(res.execute.timedOut, true);
  assert.equal(res.execute.timeoutMs, 300);
  assert(elapsed < 10_000, `timeout path took ${elapsed}ms`);
  assert(existsSync(marker), "hung adapter should have been spawned then killed");
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}
console.log(JSON.stringify({ ok: true, mode }));
