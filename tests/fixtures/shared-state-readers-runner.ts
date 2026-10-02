import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnRecord } from "../../src/shared.ts";

const [mode, home, cwd] = process.argv.slice(2);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);

type Shared = typeof import("../../src/shared.ts");
const shared: Shared = await import("../../src/shared.ts");
const { STATE_DIR, STATE_FILE, SPAWNS_FILE, LAST_DELIVERY_FILE } = shared;
assert.equal(STATE_DIR, join(home, ".local", "state", "herdr-harness"));

const SHARED_URL = new URL("../../src/shared.ts", import.meta.url);
const MUTANTS = join(cwd, "..", "mutants");
mkdirSync(STATE_DIR, { recursive: true });

type Wrong = readonly [label: string, bytes: string];
type Mutation = readonly [label: string, from: string, to: string];

// Shapes that are *valid JSON* but the wrong document. A torn write cannot
// produce any of them (plan 019 makes every write atomic) — a hand-edited or
// otherwise corrupted file can, and operators do edit this directory by hand.
const NOT_A_DOCUMENT: Wrong[] = [
  ["empty array", "[]"],
  ["one-element array", '["x"]'],
  ["array of objects", '[{"taskId":"a"}]'],
  ["string", '"s"'],
  ["null", "null"],
  ["number", "42"],
  ["torn bytes", '{"spawns": {'],
];

const VALID_DELIVERY = {
  kind: "summary",
  at: "2026-10-02T00:00:00.000Z",
  summaryPath: "/tmp/last-summary.md",
  summaryJsonPath: "/tmp/last-summary.json",
  deliveryPath: "/tmp/last-delivery.json",
  bytes: 42,
  excerpt: "stub excerpt",
};

const RECORD: SpawnRecord = {
  taskId: "reader-task",
  adapterId: "fixture-adapter",
  at: "2026-10-02T00:00:00.000Z",
};

const PICK = { id: "reader-task", kind: "adapter", at: "2026-10-02T00:00:00.000Z" };

const FALLBACK = {
  state: { started: false },
  spawns: { spawns: {} },
  delivery: null,
} as const;

function write(path: string, bytes: string) {
  writeFileSync(path, bytes);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

let detail: Record<string, unknown>;

if (mode === "readers") {
  // Every case writes a wrong-shaped file, checks the reader answered its empty
  // fallback rather than adopting the shape, then makes the write that follows
  // a read — the step where an adopted shape does its damage.

  // loadSpawns: the record just written is silently lost when `spawns` is an
  // array, because `saveSpawn` assigns a named key onto it and
  // `JSON.stringify` of an array drops named properties. Nothing fails; the
  // next read simply cannot see the record, and the "task already spawned"
  // guard that shares this reader builds a second worktree instead.
  const spawnShapes: Wrong[] = [
    ...NOT_A_DOCUMENT,
    ["no spawns key", "{}"],
    ["array spawns", '{"spawns": []}'],
    ["array spawns holding a record", '{"spawns": [{"taskId":"a"}]}'],
    ["string spawns", '{"spawns": "s"}'],
    ["null spawns", '{"spawns": null}'],
    ["numeric spawns", '{"spawns": 7}'],
    ["spawns inside an array", '[{"spawns":{}}]'],
  ];
  for (const [label, bytes] of spawnShapes) {
    write(SPAWNS_FILE, bytes);
    assert.deepEqual(shared.loadSpawns(), FALLBACK.spawns, `loadSpawns on ${label}`);
    shared.saveSpawn(RECORD);
    // Re-read from disk, not through the reader: what matters is that the
    // bytes on disk still hold the record after the write that followed.
    const stored = readJson(SPAWNS_FILE) as { spawns?: unknown };
    assert.equal(typeof stored.spawns, "object", `${label}: spawns is not an object`);
    assert.equal(Array.isArray(stored.spawns), false, `${label}: spawns is an array`);
    assert.deepEqual(
      (stored.spawns as Record<string, unknown>)[RECORD.taskId],
      RECORD,
      `${label}: the write was lost`,
    );
    assert.deepEqual(shared.loadSpawns().spawns[RECORD.taskId], RECORD, `${label}: re-read`);
  }

  // loadState: the next writer spreads the loaded value, so an array becomes
  // `{ "0": …, "1": …, lastPicked: {…} }` and `started` / `sessionId` are
  // gone — `start --resume` then mints a fresh session id.
  for (const [label, bytes] of NOT_A_DOCUMENT) {
    write(STATE_FILE, bytes);
    assert.deepEqual(shared.loadState(), FALLBACK.state, `loadState on ${label}`);
    shared.saveState({ ...shared.loadState(), lastPicked: PICK });
    const stored = readJson(STATE_FILE) as Record<string, unknown>;
    assert.equal(Array.isArray(stored), false, `${label}: state stayed an array`);
    assert.deepEqual(stored.lastPicked, PICK, `${label}: the write was lost`);
    assert.equal("0" in stored, false, `${label}: array indices were persisted as keys`);
    assert.deepEqual(shared.loadState(), { started: false, lastPicked: PICK }, `${label}: re-read`);
  }
  // A legitimate state still loads, with every field the writer put there. The
  // table above has no `{}` row: an empty object is a legal state, and plan 016
  // made `lastPicked` optional so a file written before rotation still loads.
  write(STATE_FILE, JSON.stringify({ started: true, sessionId: "s-1", lastPicked: PICK }));
  assert.deepEqual(
    shared.loadState(),
    { started: true, sessionId: "s-1", lastPicked: PICK },
    "a real state must load",
  );

  // lastDelivery: `/chat` pickup interpolates `at` and `excerpt` straight into
  // the reply, so an array renders `function at()` (it inherits
  // `Array.prototype.at`) and a partial object renders `undefined`.
  const deliveryShapes: Wrong[] = [
    ...NOT_A_DOCUMENT,
    ["empty object", "{}"],
    ["wrong kind", '{"kind":"other"}'],
    ["missing excerpt", `{"kind":"summary","at":"${VALID_DELIVERY.at}"}`],
    ["excerpt not a string", JSON.stringify({ ...VALID_DELIVERY, excerpt: 7 })],
    ["bytes not a number", JSON.stringify({ ...VALID_DELIVERY, bytes: "42" })],
    ["bytes infinite", '{"kind":"summary","bytes":1e999,"excerpt":"x"}'],
  ];
  for (const [label, bytes] of deliveryShapes) {
    write(LAST_DELIVERY_FILE, bytes);
    assert.equal(shared.lastDelivery(), null, `lastDelivery on ${label}`);
  }
  // The control: the record the only writer produces still reads, whole, and
  // the reader does not delete what it read.
  write(LAST_DELIVERY_FILE, JSON.stringify(VALID_DELIVERY));
  assert.deepEqual(shared.lastDelivery(), VALID_DELIVERY, "a real delivery must load");
  assert.equal(existsSync(LAST_DELIVERY_FILE), true, "the reader must not delete what it read");

  detail = {
    spawnCases: spawnShapes.length,
    stateCases: NOT_A_DOCUMENT.length,
    deliveryCases: deliveryShapes.length,
  };
} else if (mode === "mutants") {
  // The guards are load-bearing: put each pre-031 body back into a copy of
  // `shared.ts` and show the exact failure the guard prevents comes back.
  mkdirSync(MUTANTS, { recursive: true });
  const source = readFileSync(SHARED_URL, "utf8");

  const MUTATIONS: Mutation[] = [
    [
      "loadSpawns",
      "isRecord(spawns) ? (spawns as Record<string, SpawnRecord>) : {}",
      "(spawns ?? {}) as Record<string, SpawnRecord>",
    ],
    [
      "loadState",
      "return isRecord(parsed) ? (parsed as State) : { started: false };",
      "return parsed as State;",
    ],
    [
      "lastDelivery",
      "return isLastDelivery(parsed) ? parsed : null;",
      "return parsed as LastDelivery | null;",
    ],
  ];

  for (const [label, from, to] of MUTATIONS) {
    assert(source.includes(from), `${label}: the guard this test removes is not in the source`);
    const path = join(MUTANTS, `${label}.ts`);
    writeFileSync(path, source.replace(from, to));
    // The writer is unmutated and calls its own module's reader, so importing
    // `saveSpawn` from the mutant *is* the real write path over a reader with
    // no guard — which is what plan 031 reproduces.
    const mutant = (await import(`file://${path}`)) as Shared;

    if (label === "loadSpawns") {
      write(SPAWNS_FILE, '{"spawns": []}');
      const read = mutant.loadSpawns();
      assert(Array.isArray(read.spawns), "the mutant still reads the array as a record-of-records");
      mutant.saveSpawn(RECORD);
      const stored = readJson(SPAWNS_FILE) as { spawns?: Record<string, unknown> };
      assert.equal(stored.spawns?.[RECORD.taskId], undefined, "the mutant lost the record it just wrote");
      assert.equal(mutant.loadSpawns().spawns[RECORD.taskId], undefined, "and cannot read it back");
    }

    if (label === "loadState") {
      write(STATE_FILE, '["not","a","state"]');
      const read = mutant.loadState();
      assert(Array.isArray(read), "the mutant still reads the array as a state");
      mutant.saveState({ ...read, lastPicked: PICK });
      const stored = readJson(STATE_FILE) as Record<string, unknown>;
      assert.equal("0" in stored, true, "the mutant persisted the array's indices as keys");
      assert.equal("started" in stored, false, "the mutant lost `started`");
    }

    if (label === "lastDelivery") {
      write(LAST_DELIVERY_FILE, "[]");
      const read = mutant.lastDelivery() as unknown as Record<string, unknown> | null;
      assert(Array.isArray(read), "the mutant still adopts the array as a delivery");
      // The two strings `/chat` pickup would put in its reply.
      assert.equal(typeof read!.at, "function", "the mutant's `at` is Array.prototype.at");
      assert.equal(read!.excerpt, undefined, "the mutant renders `undefined` into the reply");
    }
  }

  // And the shipped readers still refuse all three, from the same bytes.
  write(SPAWNS_FILE, '{"spawns": []}');
  assert.deepEqual(shared.loadSpawns(), FALLBACK.spawns, "shipped loadSpawns");
  write(STATE_FILE, '["not","a","state"]');
  assert.deepEqual(shared.loadState(), FALLBACK.state, "shipped loadState");
  write(LAST_DELIVERY_FILE, "[]");
  assert.equal(shared.lastDelivery(), null, "shipped lastDelivery");

  detail = { mutants: MUTATIONS.length };
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}

console.log(JSON.stringify({ ok: true, mode, detail }));