# Plan 028: Scope spawn records and tab matching to a repository (promoted residual of plan 018)

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 23f7471..HEAD -- src/cli.ts src/shared.ts tests/manager-*.test.ts`
> If `executeCleanup` / `cmdManagerSpawn --replace` already refuses a foreign `record.cwd` **and** scopes the tab match to a workspace, STOP and report.

## Status

- **Priority:** P1
- **Effort:** S–M (narrow fix in Steps 1–2); M if the complete key-by-repo-root migration is taken
- **Risk:** LOW–MED — refuse-foreign is behaviour-changing for operators who deliberately share one `spawns.json` across checkouts of the same tree; document it
- **Depends on:** `plans/018-idempotent-execute-cleanup.md` (shipped), `plans/012-verify-gateway-pid-identity.md` (shipped — same "destroy unrelated work" class)
- **Category:** bug / safety
- **Confidence:** HIGH (reproduced end to end 2026-10-02 against `23f7471`; transcript in "Evidence")
- **Planned at:** commit `23f7471`, 2026-10-02 (Run 6)

## Why this matters

Three facts compose into one destructive path.

1. **`spawns.json` is global and keyed by bare `taskId`.** `src/shared.ts:15` — `SPAWNS_FILE = ~/.local/state/herdr-harness/spawns.json`. `SpawnRecord` carries a `cwd` but nothing keys on it.
2. **The tab match is global.** `executeCleanup` runs `herdr tab list` with **no** `--cwd` (`src/cli.ts:578`), while the worktree listing right beside it *is* scoped — `herdr worktree list --cwd process.cwd()` (`src/cli.ts:580`). `taskTabIds` (`src/cli.ts:520`) matches on `t?.tab_id === record?.tabId || t?.label === label`, and `label` is `harness:<taskId>` (`src/cli.ts:359`) — not unique across repositories.
3. **`--replace` proceeds on a record from a different repo.** `cmdManagerSpawn` calls `executeCleanup(taskId, resolved, record, …)` without ever comparing `record.cwd` to `process.cwd()`.

So the two scoping mechanisms that exist disagree: worktrees are per-repo, tabs are global, and the record that ties them together is global too. An operator in repo B who follows the CLI's own recovery hint for "task already spawned" silently closes repo A's tab and removes repo A's worktree, reporting `ok: true`. Repo A's spawn is then untracked because the record was overwritten.

This corrects the framing in `plans/README.md`'s deferred list, which scoped the finding to "`--replace` with no record". The label arm fires with a *stale* record whose `tabId` no longer matches, and with **no record at all**. The common case — two repos that both define a task `alpha` — collides even with a live, correct record.

`README.md:90` documents `--replace` / `--cleanup` as the recovery path and never claims a repository scope. Read plainly, a record for `alpha` means *this repo's* `alpha`; today it means whichever repo wrote last. Nothing states the cross-repo teardown as intended — so this is not a re-litigation of a documented decision.

## Current state

```ts
// src/cli.ts:520 — global label match
return tabs
  .filter((t: any) => t?.tab_id === record?.tabId || t?.label === label)
  .map((t: any) => t.tab_id)

// src/cli.ts:578-580 — tab list unscoped; worktree list scoped
const tabsStep = runHerdr(herdr.bin, ["tab", "list"]);
const wtStep = runHerdr(herdr.bin, ["worktree", "list", "--cwd", process.cwd()]);

// src/cli.ts:704 — refusal only when record exists AND --replace is absent
if (record && !replace) { /* task already spawned */ }
// --replace falls through to executeCleanup with no cwd check
```

## Evidence

Reproduced 2026-10-02 at `23f7471`, isolated `HOME`, two scratch repos both defining task `alpha`, fake `herdr` on a restricted `PATH` whose `tab list` / `worktree list` report artifacts belonging to **repo A** while the operator's cwd is **repo B**.

**The false refusal** — repo B, which has never spawned anything:

```
$ cd repoB && harness manager spawn alpha --execute
  ok: false | error: task already spawned: alpha
  sees record from cwd: …/repoA
  hint: pass --replace to clean up and respawn …
```

**The destruction** — following the hint:

```
$ cd repoB && harness manager spawn alpha --execute --replace
  reported ok      : true
  cleanup.ok       : true
  closedTabs       : ['tab-FOREIGN']     <-- repo A's tab
  removedWorkspace : ws-A                <-- repo A's worktree
  # spawns.json afterwards: alpha -> { cwd: …/repoB, … }
```

With a *stale* record `{ tabId: "tab-GONE", workspaceId: "ws-OLD" }` the label arm still fires and closes `tab-FOREIGN`. With **no record at all**, `--replace` still reaches the label arm.

## Steps

STOP after Step 2 unless the maintainer asks for the complete key-by-repo-root migration.

### Step 1 — refuse a foreign record (kills the destructive half)

In `cmdManagerSpawn` (when `--replace` is set) and `cmdManagerCleanup`, if `record` exists and its `cwd` is not under `process.cwd()` (resolve both; treat missing/`""` `cwd` as foreign), print both paths and exit non-zero. Do **not** run any herdr command. Message must name both paths so the operator can `harness manager cleanup` from the right repo.

### Step 2 — scope the tab match to the workspace

Live `herdr tab list` rows carry `workspace_id` (observed shape `{"tab_id":"w18:t1","workspace_id":"w18",…}`) and `worktree list` rows carry `open_workspace_id`. Prefer:

```
t.workspace_id === (wtMatch?.open_workspace_id ?? record?.workspaceId)
```

Keep the `label` arm only as a fallback *within* that workspace. Do not drop the `tab_id === record?.tabId` arm.

### Step 3 (optional, complete) — key `spawns.json` by repo root

Namespace the record key (or the file) by a stable repo root. Needs a migration note or a documented "records from an older version are ignored" behaviour, since a silent key change orphans every live spawn's cleanup path. Do **not** take this step unless separately requested.

## Tests

Extend `tests/manager-*.test.ts` (or a new `tests/manager-spawn-scope.test.ts`) with a fake `herdr` and two scratch repos under an isolated `HOME`:

1. Repo B with a live record whose `cwd` is repo A → `spawn --execute` still refuses; `spawn --execute --replace` **refuses** without running `tab close` / `worktree remove`.
2. Same setup, `--cleanup` → refuses without herdr mutation.
3. Label collision with no record / stale `tabId` → foreign tab is **not** closed after Step 2.
4. Happy path in-repo `--replace` still closes the matching tab and removes the matching worktree (regression for 018).
5. Mutation-check: force the foreign-cwd gate to `true` and confirm test 1 fails.

## STOP conditions

- Step 1 alone is insufficient because the no-record / stale-record label arm still fires — do not ship Step 1 without Step 2.
- Changing the on-disk key format (Step 3) without a migration story — stop and record it rather than shipping a silent orphan.
- Touching release-please, herdr-desk, or live Herdr host state outside fixtures.

## Acceptance

- A foreign `record.cwd` never triggers herdr mutation from `--replace` or `--cleanup`.
- A label collision across workspaces never closes a foreign tab.
- In-repo `--replace` / `--cleanup` behaviour for 018's cases is unchanged.
- 185+ tests green; `bun run typecheck` exit 0.
