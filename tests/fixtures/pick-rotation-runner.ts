import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Seeds and inspects the two pieces of persisted state the pick rotation reads:
// the ingress queue (whose events carry the freeform cursor) and state.json's
// `lastPicked`. A runner rather than test-body writes because STATE_DIR has to
// resolve from the fixture HOME, and because a stale cursor is otherwise
// unreachable — the CLI only ever writes a live one.

const [mode, home, cwd, payload] = process.argv.slice(2);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);

const { STATE_DIR, INGRESS_QUEUE_FILE, loadState, saveState } = await import(
  "../../src/shared.ts"
);
assert.equal(STATE_DIR, join(home, ".local", "state", "herdr-harness"));

if (mode === "seed-queue") {
  // Written oldest-first: the order `persistIngress` appends in, and the order
  // the freeform tier walks.
  mkdirSync(STATE_DIR, { recursive: true });
  const events = JSON.parse(payload ?? "[]") as unknown[];
  writeFileSync(INGRESS_QUEUE_FILE, `${JSON.stringify(events, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, mode, queued: events.length }));
} else if (mode === "last-picked") {
  // Read-only: this mode must not create the state directory.
  console.log(JSON.stringify({ ok: true, mode, lastPicked: loadState().lastPicked ?? null }));
} else if (mode === "set-last-picked") {
  // Plants a cursor the CLI would never produce: a stale timestamp, or an
  // entry written before `eventAt` existed.
  const planted = JSON.parse(payload ?? "null") as { lastPicked?: unknown } | null;
  saveState({ ...loadState(), ...(planted ?? {}) });
  console.log(JSON.stringify({ ok: true, mode }));
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}