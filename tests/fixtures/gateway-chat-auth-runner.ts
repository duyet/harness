import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spyOn } from "bun:test";

// Plan 008: /chat execute is default-deny on the route kind, refuses a
// non-loopback bind, and refuses a browser Origin that is not allowlisted.
// Plan 027: /chat summary pickup is held to the same bind check, because it
// returns stored operator state the caller did not send.
// Mock adapter binaries in fakeBin append to MOCK_MARKER when they run, so a
// missing marker file proves nothing was spawned.

const [mode, home, cwd, fakeBin] = process.argv.slice(2);
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

const { STATE_DIR, LAST_DELIVERY_FILE } = await import("../../src/shared.ts");
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
    lastSummary?: { at: string; excerpt: string } | null;
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
} else if (mode === "pickup") {
  // Plan 027. A stub reply echoes the caller's own text and stays ungated
  // (README, accepted decision), but pickup returns stored operator state the
  // caller never sent — so it is held to the execute gate's bind check.
  const AT = "2026-10-02T13:02:37.680Z";
  const EXCERPT = "# fixture daily summary\noperator-only-issue-draft-fingerprint";
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    LAST_DELIVERY_FILE,
    JSON.stringify({
      kind: "summary",
      at: AT,
      summaryPath: join(home, "last-summary.md"),
      summaryJsonPath: join(home, "last-summary.json"),
      deliveryPath: join(home, "last-delivery.json"),
      bytes: EXCERPT.length,
      excerpt: EXCERPT,
    }),
  );
  const stored = { at: AT, excerpt: EXCERPT };
  const STUB = "stub: freeform via claude — hello there";

  // 1. Loopback is the default and must not regress: all three pickup triggers
  // still return the stored excerpt.
  const loop = await postChat({ text: "hello there", pickup: true }, { bind: LOOPBACK });
  assert.equal(loop.mode, "stub");
  assert.deepEqual(loop.lastSummary, stored);
  assert(loop.reply.includes(EXCERPT), "loopback pickup appends the excerpt");
  assert(loop.reply.startsWith(STUB), "the stub prefix is kept ahead of the excerpt");

  // Pickup not requested at all: the field is absent, not null-filled.
  const loopNoPickup = await postChat({ text: "hello there" }, { bind: LOOPBACK });
  assert.equal(loopNoPickup.mode, "stub");
  assert.equal(loopNoPickup.reply, STUB);
  assert.equal("lastSummary" in loopNoPickup, false, "unrequested pickup adds no field");

  // The literal `/summary` text is the third trigger.
  const loopSlash = await postChat({ text: "/summary" }, { bind: LOOPBACK });
  assert.deepEqual(loopSlash.lastSummary, stored, "the /summary text trigger still works");

  // 2. A non-loopback bind with no opt-in returns the plain stub: no
  // `lastSummary` key at all, and the excerpt nowhere in the reply.
  const remote = await postChat({ text: "hello there", pickup: true }, { bind: REMOTE });
  assert.equal(remote.mode, "stub");
  assert.equal(remote.reply, STUB, "a refused-pickup reply is byte-identical to the stub");
  assert.equal("lastSummary" in remote, false, "pickup must not return stored state");
  assert.equal(remote.reply.includes(EXCERPT), false, "the excerpt must not be appended");
  assert.equal(remote.reply.includes("last summary"), false, "no excerpt header either");

  // The `/summary` text trigger is gated the same way as the flag.
  const remoteSlash = await postChat({ text: "/summary" }, { bind: REMOTE });
  assert.equal("lastSummary" in remoteSlash, false, "the /summary trigger is gated too");
  assert.equal(remoteSlash.reply.includes(EXCERPT), false);

  // 3. The headline: the request the execute gate refuses must not be handed the
  // report in the same response, on the very bind the refusal names.
  const refused = await postChat(
    { text: "task: allow-task", execute: true, pickup: true },
    { bind: REMOTE },
  );
  assert.equal(refused.mode, "stub");
  assert.match(refused.executeError!, /not a loopback address/);
  assert.match(refused.executeError!, /unauthenticated/i);
  assert.equal("lastSummary" in refused, false, "a gate-refused reply carries no stored state");
  assert.equal(refused.reply.includes(EXCERPT), false);

  // 4. HARNESS_CHAT_ALLOW_REMOTE=1 is the same deliberate opt-in execute has.
  process.env.HARNESS_CHAT_ALLOW_REMOTE = "1";
  const opted = await postChat({ text: "hello there", pickup: true }, { bind: REMOTE });
  assert.deepEqual(opted.lastSummary, stored, "the remote opt-in keeps pickup working");
  assert(opted.reply.includes(EXCERPT));
  delete process.env.HARNESS_CHAT_ALLOW_REMOTE;

  // 5. The chat page is served on any bind and never asks for pickup.
  for (const bind of [LOOPBACK, REMOTE]) {
    const page = await handleGatewayRequest(new Request("http://localhost/chat"), bind);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.equal(html.includes("pickup"), false, "the chat page does not request pickup");
  }
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}
console.log(JSON.stringify({ ok: true, mode }));