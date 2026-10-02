# Plan 018: Make `executeCleanup` idempotent so a failed tab-close cannot wedge a spawn

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 5fd3cf0..HEAD -- src/cli.ts tests/manager-*.test.ts tests/fixtures/manager-spawn-runner.ts`
> If `executeCleanup` already treats "already closed" / empty discovery as success for mutation steps, STOP and report.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW–MED — changes when cleanup reports `ok`; must not hide real discovery failures
- **Depends on:** `plans/006-spawn-tab-agent-cleanup.md`, `plans/013-bound-herdr-subprocesses.md` (shipped)
- **Category:** bug / dx
- **Confidence:** HIGH on the code path (reproduced 2026-10-02 against `5fd3cf0`); MED on how often real Herdr exits nonzero for an already-closed tab
- **Planned at:** commit `5fd3cf0`, 2026-10-02 (Run 4)

## Why this matters

`executeCleanup` pushes both discovery (`tab list`, `worktree list`) and mutation (`tab close`, `worktree remove`) into one `results` array and then requires `results.every((r) => r.status === 0)` before calling `deleteSpawn`. If the user (or a prior cleanup) already closed the tab, Herdr's `tab close` returns nonzero → `ok:false` → the spawn record stays forever → `manager spawn` refuses with "task already spawned" and `--replace` fails at "cleanup before re-spawn failed".

The desired end state is already true: no matching tab, workspace removed. The harness refuses to forget the record because one mutation step was a no-op failure.

## Current state

`src/cli.ts:510-577` (abridged):

```ts
function executeCleanup(...) {
  const results: HerdrStep[] = [];
  const tabsStep = runHerdr(herdr.bin, ["tab", "list"]);
  results.push(tabsStep);
  const wtStep = runHerdr(herdr.bin, ["worktree", "list", "--cwd", process.cwd()]);
  results.push(wtStep);
  // ... discover tabIds / workspaceId ...
  for (const tabId of tabIds) {
    const r = runHerdr(herdr.bin, ["tab", "close", tabId]);
    results.push(r);
    if (r.status === 0) closedTabs.push(tabId);
  }
  // ... worktree remove ...
  const ok = results.every((r) => r.status === 0);
  if (ok) deleteSpawn(taskId);
  return { ok, results, found, closedTabs, removedWorkspace, cleaned: ... };
}
```

`--replace` path depends on cleanup success around `src/cli.ts:652-654` (error string `cleanup before re-spawn failed`).

## Evidence

Reproduced 2026-10-02 at `5fd3cf0` with an isolated `HOME`, a fake `herdr` (`--version` ok + socket file present) that fails only `tab close`, and a seeded `spawns.json`:

```
cleanup: exit=1 ok=false mode=executed
  resultStatuses: [0, 0, 1, 0]   # list, list, close FAIL, remove OK
  closedTabs: []
  removedWorkspace: "w9"
  spawnStillPresent: true
  cleaned: true                  # end state reached, record kept

replace: exit=1 ok=false
  error: "cleanup before re-spawn failed"
  spawnStillPresent: true
```

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Prerequisite | `bun test` | 148 green |
| New gate | `bun test tests/manager-cleanup-idempotent.test.ts` (name flexible) | pass |
| Full gate | `bun test && git diff --check` | exit 0 |

Reuse the fake-herdr / `HERDR_BIN_PATH` / `HERDR_SOCKET` pattern from `tests/manager-herdr-timeout.test.ts` and `tests/fixtures/manager-spawn-runner.ts`.

## Scope

**Only modify:**
- `src/cli.ts` — `executeCleanup` (+ tiny helpers if needed); possibly the `--replace` error path messaging
- New or extended manager cleanup tests + fixture
- `plans/README.md` status row

**Out of scope:**
- Broad rewrite of spawn orchestration
- Changing Herdr's `tab close` semantics
- The separate deferred finding that `--replace` with no record matches tabs by label across repos (keep deferred unless you finish 018 early and the scoped label fix is trivial)
- release-please

## Steps

### Step 1: Split discovery vs mutation success

- Discovery failures (`tab list` / `worktree list` nonzero or unparseable) → `ok:false`, do **not** `deleteSpawn` (unsafe).
- Mutation: treat "nothing to close" and "close failed but tab no longer listed" / nonzero close when the tab id is already absent on a re-list as success for that step.
- Prefer: only push mutation failures that leave the resource **still present** into the `ok` calculation. Simplest robust rule: after mutations, re-list (or trust empty `tabIds` / null workspace) and set `ok` from "desired absence", then `deleteSpawn` when the desired end state holds.

### Step 2: Keep `cleaned` / result transcripts honest

Continue recording every Herdr step in `results` for debugging; do not require every historical status to be 0 for `ok`.

### Step 3: Regression

1. Fake herdr: close fails, remove ok → cleanup exits 0, spawn record deleted.
2. Discovery fails → cleanup exits 1, spawn record retained.
3. Happy path unchanged.
4. `--replace` after a "already closed" failure succeeds in re-spawning (with fake herdr create stubs as needed).

## Done criteria

- [ ] A failed `tab close` for an already-absent tab cannot permanently wedge `spawns.json`
- [ ] Discovery failures still refuse `deleteSpawn`
- [ ] Existing manager spawn/cleanup/timeout tests stay green
- [ ] `plans/README.md` row updated on execute

## STOP conditions

- Cannot distinguish "already gone" from "permission denied / wrong id" without a second list call and you are unwilling to add one — stop and report rather than treating all nonzero closes as success.
