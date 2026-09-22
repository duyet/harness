import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spyOn } from "bun:test";

const [mode, home, cwd] = process.argv.slice(2);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);

function unexpected(name: string): never {
  throw new Error(`Unexpected side effect: ${name}`);
}

spyOn(Bun, "serve").mockImplementation(() => unexpected("Bun.serve"));
spyOn(globalThis, "fetch").mockImplementation(() => unexpected("fetch"));

const { STATE_DIR, LAST_SUMMARY_FILE } = await import("../../src/shared.ts");
assert.equal(STATE_DIR, join(home, ".local", "state", "herdr-harness"));
const { handleGatewayRequest } = await import("../../src/gateway.ts");
const bind = { hostname: "127.0.0.1", port: 8787 };

async function postChat(body: Record<string, unknown>, query = "") {
  const response = await handleGatewayRequest(
    new Request(`http://localhost/chat${query}`, {
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

if (mode === "pickup") {
  assert.equal(existsSync(LAST_SUMMARY_FILE), true, "test must deliver a summary first");
  // Literal "/summary" text picks up the delivered report in the stub reply.
  const slash = await postChat({ text: "/summary" });
  assert.equal(slash.mode, "stub");
  assert.equal(slash.lastSummary.path, LAST_SUMMARY_FILE);
  assert.match(slash.lastSummary.excerpt, /harness daily summary/);
  assert.match(slash.reply, /last summary \(/);
  assert.match(slash.reply, /harness daily summary/);
  // Body flag works on any text.
  const flagged = await postChat({ text: "hello there", pickup: true });
  assert.equal(flagged.mode, "stub");
  assert.equal(flagged.lastSummary.path, LAST_SUMMARY_FILE);
  assert.match(flagged.reply, /harness daily summary/);
  // Query flag works too.
  const queried = await postChat({ text: "hi" }, "?pickup=true");
  assert.equal(queried.mode, "stub");
  assert.equal(queried.lastSummary.path, LAST_SUMMARY_FILE);
  // Default path is unchanged: no pickup field, plain stub reply.
  const plain = await postChat({ text: "hello world" });
  assert.equal(plain.mode, "stub");
  assert.equal("lastSummary" in plain, false);
  assert.equal(plain.reply, "stub: freeform via fixture-adapter — hello world");
} else if (mode === "pickup-empty") {
  // Nothing delivered yet: the field is present but null, reply untouched.
  assert.equal(existsSync(LAST_SUMMARY_FILE), false);
  const res = await postChat({ text: "/summary" });
  assert.equal(res.mode, "stub");
  assert.equal(res.lastSummary, null);
  assert.equal(res.reply, "stub: freeform via fixture-adapter — /summary");
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}
console.log(JSON.stringify({ ok: true, mode }));
