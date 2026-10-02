# Plan 011: Surface live spawns in `manager status` and hint recovery on partial spawn failures

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, remotes or actual Herdr/socket execution without separate authorization.
>
> **Drift check (first):** `git diff --stat b96a1ec..HEAD -- src/cli.ts src/shared.ts tests/manager-spawn-agent.test.ts`
> Compare changed code against the excerpts below. Plan 005's exit-status change and plan 006's spawn sequence are expected in this file and must not be reverted. STOP on unexplained drift.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW — additive JSON fields and new hints; existing envelope fields are untouched
- **Depends on:** `plans/001-isolated-test-baseline.md`, `plans/005-propagate-manager-exit-status.md`, `plans/006-spawn-tab-agent-cleanup.md`
- **Category:** dx
- **Confidence:** HIGH (static control-flow verification of `cmdManagerStatus` and the three mid-sequence failure branches)
- **Planned at:** commit `b96a1ec`, 2026-10-02

## Why this matters

Plan 006 added a three-step spawn sequence that can fail after the first step has already created a worktree. The failure is reported honestly and a partial record is written, but the operator is then told nothing about how to recover: two of the three failure branches carry no hint at all, and `harness manager status` — the natural first command to run — shows configuration only, never what is currently spawned. Finding outstanding worktrees and tabs means reading `~/.local/state/herdr-harness/spawns.json` by hand. Since cleanup closes tabs and removes worktrees, the record matters more than usual.

## Current state

`cmdManagerStatus` (`src/cli.ts:270-282`) reports config and nothing about spawns:

```ts
function cmdManagerStatus() {
  const { path: configPath, config } = loadConfig();
  printJson({
    ok: true,
    version: VERSION,
    configPath,
    name: config?.name ?? null,
    soul: config?.soul ?? null,
    defaultAdapter: config?.adapters?.default ?? config?.agent ?? null,
    adapters: config?.adapters?.routes ?? {},
    tasks: config?.tasks ?? [],
  });
}
```

The state it should be showing already exists and is already loaded elsewhere — `loadSpawns()` (`src/shared.ts:123-131`) backs the spawn refusal in `cmdManagerSpawn` (`src/cli.ts:520`) and `cmdManagerCleanup` (`src/cli.ts:676`).

Of the three mid-sequence failures, only the first is recoverable from the message:

```ts
// src/cli.ts:620-625 — has a hint
if (wtStep.status !== 0) {
  return finish(false, {
    error: "herdr worktree create failed",
    hint: "if a worktree/tab already exists for this task, re-run with --replace or `harness manager cleanup <taskId>` first",
  });
}
// src/cli.ts:641-642 — no hint, a worktree is already on disk
if (tabStep.status !== 0) {
  return finish(false, { error: "herdr tab create failed" });
}
// src/cli.ts:659-660 — no hint, a worktree and tab are already on disk
if (agentStep.status !== 0) {
  return finish(false, { error: "herdr agent start failed" });
}
```

The unparseable-id branches at `src/cli.ts:633-637` and `src/cli.ts:649-653` likewise leave created resources behind with no hint. `tests/manager-spawn-agent.test.ts:118-137` asserts the partial record is persisted "so cleanup can find the worktree" but never asserts what the operator is told to do next.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `bun --version` | supported Bun (audit: 1.4.2) |
| Prerequisite | `bun test` | all 72 existing cases pass |
| Focused gate | `bun test tests/manager-spawn-agent.test.ts` | all cases pass |
| Full gate | `bun test && git diff --check` | exit 0 |

No install or build. These tests are proposed, not already run. Fixtures live only in `dist/.test-tmp/`; the recording-`herdr` pattern already forbids real socket or worktree operations.

## Scope

**Only modify:** `src/cli.ts` (`cmdManagerStatus` output plus failure hints in `cmdManagerSpawn`), `tests/manager-spawn-agent.test.ts`, and this plan's row in `plans/README.md`.

**Out of scope:** automatic rollback of a failed spawn, changing the spawn or cleanup sequences, changing `spawns.json`'s schema or location, adding a `herdr` call, pruning old records automatically, gateway or chat code, dependencies, release-please, other repos, crons and remotes.

## Git workflow

No branch/worktree creation, commit, push or PR. Preserve unrelated work. Any later implementation or publication needs separate authorization.

## Steps

### Step 1: Report spawns in `manager status`

Load `loadSpawns()` in `cmdManagerStatus` and add two fields: `spawns`, an array of the stored records sorted by `at` (stable and diffable), and `spawnCount`. Keep every existing field exactly as it is, so current consumers and `tests/manager-spawn-agent.test.ts` continue to pass. When no state file exists, report `spawns: []` and `spawnCount: 0` rather than omitting the fields.

**Verify:** `bun test tests/manager-spawn-agent.test.ts` → unchanged and green.

### Step 2: Hint every mid-sequence failure

Add a `hint` to the `herdr tab create failed`, `herdr agent start failed`, and both unparseable-id branches, naming the exact recovery commands and what is already on disk. Follow the wording of the existing worktree-create hint. Also add a `recover` array of the literal commands (for example `harness manager cleanup <taskId> --execute` and `harness manager spawn <taskId> --replace`) so scripts can echo them; both fields are additive and the existing `ok:false`/`error` contract is unchanged.

Keep the recovery advice accurate per branch: after a failed tab create there is a worktree but no child tab; after a failed agent start there is a worktree and a tab. Do not claim cleanup is guaranteed to succeed.

**Verify:** `bun test tests/manager-spawn-agent.test.ts` → `fail-tab` and `fail-agent` cases assert the hint names cleanup and `--replace`.

### Step 3: Regression coverage

Extend `tests/manager-spawn-agent.test.ts` (do not create a parallel file; the fixture runner already supports these modes):

1. `manager status` with no `spawns.json` reports `spawns: []` and `spawnCount: 0`, with all pre-existing fields intact.
2. `manager status` after a successful `--execute` spawn reports exactly one record carrying `taskId`, `workspaceId`, `tabId` and `paneId`.
3. `manager status` after a successful cleanup reports zero records again, proving cleanup still deletes the record.
4. `fail-tab` and `fail-agent` envelopes each carry a `hint` and a `recover` array naming `harness manager cleanup`.
5. The `exists` (worktree create failure) branch keeps its original hint text, guarding against regression.

Keep asserting the herdr call sequence so no extra `herdr` invocation is introduced.

**Verify:** `bun test tests/manager-spawn-agent.test.ts` → all cases pass with the same recorded call sequences as before.

### Step 4: Full regression and boundary check

**Verify:** `bun test && git diff --check` → exit 0 (72 existing cases). `git diff -- src/cli.ts` changes only `cmdManagerStatus`'s output and the failure hints. `git status --short` → scoped changes only.

## Test plan

Extend the existing `tests/manager-spawn-agent.test.ts` using its `createFixture` harness and the recording `herdr` script, with `HERDR_BIN_PATH`/`HERDR_SOCKET` pointed at fixture-local placeholders and `PATH` restricted. Assert stdout JSON, exit status, the recorded herdr argv and the on-disk `spawns.json`. No live socket, worktree or agent may run.

## Done criteria

- [ ] Focused and full Bun suites exit 0.
- [ ] `manager status` lists current spawn records and a count, and returns empty arrays when there are none.
- [ ] Every mid-sequence spawn failure names its recovery commands.
- [ ] All existing `manager status` and spawn envelope fields are unchanged.
- [ ] No additional `herdr` call is made by either command.
- [ ] `git diff --check` passes; file scope respected; index row updated.

## STOP conditions

Stop if surfacing spawns would require a new schema or a new `herdr` query, if adding fields to `manager status` breaks an existing consumer, if the hints would claim recovery outcomes that cleanup cannot guarantee, if plan 006's behavior has changed materially, if out-of-scope changes appear necessary, or after two failed gate attempts.

## Maintenance notes

`spawns.json` only shrinks through a successful cleanup, so a task id whose tab was closed by hand will linger and keep the "already spawned" refusal honest but stale. If that becomes a problem, prefer an explicit prune command over automatic expiry, which would silently lose a worktree path. Deferred: automatic rollback of a failed spawn, and cross-referencing live Herdr state in `manager status`.
