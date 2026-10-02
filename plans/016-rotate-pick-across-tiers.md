# Plan 016: Rotate `harness pick` across the issue and freeform tiers

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat cbc0592..HEAD -- src/cli.ts src/shared.ts tests/pick-delivery.test.ts`
> `cmdPick` and `PICK_RULES` are the load-bearing surface here. If the issue tier's ranking, the `lastPicked` shape, or the `id` strings have changed, re-read "Current state" before proceeding. A change to the `id` contract for existing tiers is a STOP condition.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED — `pick`'s output is a documented contract pinned by tests and the README; the fix must add rotation without changing the shape of what a caller receives
- **Depends on:** none (independent of 001–011)
- **Category:** bug
- **Confidence:** HIGH (reproduced 2026-10-02 against `cbc0592`; transcript in "Evidence")
- **Planned at:** commit `cbc0592`, 2026-10-02

## Why this matters

`harness pick` exists to answer "what should I work on next". Two of its three tiers cannot answer that. Both the issue tier and the freeform tier return the identical item on every invocation, forever, because `lastPicked` is *written* on every pick but *read* only for tasks.

For the issue tier this is severe. Issue drafts outrank everything unconditionally when any exist, so a single `fatal` Sentry draft permanently starves out every config task and every ingress event — and the operator has no way to clear it, because `issues` has only `list` and `ingest`: no `done`, no `dismiss`, no `rm` (`src/cli.ts:939-944`). A draft only leaves the pickable set by being published to GitHub (`src/issues.ts:282-287`), which is the wrong remedy for "I already fixed this locally".

This is the harness's core loop, and it is stuck.

## Current state

`lastPicked` is written on every pick, `src/cli.ts:1037-1041`:

```ts
const state = loadState();
saveState({
  ...state,
  lastPicked: { id: chosen.id, kind: chosen.kind, adapter: chosen.adapter, at: new Date().toISOString() },
});
```

but read only for tasks, `src/cli.ts:995-1014`:

```ts
} else if (tasks.length) {
  const lastId = prev.lastPicked?.kind === "task" ? prev.lastPicked.id : null;
  const idx = lastId ? tasks.findIndex((t) => t.id === lastId) : -1;
  const next =
    idx >= 0
      ? tasks[(idx + 1) % tasks.length]
      : (tasks.find((t) => t.worktree) ?? tasks[0]);
  ...
}
```

Note `prev.lastPicked?.kind === "task"` — the kind guard is what excludes the other two tiers from rotation entirely.

The issue tier takes the head of a deterministic ranking, `src/cli.ts:985-994`:

```ts
if (drafts.length) {
  const d = drafts[0];
  chosen = {
    id: `issue:${d.fingerprint}`,
    kind: "issue",
    adapter: defaultAdapter,
    severity: issueSeverity(d),
    reason: "priority: mock issue drafts by severity then recency (github-created drafts are skipped)",
    title: d.title,
  };
}
```

`rankIssueDrafts` (`src/issues.ts:330-337`) sorts by severity desc, then `createdAt` desc, then fingerprint. That is a **total, deterministic** order, so `drafts[0]` is the same draft on every run. Nothing in this branch consults `prev`.

The freeform tier has the same shape, `src/cli.ts:1016-1025`:

```ts
const free = [...queue].reverse().find((e) => e.freeform);
if (free) {
  chosen = {
    id: free.taskId || "freeform",
    ...
  };
}
```

`.reverse().find(...)` returns the newest freeform event unconditionally, and `id: free.taskId || "freeform"` records the literal string `"freeform"` for any untagged event — so even a recorded cursor would carry no information about *which* event was taken.

`lastPicked`'s type, `src/shared.ts:42`:

```ts
lastPicked?: { id: string; kind: string; adapter?: string; at: string };
```

The documented rules acknowledge the asymmetry, `src/cli.ts:957-964`:

```ts
const PICK_RULES = [
  "issue drafts first, then config tasks, then freeform ingress",
  "issues: only mock-draft is pickable work; github-created is never re-picked",
  "issues: higher severity level first (fatal > error > warning > info > other)",
  "issues: newer createdAt breaks severity ties",
  "tasks: rotate by list order after lastPicked; a cold start prefers tasks with a worktree stub",
  "freeform: most recent freeform ingress event wins",
];
```

Only the task rule mentions rotation.

## Evidence

Reproduced 2026-10-02 at `cbc0592` with an isolated `HOME`, a repo config declaring two tasks (`alpha`, `beta`), and two ingested mock drafts (`e-AAA` at `fatal`, `e-BBB` at `warning`):

```
--- pick #1 --- {"ok":true,"id":"issue:e-AAA","kind":"issue","severity":"fatal", ...}
--- pick #2 --- {"ok":true,"id":"issue:e-AAA","kind":"issue","severity":"fatal", ...}
--- pick #3 --- {"ok":true,"id":"issue:e-AAA","kind":"issue","severity":"fatal", ...}
```

Three invocations, one draft, every time. The `warning` draft is unreachable, both config tasks are starved, and every call overwrote `lastPicked` with the same value.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `bun --version` | supported Bun (audit: 1.4.2) |
| Prerequisite | `bun test` | all 104 existing cases pass |
| Prerequisite | `bun test tests/pick-delivery.test.ts` | passes unchanged |
| New regression gate | `bun test tests/pick-rotation.test.ts` | all cases pass |
| Full gate | `bun test && git diff --check` | exit 0 |

No install or build. Fixtures live only under `dist/.test-tmp/`.

## Suggested executor toolkit

- `tests/pick-delivery.test.ts` already covers task rotation and cold start; read its rotation cases before writing anything, and match their fixture style.
- `src/issues.ts:330-337` (`rankIssueDrafts`) is the ordering you must preserve — rotation moves the *starting point*, it does not reorder.
- `src/gateway.ts:116-128` (`trimQueue`) shows how this codebase writes a bounded ring; the freeform cursor must survive that trimming, which is the whole difficulty in that tier.

## Scope

**Only modify:**
- `src/cli.ts` — `cmdPick`'s issue and freeform branches, `PICK_RULES`
- `src/shared.ts` — the `State.lastPicked` type, only if Step 2 requires an added optional field
- `tests/pick-rotation.test.ts` (new)
- `tests/fixtures/pick-rotation-runner.ts` (new)
- The pick rules documented in the README
- This plan's row in `plans/README.md`

**Out of scope (do NOT touch, even though they look related):**
- `rankIssueDrafts` and `issueSeverity` (`src/issues.ts:308-337`) — the ranking is correct; only the starting point changes
- The task tier's existing rotation and cold-start logic at `src/cli.ts:995-1014` — it already works and is covered by tests
- The `id` string formats: `issue:<fingerprint>`, a task id, and the freeform id must keep their current shapes
- The `kind` values (`"issue" | "task" | "freeform"`) and the `chosen` object shape, which `tests/pick-delivery.test.ts:136-166` pins
- `severity`, `title` and `reason` fields, and `ok:false` / "nothing to pick" behavior
- Issue lifecycle commands (`issues done`, `issues rm`) — a valuable follow-up recorded in `plans/README.md`, but new product surface, not this bug
- Plan 007's published-once semantics, plan 015's bounds, and everything in `src/gateway.ts`

## Git workflow

No branch/worktree creation, commit, push or PR. Preserve unrelated work. Any later implementation needs separate authorization.

## Steps

### Step 1: Rotate the issue tier using the existing `lastPicked` cursor

Mirror the task tier's mechanism. When `prev.lastPicked?.kind === "issue"`, locate that fingerprint in the already-ranked `drafts` array and take the **next** entry, wrapping to the head:

```
idx = drafts.findIndex(d => `issue:${d.fingerprint}` === prev.lastPicked.id)
next = drafts[(idx + 1) % drafts.length]
```

When there is no recorded issue pick (cold start), keep today's behavior — `drafts[0]`, i.e. the highest severity, newest first. If the recorded fingerprint is no longer present (published, evicted by plan 015, or hand-deleted), treat it as a cold start rather than computing a nonsense index. That fallback is what keeps a stale `lastPicked` from permanently skipping an entry.

Severity ordering must still dominate within a pick: this change chooses *where the rotation starts*, it does not reorder the ranking. A `fatal` draft still outranks a `warning` draft when both are first in the rotation.

**Verify:** three consecutive picks over two drafts return `e-AAA`, `e-BBB`, `e-AAA`.

### Step 2: Give the freeform tier a usable cursor

This tier needs a decision the other two did not, because the ingress queue is a **bounded ring** (`src/gateway.ts:116-128`, 50 events / 2 MB) and positions in it are not stable — the oldest events are dropped as new ones arrive.

Do **not** rotate by index into the queue; an index silently changes meaning when the ring trims. Instead key the cursor on something stable. Recommended approach:

- Record a cursor for the freeform tier that identifies the taken event by its `at` timestamp, which is unique per event in practice and is already persisted on every queue entry.
- On the next pick, locate that `at` in the current queue and advance to the next freeform entry after it, wrapping.
- If the recorded timestamp is absent (never picked, or its event has aged out of the ring), fall back to the newest freeform event — today's behavior.

Add whatever optional field this needs to `State.lastPicked` (`src/shared.ts:42`); it must be **optional** so existing `state.json` files continue to load, and it must not change the existing `id` field.

Note in a comment that `id: free.taskId || "freeform"` cannot serve as the cursor: for any untagged event it records the literal `"freeform"`, which identifies nothing.

**Verify:** three consecutive picks over three freeform events return three distinct events, and a fourth returns to the first.

### Step 3: Update `PICK_RULES` and the README

`PICK_RULES` is printed in `pick --json` output and documents the ordering contract. Add rotation rules for the issue and freeform tiers alongside the existing task rule so the array stops under-describing the behavior:

- issues: rotate through ranked mock drafts after `lastPicked`; cold start takes the highest severity
- freeform: rotate through freeform ingress events after `lastPicked`; falls back to the newest when the recorded event has aged out

Update the matching bullet list in the README's pick section.

**Verify:** `pick --json` output contains the new rules and the `rules` array is non-empty and consistent with the code.

### Step 4: Regression coverage

Create `tests/pick-rotation.test.ts` and `tests/fixtures/pick-rotation-runner.ts` following `tests/pick-delivery.test.ts`. Cases:

1. Characterization: cold start with issues returns the highest-severity, newest draft — unchanged from today.
2. Issue rotation: two drafts of differing severity return `fatal`, then `warning`, then `fatal` again; severity ordering is preserved at each position.
3. Issue rotation survives a disappearing draft: pick, publish or delete the last-picked draft, pick again — no crash, no skipped entry, no `-1` index artifact.
4. `lastPicked` from a different kind (a task pick followed by an issue pick) does not confuse the issue cursor.
5. Freeform rotation: three freeform events rotate distinctly and wrap.
6. Freeform fallback: a `lastPicked` whose timestamp is no longer in the queue yields the newest event, not a crash.
7. Characterization: task rotation and cold start still behave exactly as `tests/pick-delivery.test.ts` asserts — **that suite must pass unmodified**.
8. The empty case still prints `{ ok: false, error: "nothing to pick", rules: [...] }` and exits 1.

**Verify:** `bun test tests/pick-rotation.test.ts tests/pick-delivery.test.ts` → both pass.

### Step 5: Full regression and boundary check

**Verify:** `bun test && git diff --check` → exit 0. `git diff -- src/cli.ts` touches only `cmdPick`'s issue/freeform branches and `PICK_RULES`. `git status --short` → scoped changes only.

## Test plan

Add `tests/pick-rotation.test.ts` and `tests/fixtures/pick-rotation-runner.ts` in the established isolated-fixture style: temporary `HOME` under `dist/.test-tmp/`, repo-local `.herdr-harness.json` fixture, drafts written through `issues ingest`, ingress events written through the gateway or directly into the queue file. Assert the `id` and `kind` of consecutive picks, and assert exit status on the empty case.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun test` exits 0; `tests/pick-delivery.test.ts` passes **unmodified**
- [ ] `bun test tests/pick-rotation.test.ts` passes
- [ ] Consecutive `harness pick` runs return distinct items when more than one exists in the issue tier
- [ ] Consecutive `harness pick` runs return distinct items when more than one freeform event exists
- [ ] A cold start still returns the highest-severity, newest draft
- [ ] Severity ordering is unchanged within each rotation position
- [ ] A stale or missing `lastPicked` falls back safely instead of crashing or skipping
- [ ] The `id`, `kind`, `severity`, `title` and `reason` shapes are unchanged
- [ ] `PICK_RULES` and the README describe the rotation that the code now implements
- [ ] `git diff --check` passes; file scope respected; `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Rotation cannot be added without changing the `id`, `kind` or `reason` contract that existing callers and tests depend on — that is a product decision, not a refactor; report instead of breaking it.
- A stable freeform cursor cannot be derived from fields already on the queue entries — adding a new field to the persisted ingress event is a separate change to `src/gateway.ts` and out of scope here.
- Implementing rotation for one tier would require changing the other tiers' behavior.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **What a reviewer should scrutinize:** the stale-cursor fallback in both tiers. The dangerous failure mode is a cursor that never matches, which silently makes the rotation skip or repeat an entry forever — the same class of bug this plan fixes. Cases 3, 4 and 6 exist to pin it.
- Rotation makes `pick` stateful in a way it was not before for two tiers. Any new caller that runs `pick` in a loop will now advance through the queue, which is the intended behavior but is a visible change for anything that expected a stable top item.
- `lastPicked` gains at most one optional field. `loadState` (`src/shared.ts:102-109`) casts parsed JSON without validation, so a `state.json` written before this change simply lacks the field — read it as possibly-absent, and treat any unexpected value as "no cursor".
- **Natural follow-up, deliberately out of scope:** the issue tier rotates but a draft still never *leaves* the queue on its own. A `harness issues done|rm` subcommand (and a third `status` value in the `IssueDraft` union at `src/issues.ts:16`) would let an operator retire a draft permanently. That is new product surface, interacts with plan 007's idempotency (a "dismissed" state must survive a replayed upstream event rather than being reset to `mock-draft`), and is recorded in `plans/README.md` as the top direction item rather than bundled into this bug fix.
