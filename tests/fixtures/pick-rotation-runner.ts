import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Type-only, so it is erased and does not pull shared.ts in ahead of the
// dynamic import below, which has to see the fixture's HOME.
import type { State } from "../../src/shared.ts";

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
  // entry written before `eventAt` existed. The payload is arbitrary JSON and
  // is written through as-is on purpose — the fixture is proving that `pick`
  // reads a cursor back without trusting it, so it must be able to plant one
  // that does not match the declared shape. The cast states that intent; it is
  // not a claim about what `pick` should accept.
  const planted = JSON.parse(payload ?? "null") as
    | (Pick<State, "lastPicked"> & Record<string, unknown>)
    | null;
  saveState({ ...loadState(), ...(planted ?? {}) });
  console.log(JSON.stringify({ ok: true, mode }));
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}