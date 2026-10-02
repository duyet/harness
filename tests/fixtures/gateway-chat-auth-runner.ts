import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spyOn } from "bun:test";

// Plan 008: /chat execute is default-deny on the route kind, refuses a
// non-loopback bind, and refuses a browser Origin that is not allowlisted.
// Mock adapter binaries in fakeBin append to MOCK_MARKER when they run, so a
// missing marker file proves nothing was spawned.

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

const marker = join(home, "adapter-marker.txt");
process.env.MOCK_MARKER = marker;
process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH}`;

const LOOPBACK = { hostname: "127.0.0.1", port: 8787 };
const REMOTE = { hostname: "0.0.0.0", port: 8787 };

type PostOptions = {
  bind?: { hostname: string; port: number };
  origin?: string;
  // A browser cannot send application/json cross-origin without a preflight.
  contentType?: string;
};

async function postChat(body: Record<string, unknown>, opts: PostOptions = {}) {
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "application/json",
  };
  if (opts.origin !== undefined) headers.origin = opts.origin;
  const response = await handleGatewayRequest(
    new Request("http://localhost/chat", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    opts.bind ?? LOOPBACK,
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  return result as {
    mode: string;
    reply: string;
    adapterId: string;
    execute?: { command: string[]; status: number | null; timedOut: boolean };
    executeError?: string;
  };
}

// Nothing was spawned and nothing ran: the stub shape is untouched.
function assertRefused(
  res: { mode: string; reply: string; executeError?: string },
  expectedReply: string,
) {
  assert.equal(res.mode, "stub");
  assert.equal(res.reply, expectedReply);
  assert.equal("execute" in res, false, "refusals must not claim an invoke");
  assert(res.executeError, "refusal must carry executeError");
  assert.equal(existsSync(marker), false, "a denied request must not spawn");
}

const DENIED_REPLY =
  "stub: routed task denied-task → adapter denied-adapter (fixture-secret-bin). No LLM.";

if (mode === "allowlisted-kind") {
  // `claude` is a built-in non-interactive kind, so it runs without config help.
  const res = await postChat({ text: "task: allow-task", execute: true });
  assert.equal(res.mode, "executed");
  assert.equal("executeError" in res, false);
  assert.equal(res.execute?.command[0], "claude");
  assert.deepEqual(res.execute?.command, ["claude", "-p", "task: allow-task"]);
  assert.equal(res.execute?.status, 0);
  assert(existsSync(marker), "allowlisted kind should have been spawned");
} else if (mode === "denied-kind") {
  // fixture-secret-bin exists on PATH but is neither built-in nor configured.
  const res = await postChat({ text: "task: denied-task", execute: true });
  assertRefused(res, DENIED_REPLY);
  assert.match(res.executeError!, /fixture-secret-bin/);
  assert.match(res.executeError!, /adapters\.chat\.executeKinds/);
  assert.match(res.executeError!, /claude, codex, gemini, grok, opencode/);
} else if (mode === "config-kind") {
  // fixture-extra-kind is allowlisted only through adapters.chat.executeKinds.
  const res = await postChat({ text: "task: extra-task", execute: true });
  assert.equal(res.mode, "executed");
  assert.deepEqual(res.execute?.command, ["fixture-extra-kind", "task: extra-task"]);
  assert(existsSync(marker), "config-allowlisted kind should have run");
} else if (mode === "env-not-override") {
  // HARNESS_CHAT_EXECUTE opts into execution, never into a denied kind.
  process.env.HARNESS_CHAT_EXECUTE = "1";
  const res = await postChat({ text: "task: denied-task" });
  assertRefused(res, DENIED_REPLY);
  assert.match(res.executeError!, /adapters\.chat\.executeKinds/);
} else if (mode === "remote-bind") {
  const res = await postChat({ text: "task: allow-task", execute: true }, { bind: REMOTE });
  assertRefused(res, "stub: routed task allow-task → adapter allow-adapter (claude). No LLM.");
  assert.match(res.executeError!, /0\.0\.0\.0/);
  assert.match(res.executeError!, /HARNESS_CHAT_ALLOW_REMOTE/);
  assert.match(res.executeError!, /HARNESS_GATEWAY_HOST/);
  assert.match(res.executeError!, /unauthenticated/i);

  process.env.HARNESS_CHAT_ALLOW_REMOTE = "1";
  const opted = await postChat({ text: "task: allow-task", execute: true }, { bind: REMOTE });
  assert.equal(opted.mode, "executed");
  assert(existsSync(marker), "HARNESS_CHAT_ALLOW_REMOTE=1 re-enables remote execute");
} else if (mode === "origin") {
  // The cross-origin shape from the plan: CORS-simple text/plain, no preflight.
  const foreign = await postChat(
    { text: "task: allow-task", execute: true },
    { origin: "https://evil.example", contentType: "text/plain" },
  );
  assertRefused(foreign, "stub: routed task allow-task → adapter allow-adapter (claude). No LLM.");
  assert.match(foreign.executeError!, /https:\/\/evil\.example/);
  assert.match(foreign.executeError!, /HARNESS_CHAT_ALLOW_ORIGIN/);
  assert.match(foreign.executeError!, /unauthenticated/i);

  process.env.HARNESS_CHAT_ALLOW_ORIGIN = "https://other.example, https://evil.example";
  const allowed = await postChat(
    { text: "task: allow-task", execute: true },
    { origin: "https://evil.example", contentType: "text/plain" },
  );
  assert.equal(allowed.mode, "executed");
  assert(existsSync(marker), "an allowlisted Origin may execute");

  delete process.env.HARNESS_CHAT_ALLOW_ORIGIN;
  const noOrigin = await postChat({ text: "task: allow-task", execute: true });
  assert.equal(noOrigin.mode, "executed");
} else if (mode === "stub-modes") {
  // Plain stub (no `execute`) is unaffected by every bind/Origin combination.
  const binds = [LOOPBACK, REMOTE];
  const origins = [undefined, "https://evil.example"];
  for (const bind of binds) {
    for (const origin of origins) {
      const res = await postChat({ text: "task: allow-task" }, { bind, origin });
      assert.equal(res.mode, "stub");
      assert.equal(res.reply, "stub: routed task allow-task → adapter allow-adapter (claude). No LLM.");
      assert.equal("execute" in res, false);
      assert.equal("executeError" in res, false);
    }
  }
  const freeform = await postChat({ text: "hello there" }, { bind: REMOTE });
  assert.equal(freeform.mode, "stub");
  assert.equal(freeform.reply, "stub: freeform via claude — hello there");
  assert.equal(existsSync(marker), false);
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}
console.log(JSON.stringify({ ok: true, mode }));