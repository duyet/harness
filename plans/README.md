# Harness improvement plans

Three advisory runs. Plans 001-006 are from commit `b17bb04` (2026-09-16 / Asia/Saigon 2026-09-17) via **anyr claude --model stealth/union-alpha** + `/improve` (non-interactive default: top 5 by leverage). Plans 007-011 are a focused re-review at commit `b96a1ec` (2026-10-02), targeting the manager/gateway/issues/chat surface and the features added after 006. Plans 012-016 are a fresh post-011 review at commit `cbc0592` (2026-10-02), run against the surfaces that changed in 007-011 (chat execute gating, idempotent ingest, `gh` timeouts, ingress bounds, manager spawn visibility).

**Hard rules for executors:** these plans are not authorization to implement. Execute only when separately requested. Source was not modified by the advisory run. Leave release-please alone. No remotes/push. Do not touch herdr-desk.

## Leverage table (vetted findings → plans)

### Run 1 — commit `b17bb04`, 2026-09-16

| # | Finding | Category | Impact | Effort | Risk | Confidence | Plan |
|---|---------|----------|--------|--------|------|------------|------|
| 1 | No automated test baseline; subsequent fixes lack a hermetic regression gate | tests / dx | High | M | LOW | HIGH | [001](001-isolated-test-baseline.md) |
| 2 | Issue-draft paths incorporate unvalidated event IDs (path separators / `..`) | security | High | S | MED | HIGH | [002](002-contain-issue-draft-paths.md) |
| 3 | Background gateway `chdir`s to plugin checkout; loses caller repo config context | bug | High | S | LOW | HIGH | [003](003-preserve-gateway-repo-context.md) |
| 4 | Gateway POST routes: malformed JSON → HTTP 500; non-object JSON poorly handled | bug / tests | Med-High | S | LOW | HIGH | [004](004-validate-gateway-json.md) |
| 5 | `manager spawn --execute` prints `ok:false` but exits 0 on child failure | bug / dx | Med | S | LOW | HIGH | [005](005-propagate-manager-exit-status.md) |

Non-interactive selection: all five above (top leverage cluster). No additional plans written.

### Run 2 — commit `b96a1ec`, 2026-10-02

| # | Finding | Category | Impact | Effort | Risk | Confidence | Plan |
|---|---------|----------|--------|--------|------|------------|------|
| 7 | Replayed error events file a second GitHub issue and rewind `github-created` → `mock-draft` | bug / data integrity | High | S | MED | HIGH | [007](007-idempotent-issue-ingest.md) |
| 8 | `/chat execute` is unauthenticated, spawns a config-named binary, and is cross-origin reachable | security | High | M | MED | HIGH | [008](008-gate-chat-execute.md) |
| 9 | `gh issue create` runs via `spawnSync` with no timeout: `issues ingest --execute` can hang forever | bug / dx | Med-High | S | LOW | HIGH | [009](009-bound-gh-timeout.md) |
| 10 | Ingress stores raw bodies unbounded; `/status` echoes them back (20 MB queue from 60 POSTs) | security / dx | Med | S | LOW | HIGH | [010](010-bound-ingress-state.md) |
| 11 | `manager status` omits spawns; mid-sequence spawn failures give no recovery hint | dx | Med | S | LOW | HIGH | [011](011-manager-spawn-visibility.md) |

All five findings were reproduced against `b96a1ec` with isolated `HOME`/`PATH` fixtures before being written up; transcripts are in each plan's "Evidence" section.

### Run 3 — commit `cbc0592`, 2026-10-02

Fresh post-011 review (`/improve`, standard effort, 4 parallel audit agents + direct manual verification). Scoped to the manager/gateway/issues/chat/CLI surfaces. **104 green tests** at the tip. Selection was non-interactive: top 5 by leverage, all reproduced locally first.

| # | Finding | Category | Impact | Effort | Risk | Confidence | Plan |
|---|---------|----------|--------|--------|------|------------|------|
| 12 | `gateway stop` SIGKILLs whatever PID is in `gateway.pid` — a recycled PID destroys an unrelated process; `gateway start` is then wedged `alreadyRunning` | bug / safety | High | S | LOW | HIGH | [012](012-verify-gateway-pid-identity.md) |
| 13 | `herdr` `spawnSync` has no timeout, and `herdrUsable()` runs *before* the dry-run gate — even `manager spawn` without `--execute` hangs forever on a wedged Herdr | bug / dx | High | S | LOW | HIGH | [013](013-bound-herdr-subprocesses.md) |
| 14 | Plan 010 capped `body` and `text` but left `sender`, `channel` and `taskId` unbounded — one unauthenticated POST wrote 41 MB and `/status` echoed it all back | security | High | S | LOW | HIGH | [014](014-cap-unbounded-ingress-fields.md) |
| 15 | `/ingress/sentry`+`bugsink` bypass plan 010 entirely: unbounded draft files (5 POSTs → 21 MB), `gh` fails `E2BIG` with a misleading "gh not usable", failure envelope re-prints the whole body | security | High | M | MED | HIGH | [015](015-bound-issue-draft-directory.md) |
| 16 | `pick` writes `lastPicked` but reads it only for tasks — the issue and freeform tiers return the same item forever, starving out every config task | bug | High | M | MED | HIGH | [016](016-rotate-pick-across-tiers.md) |

**Run 3 theme:** 14, 15 and 012 are all *residual* gaps in shipped plans (010's bounds, and 007/008's assumptions), not new surface. 12, 13 and 16 are the first findings in the manager/PID and pick paths, both of which had no prior coverage.

Every Run 3 finding was reproduced before being written up, with isolated `HOME`/`PATH` fixtures and a fake gateway or Herdr binary — transcripts are in each plan's "Evidence" section.

## Recommended execution order

```
001 (test baseline)
 ├── 002 (path containment)     — needs test harness from 001
 ├── 003 (gateway cwd/context)  — needs test harness from 001
 ├── 004 (gateway JSON 400s)    — needs test harness from 001
 └── 005 (manager exit status)  — needs test harness from 001
```

Run **001 first**. 002–005 are independent of each other after 001 and may be parallelized.


## Recommended execution order (Run 2 — `b96a1ec`)

```
007 (idempotent ingest)     — independent; highest data-integrity leverage
008 (gate chat execute)     — security; independent of 007
009 (gh timeout)            — independent; pairs naturally with 007
010 (bound ingress state)   — independent; pairs with 004 patterns
011 (manager status/hints)  — independent; builds on 006 UX
```

Prefer **007** and **008** first (integrity + security). 009–011 may follow in any order.

## Recommended execution order (Run 3 — `cbc0592`)

```
012 (verify gateway PID)     — safety; independent, do first
013 (bound herdr calls)      — independent; mirrors 009 exactly
014 (cap ingress fields)     — security residual of 010; gateway.ts only
015 (bound issue drafts)     — security residual of 010; issues.ts; pairs with 014
016 (rotate pick tiers)      — product; independent of all of the above
```

**012 first** — it is the only finding whose failure mode destroys unrelated user work, and it also adds the first test coverage the gateway lifecycle has ever had (`gateway start|stop|status` currently have zero tests).

**013 next** — it is the same shape as the shipped plan 009, so the executor has a working in-repo template, and it fixes a hang on the *default* (dry-run) path.

**014 and 015 together** — one threat (unauthenticated POST → unbounded disk) split across two modules, two risk profiles, two test files. Doing either alone leaves the larger hole open; 014 is the cheaper and lower-risk of the pair.

**016 is independent** and can run whenever. It is the highest product-impact fix but also the riskiest (it touches a documented output contract), so it is a reasonable place to stop after 012–015.

## Status

| Plan | Title | Status | Depends on |
|------|-------|--------|------------|
| 001 | Establish an isolated Bun test baseline | DONE | none |
| 002 | Keep issue-draft writes inside the issues directory | DONE | 001 |
| 003 | Preserve the caller's repository context in the background gateway | DONE | 001 |
| 004 | Return predictable JSON errors for invalid gateway requests | DONE | 001 |
| 005 | Make executed manager failures return a nonzero CLI status | DONE | 001 |
| 006 | Wire manager spawn child tab/agent and cleanup UX | DONE | 001, 005 |
| 007 | Make issue ingest idempotent and publish deduplicated | DONE | 001, 002 |
| 008 | Gate `/chat execute` behind bind/origin/kind checks | DONE | 001, 004 |
| 009 | Bound `gh issue create` with timeout and closed stdin | DONE | 001 |
| 010 | Bound gateway ingress state growth; stop raw `/status` echo | DONE | 001, 004 |
| 011 | Surface live spawns in `manager status` + recovery hints | DONE | 001, 006 |
| 012 | Verify the gateway PID still belongs to a harness gateway | DONE | none |
| 013 | Bound every Herdr subprocess with a timeout; stop shelling out on dry-run | DONE | none |
| 014 | Cap the ingress event fields that plan 010 left unbounded | DONE | 010 |
| 015 | Bound the Sentry/Bugsink draft path — payload size and directory growth | DONE | 002, 007 |
| 016 | Rotate `harness pick` across the issue and freeform tiers | DONE | none |

Status values: OPEN | IN PROGRESS | DONE | BLOCKED (with one-line reason) | REJECTED (with one-line rationale).

## Considered and rejected / deferred

### Carried forward from earlier runs

- Large product scope (Matrix real tokens, new crons, GitHub create, release-please changes): explicitly out of scope for this burn-test.
- Expanding gateway into multi-tenant / auth: direction-only; not planned. **Re-confirmed in Run 3:** plan 008 landed the execute gate, and the audit did not re-raise general auth. The narrower question of an Origin check on the *ingress* routes is a real gap but is the same decision recorded here, so it was not re-planned.
- Full CI pipeline / lint/typecheck scaffolding beyond the hermetic Bun test baseline: deferred until 001 proves value. **Run 3 note:** 001 has now proven value (104 tests, all green, several plans verified through them). A `typecheck` script and a one-file CI workflow are both S-effort and would guard the ~14 refactors this plans directory anticipates — candidates for Run 4.
- Splitting `src/cli.ts` (1259 lines vs a ~238-line repo median): rejected for now. It is the highest-churn file but shows no god-object symptoms — no function over ~180 lines, a 5-line `any` cluster. The real cost is untested surface, not size.

### Run 3 vetted, deferred (real findings, ranked below the five)

Recorded with evidence so a future run can pick them up without re-auditing:

- **`/status` leaks `lastDelivery` raw** — plan 010 projected `lastEvent` but left `lastDelivery()` unprojected on the same route (`src/gateway.ts:506`). Unauthenticated `GET /status` returns `summaryPath`/`summaryJsonPath`/`deliveryPath` — absolute paths that embed the OS username — plus the full 600-char report excerpt. **Reproduced.** No consumer breaks: `src/static/chat.html` reads only `lastEvent`. **HIGH confidence, S effort — the top candidate for Run 4.**
- **`executeCleanup` is not idempotent** — discovery and mutation steps share one `results` array and one `every()` (`src/cli.ts:505`), so a `tab close` that fails because the tab was already closed manually makes `ok:false`, skips `deleteSpawn`, and wedges the task permanently (`spawn` then refuses with "task already spawned" and `--replace` fails at "cleanup before re-spawn failed"). **Reproduced.** HIGH confidence on the code path; MED on how often Herdr exits nonzero for an already-closed tab.
- **State files are written non-atomically** — `writeJsonAtomic` (temp + rename, with a comment explaining exactly why) exists at `src/gateway.ts:78` but only the two ingress files use it. `saveState` (`src/shared.ts:113`), `saveSpawns` (`:142`), `writeIssueDraft` (`src/issues.ts:146`) and `writeSummaryDelivery` (`src/cli.ts:1067-1069`) use bare `writeFileSync`, and every reader silently falls back to empty on a parse failure. Worst case: a truncated `spawns.json` loses every record, so `manager spawn` creates a duplicate worktree; a truncated issue draft makes `readStoredDraft` return `null` and bypasses plan 007's published-once guard.
- **`spawn --replace` with no record closes unscoped tabs** — `src/cli.ts:571` gates the "already spawned" refusal on `record && !replace`, so `--replace` with no record falls through to cleanup, which matches tabs by label across *all* repositories (`herdr tab list` is not cwd-scoped, unlike the worktree list at `src/cli.ts:462`). MED confidence — severity depends on how readily labels collide across repos.
- **Chat adapter timeouts kill only the direct child** — `src/chat.ts:138-145` SIGKILLs `child` without `detached`, so grandchildren forked by real agent CLIs (`claude -p`, `codex exec`) survive with no handle and no reaper. MED confidence — depends on whether those CLIs fork long-lived helpers.
- **`harness summary | jq` emits markdown** — `cmdStatus` and `cmdPick` use `--json || !process.stdout.isTTY`; `cmdSummary` (`src/cli.ts:1159`) checks only `--json`, so the non-TTY fallback is inconsistent across three sibling commands.
- **`harness issues ingest` with no pipe blocks on stdin forever** — `readJsonPayload` (`src/cli.ts:875`) awaits `Bun.stdin.text()` with no TTY check. Same hang class as plan 009, one step upstream of it.
- **`waitHealth` treats any 2xx from the port as success** (`src/cli.ts:765-778`) with no `AbortSignal` timeout, so a squatter on 8787 makes `gateway start` report `listening: true` with a dead child PID. Partly subsumed by plan 012, which adds identity verification.
- **README/schema drift** — `README.md:9-13` runs `harness upgrade` *before* extending `PATH`, so the first code block in the README fails verbatim; `herdr-harness.schema.json:21-32` sets `additionalProperties: false` and omits `adapters.chat.executeKinds`, which the README instructs users to write and the plan-008 gate reads; `HERDR_BIN_PATH`/`HERDR_SOCKET` are undocumented; the README Verification section names 2 of 14 test files. All S-effort, all documentation-only.

### Direction options (grounded, not defects — for the maintainer to weigh)

- **The harness is not a closed loop.** `pick` names work but cannot start it (`resolveTask` resolves only config task ids, so `manager spawn "$(harness pick --json | .id)"` fails for the issue and freeform tiers by construction), and Matrix/Telegram ingress is write-only — events are resolved, acknowledged `202`, and dropped, because the freeform tier sits behind `else if (tasks.length)` (`src/cli.ts:995`). Every spawn today is a manual transcription of a `pick` output.
- **Three declared config keys are inert.** `soul` is read at exactly one place (an echo into `manager status`) and never reaches `agentSpec` or `chatAdapterArgv`, so the one file describing what the agent *is* is never read by anything that starts an agent. `playbooks` is echoed into the summary and dispatched nowhere (dispatch is hardcoded to `PLAYBOOK_SENTRY`). `enabled` is in the schema, absent from the type, and read by nothing.
- **Retiring a picked draft needs a command.** The top direction item after plan 016: a `harness issues done|rm` subcommand plus a third `status` in the `IssueDraft` union (`src/issues.ts:16`). Rotation stops the stall but a draft never leaves the queue on its own. Must survive a replayed upstream event rather than resetting to `mock-draft`, so it interacts with plan 007.

## Not audited in depth

- Herdr host integration beyond CLI dry-run/status surfaces (a real `herdr` binary exists on the review machine; no live worktree/tab/agent operation was performed, and plan 013's test fixtures use a fake `herdr`)
- Chat UI static assets polish
- Cross-repo plugin packaging / release-please (intentionally untouched)
- `templates/soul.md` beyond reading it
