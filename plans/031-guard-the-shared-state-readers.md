# Plan 031: Give the three `shared.ts` state readers the same shape guard (residual of plan 025)

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 23f7471..HEAD -- src/shared.ts tests/atomic-state-writes.test.ts tests/baseline.test.ts`
> If `loadSpawns` / `loadState` / `lastDelivery` already reject non-record shapes with their empty fallbacks, STOP and report.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW
- **Depends on:** `plans/025-answer-hostile-input-with-json-envelope.md` (shipped), `plans/019-atomic-state-file-writes.md` (shipped)
- **Category:** bug / data integrity
- **Confidence:** HIGH (reproduced 2026-10-02 against `23f7471`)
- **Planned at:** commit `23f7471`, 2026-10-02 (Run 6)

## Why this matters

Plan 025 hardened the readers it touched — `readJsonFile` takes the caller's guard, `loadIngressQueue` checks `Array.isArray`, `listIssueDrafts` reads through `readStoredDraft`. Its own status note says the pattern is *"the same check `lastDelivery` and `readStoredDraft` already do beside their own parse."* But all three readers that live in **`src/shared.ts`** kept their pre-025 ad-hoc fallbacks, and two of them have a consequence:

| Reader | Wrong-shaped file that **parses** | Result |
|---|---|---|
| `loadSpawns` (`shared.ts:171`) | `{"spawns": []}` | **the record just saved is silently lost** |
| `loadState` (`shared.ts:109`) | `["not","a","state"]` | next write corrupts the file's shape |
| `lastDelivery` (`shared.ts:211`) | `[]` / `{}` | `/chat` pickup renders `undefined` |

`loadSpawns` returns `parsed?.spawns ?? {}`, which accepts an *array*. `saveSpawn` then assigns onto it, and `JSON.stringify` of an array drops named properties — so `manager spawn --execute`, which has by this point already created a worktree, a tab and an agent, writes a record that vanishes on the next read. The "task already spawned" guard at `src/cli.ts:709` cannot fire and the next spawn creates a **second** worktree and tab for a task that is already live — the precise scenario plan 019's atomic-write comment names as the reason the file must not read as empty.

**Reachability, stated honestly:** all three need a hand-edited or corrupt state file. Plan 019 made every write atomic, so a torn write can no longer produce these shapes; this is not a crash-recovery gap. It is a robustness gap against a user editing `~/.local/state/herdr-harness/` by hand, which is a documented thing operators do to this tool. That is why this ranks fourth rather than higher, despite `loadSpawns` having a genuinely destructive failure mode.

## Current state

```ts
// shared.ts:171
function loadSpawns(): SpawnsState {
  ...
  const parsed = JSON.parse(readFileSync(SPAWNS_FILE, "utf8"));
  return { spawns: parsed?.spawns ?? {} };   // arrays pass
}

// shared.ts:109
function loadState(): State {
  ...
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;  // arrays pass
}

// shared.ts:211
function lastDelivery(): LastDelivery | null {
  ...
  if (parsed && typeof parsed === "object") return parsed as LastDelivery;  // arrays pass
}
```

## Evidence

```
before : { "spawns": [] }
after saveSpawn: { "spawns": [] }        <-- wrote; nothing persisted
re-read: undefined
'task already spawned' would fire?: false

stored state: ["not","a","state"]
after cmdPick saveState: { "0":"not", "1":"a", "2":"state", "lastPicked":{…} }
  # started / sessionId gone → start --resume mints a fresh id

stored last-delivery=[]  -> pickup: "last summary (function at() { [native code] }):\nundefined"
  # [] inherits Array.prototype.at
```

## Steps

1. Put the guard beside the parse — the shape 025 established. `readJsonFile` lives in `gateway.ts` and `shared.ts` cannot import it without inverting the dependency, so either promote a small shared reader taking the caller's `isValid` (025's already does) or give each of the three its own beside-the-parse check.
2. `loadSpawns` → require `isRecord(parsed?.spawns)` (else `{ spawns: {} }`).
3. `loadState` → require `isRecord(parsed)` (else `{ started: false }`).
4. `lastDelivery` → require a check that excludes arrays (else `null`).
5. Do **not** change the PID-file write strategy — 019's acceptance criterion explicitly exempts it.

## Tests

Table-driven over wrong shapes (`[]`, `["x"]`, `{}` where a record-of-records is required, `"s"`, `null`, `42`, torn bytes) asserting each reader returns its fallback and that a subsequent `saveSpawn` / `saveState` / pickup does not corrupt or lose the write. One mutation-check that removes the `isRecord` guard and confirms the `{"spawns":[]}` case fails again.

## STOP conditions

- Importing `gateway.ts` into `shared.ts` to reuse `readJsonFile` — dependency inversion; promote a shared helper instead or duplicate the three-line check.
- Reworking PID writes — out of scope per 019.
- Treating this as a substitute for 028 — a lost spawn record and a cross-repo teardown are independent; do not merge them.

## Acceptance

- Wrong-shaped state files never cause silent record loss or shape corruption on the next write.
- `/chat` pickup never renders `function at()` / `undefined` from an array-shaped delivery file.
- 185+ tests green; `bun run typecheck` exit 0.
