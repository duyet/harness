import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [home, cwd] = process.argv.slice(2);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);

const {
  STATE_DIR,
  STATE_FILE,
  SPAWNS_FILE,
  writeFileAtomic,
  writeJsonAtomic,
  loadState,
  saveState,
  loadSpawns,
  saveSpawn,
  saveSpawns,
} = await import("../../src/shared.ts");
const { ingestErrorEvent, listIssueDrafts } = await import("../../src/issues.ts");

// A writer that died mid-write leaves a scratch file behind. The state directory
// is small and long-lived, so an orphan is a real (if quiet) defect — and one
// no reader would ever explain.
function orphans(): string[] {
  return existsSync(STATE_DIR) ? readdirSync(STATE_DIR).filter((f) => f.includes(".tmp")) : [];
}

// The documents below are read back off disk, so a caller says which field it
// is asserting on rather than treating the whole file as an object it may
// dereference. `unknown` stays the default so the structural `deepEqual` probes
// still compare the raw parse.
function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function orphanDrafts(): string[] {
  const dir = join(STATE_DIR, "issues");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.includes(".tmp")) : [];
}

const EVENT = {
  event_id: "atomic-draft-1",
  project: "harness",
  message: "TypeError: boom",
  level: "error",
};

// The writer contract on its own: the bytes on disk are the same document the
// bare writeFileSync produced, so this changes the write protocol and nothing
// else. The trailing newline is part of that contract — every one of these
// files was written that way before.
const probe = join(STATE_DIR, "probe.json");
// The helper replaces bytes at a path; making the directory is the caller's
// job, and every writer in src/ does it. A fresh fixture HOME has no state dir.
mkdirSync(STATE_DIR, { recursive: true });
writeJsonAtomic(probe, { a: 1, nested: { b: [2, 3] } });
assert.deepEqual(readJson(probe), { a: 1, nested: { b: [2, 3] } });
assert.equal(readFileSync(probe, "utf8").endsWith("}\n"), true, "JSON files keep their trailing newline");
assert.deepEqual(orphans(), []);

const text = join(STATE_DIR, "probe.md");
writeFileAtomic(text, "line one\nline two");
assert.equal(readFileSync(text, "utf8"), "line one\nline two");
assert.deepEqual(orphans(), []);

// A failed write must leave no orphan and must not cost the previous good file.
const missing = join(STATE_DIR, "no-such-dir", "x.json");
assert.throws(() => writeJsonAtomic(missing, { a: 1 }));
assert.equal(existsSync(missing), false);
assert.deepEqual(readJson(probe), { a: 1, nested: { b: [2, 3] } }, "an unrelated failure must not disturb a good file");
assert.deepEqual(orphans(), [], "a failed write left a scratch file behind");

// saveState: a bare writeFileSync to the final path before this plan.
saveState({ started: true, startedAt: "2026-10-02T00:00:00.000Z", sessionId: "sess-atomic" });
assert.equal(readJson<{ sessionId?: string }>(STATE_FILE).sessionId, "sess-atomic");
assert.deepEqual(orphans(), []);

// saveSpawns, via saveSpawn: a truncated spawns.json is the sharp end of this
// plan. `loadSpawns` answers an unparseable file with an empty map, and an
// empty map is what tells `manager spawn` the task was never spawned. The
// assertions below pin that reader behaviour as a characterization, and pin
// it next to the writer that now makes the state unreachable by crashing.
saveSpawn({ taskId: "atomic-task", at: "2026-10-02T00:00:00.000Z", tabId: "tab-1" });
assert.equal(loadSpawns().spawns["atomic-task"]?.tabId, "tab-1");
const goodSpawns = readFileSync(SPAWNS_FILE, "utf8");
writeFileSync(SPAWNS_FILE, goodSpawns.slice(0, Math.floor(goodSpawns.length / 2)));
assert.deepEqual(loadSpawns(), { spawns: {} }, "today's reader treats a torn file as no spawns at all");
assert.deepEqual(orphans(), []);
// A save over a torn file replaces it whole, so the harness recovers.
saveSpawn({ taskId: "atomic-task-2", at: "2026-10-02T00:00:01.000Z" });
assert.deepEqual(Object.keys(loadSpawns().spawns).sort(), ["atomic-task-2"]);
assert.deepEqual(orphans(), []);

const goodState = readFileSync(STATE_FILE, "utf8");
writeFileSync(STATE_FILE, goodState.slice(0, 20));
assert.deepEqual(loadState(), { started: false }, "today's reader treats a torn state file as not started");
saveState({ started: true, sessionId: "sess-recovered" });
assert.equal(loadState().sessionId, "sess-recovered");

// The issue draft, whose reader stands under plan 007's published-once guard:
// a torn draft reads as no draft, and "no draft" is exactly the state that
// guard reads as "not published yet".
const draft = ingestErrorEvent("sentry", EVENT);
assert.equal(readJson<{ fingerprint?: string }>(draft.path!).fingerprint, "atomic-draft-1");
assert.deepEqual(orphanDrafts(), []);
assert.equal(listIssueDrafts().length, 1);
const goodDraft = readFileSync(draft.path!, "utf8");
writeFileSync(draft.path!, goodDraft.slice(0, 40));
assert.equal(listIssueDrafts().length, 0, "today's reader drops a torn draft entirely");
const redraft = ingestErrorEvent("sentry", EVENT);
assert.equal(readJson<{ fingerprint?: string }>(redraft.path!).fingerprint, "atomic-draft-1");
assert.deepEqual(orphanDrafts(), []);

// saveSpawns is the shared path behind saveSpawn/deleteSpawn; assert it
// directly so a later refactor cannot quietly reintroduce a non-atomic write.
saveSpawns({ spawns: {} });
assert.deepEqual(readJson(SPAWNS_FILE), { spawns: {} });
assert.deepEqual(orphans(), []);

// Nothing but the two probes and the two state files, and no scratch file
// survived any path above.
assert.deepEqual(
  readdirSync(STATE_DIR).filter((f) => !f.includes(".tmp")).sort(),
  ["issues", "probe.json", "probe.md", "spawns.json", "state.json"],
);

console.log(JSON.stringify({ ok: true, mode: "atomic-state-writes" }));
