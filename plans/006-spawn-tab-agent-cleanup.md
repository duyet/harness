# Plan 006: Wire manager spawn child tab/agent and cleanup UX

> Follow-up implementation for the open remainder of GitHub issue #2 (not part
> of the original advisory top-5). Implemented directly on branch
> `harness/issue-2-spawn-tab`.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED — new Herdr mutations (tab create, agent start, tab close, worktree remove); all still gated behind `--execute` with dry-run default
- **Depends on:** `plans/001-isolated-test-baseline.md`, `plans/005-propagate-manager-exit-status.md`
- **Category:** feature / dx
- **Implemented:** 2026-09-22

## What changed

- `manager spawn <taskId> --execute` now runs the full sequence:
  `herdr worktree create --no-focus` → `herdr tab create --workspace <id> --cwd <worktree> --label harness:<taskId> --no-focus` → `herdr agent start harness:<taskId> --kind <kind> --pane <pane> [-- <model/flags>]` when the route kind is a supported Herdr agent kind, else `herdr pane run <pane> <kind> [via] [args]` (e.g. `anyr claude`).
- Each step's ids are parsed from the previous step's JSON envelope; a failed
  or unparseable later step yields `ok:false` + exit 1 (plan 005 semantics).
- Spawn metadata persists per taskId in `~/.local/state/herdr-harness/spawns.json`.
- `manager cleanup <taskId>` / `spawn --cleanup`: discovers live state via
  `herdr tab list` + `herdr worktree list --cwd`, closes matching tab(s), then
  `herdr worktree remove --workspace <id>` (`--force` opt-in). Deletes the record.
- `spawn --replace`: cleanup phase, then full respawn. A recorded spawn without
  `--replace` exits 1 with an actionable hint; a failed worktree create hints
  at `--replace`/`cleanup`.
- Dry-run (no `--execute`, or Herdr unusable) shows the full intended sequence
  with `<workspace-id>`/`<worktree-path>`/`<pane-id>` placeholders.

## Tests

`tests/fixtures/manager-spawn-runner.ts` extends the recording-mock pattern
(real spawnSync against a fixture `herdr` bun script; PATH restricted to the
fixture bin). `tests/manager-spawn-agent.test.ts` covers agent-start and
`pane run` fallbacks, mid-sequence failures, already-spawned refusal, cleanup
(populated/empty/--force/dry-run), the `--cleanup` alias and `--replace`.
`tests/manager-exit.test.ts` assertions updated for the 3-step sequence.
