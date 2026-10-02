# Harness improvement plans

Four advisory runs. Plans 001-006 are from commit `b17bb04` (2026-09-16 / Asia/Saigon 2026-09-17) via **anyr claude --model stealth/union-alpha** + `/improve` (non-interactive default: top 5 by leverage). Plans 007-011 are a focused re-review at commit `b96a1ec` (2026-10-02), targeting the manager/gateway/issues/chat surface and the features added after 006. Plans 012-016 are a fresh post-011 review at commit `cbc0592` (2026-10-02), run against the surfaces that changed in 007-011 (chat execute gating, idempotent ingest, `gh` timeouts, ingress bounds, manager spawn visibility). Plans 017-021 are Run 4 at commit `5fd3cf0` (2026-10-02 / Asia/Saigon), a post-016 advisory `/improve` + focused review via **Herdr + anyr claude --model stealth/space-bunny-alpha** (advisor-only; 148 green tests). Selection promoted the highest-leverage Run 3 deferred items plus the long-standing typecheck/CI candidate.

**Hard rules for executors:** these plans are not authorization to implement. Execute only when separately requested. Source was not modified by the advisory run. Leave release-please alone. Do not touch herdr-desk.

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


### Run 4 — commit `5fd3cf0`, 2026-10-02

Fresh post-016 review (Herdr pane `harness-improve-run4` + `/improve` orientation; findings vetted with isolated `HOME`/`PATH` fixtures against tip). **148 green tests**. Scoped to residuals of 010/006/009 and the deferred list from Run 3. Selection was non-interactive: top 5 by leverage.

| # | Finding | Category | Impact | Effort | Risk | Confidence | Plan |
|---|---------|----------|--------|--------|------|------------|------|
| 17 | Plan 010 projected `lastEvent` but left `lastDelivery()` raw on unauthenticated `GET /status` — absolute paths embed the OS username + 600-char report excerpt | security | High | S | LOW | HIGH | [017](017-project-status-last-delivery.md) |
| 18 | `executeCleanup` shares one `results.every(status===0)` across discovery and mutation — a failed `tab close` for an already-closed tab skips `deleteSpawn` and wedges `--replace` | bug / dx | High | S | LOW–MED | HIGH | [018](018-idempotent-execute-cleanup.md) |
| 19 | `writeJsonAtomic` exists but only ingress uses it; `saveState` / `saveSpawns` / `writeIssueDraft` / `writeSummaryDelivery` use bare `writeFileSync` while readers silent-fallback to empty | bug / data integrity | High | S | LOW | HIGH | [019](019-atomic-state-file-writes.md) |
| 20 | `harness issues ingest` without `--file`/pipe awaits `Bun.stdin.text()` forever on a TTY — same hang class as plan 009, one step upstream | bug / dx | Med-High | S | LOW | HIGH | [020](020-bound-issues-ingest-stdin.md) |
| 21 | No `typecheck` script and no CI workflow after 001 proved value (now 148 tests / ~20 plan-driven refactors) | tests / dx | Med | S | LOW | HIGH | [021](021-typecheck-and-minimal-ci.md) |

**Run 4 theme:** 17 and 19 are residuals of shipped plan 010's incomplete projection/atomic story; 18 is the cleanup idempotency deferred from Run 3; 20 mirrors plan 009's hang class; 21 is the scaffolding item Runs 1–3 explicitly parked for Run 4.

017–018 were reproduced with fixtures before write-up (transcripts in each plan's Evidence). 019–021 are HIGH-confidence from tip code inventory + prior deferred notes; 020's hang is the same `stdin.text()` pattern plan 009 already treated as proven.

## Recommended execution order (Run 4 — `5fd3cf0`)

```
017 (project /status lastDelivery)  — security residual of 010; gateway.ts only; do first
018 (idempotent cleanup)            — independent; unblocks manager replace loops
019 (atomic state writes)           — independent; pairs with 010's writeJsonAtomic
020 (ingest stdin guard)            — independent; mirrors 009
021 (typecheck + CI)                — independent; no src behaviour change
```

**017 first** — unauthenticated HTTP leak, S effort, residual of the plan that already taught the projection pattern.

**018 next** — the only finding that permanently wedges operator recovery (`spawns.json` + `--replace`).

**019 and 020** may follow in any order; 019 is the higher integrity leverage.

**021 last** (or whenever) — additive only; do not let a red typecheck force `src/` edits in the same PR (see its STOP conditions).

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
| 017 | Project `lastDelivery` on unauthenticated `GET /status` | DONE | 010 |
| 018 | Make `executeCleanup` idempotent (failed tab-close must not wedge spawns) | DONE | 006, 013 |
| 019 | Write all harness state files atomically (temp + rename) | OPEN | none |
| 020 | Refuse interactive stdin for `harness issues ingest` | OPEN | none |
| 021 | Add a `typecheck` script and a one-file CI workflow | OPEN | 001 |

Status values: OPEN | IN PROGRESS | DONE | BLOCKED (with one-line reason) | REJECTED (with one-line rationale).

## Considered and rejected / deferred

### Carried forward from earlier runs

- Large product scope (Matrix real tokens, new crons, GitHub create, release-please changes): explicitly out of scope for this burn-test.
- Expanding gateway into multi-tenant / auth: direction-only; not planned. **Re-confirmed in Runs 3–4:** plan 008 landed the execute gate; Run 4 did not re-raise general auth. Origin on *ingress* remains the same deferred decision.
- Full lint/eslint beyond typecheck: still deferred. **Run 4 note:** plan 021 covers the typecheck + one-file CI slice that Runs 1–3 parked; broader lint stays out.
- Splitting `src/cli.ts` (~1460 lines vs a ~238-line repo median): rejected for now. Still no god-object symptoms — the cost remains untested surface, not size. **Run 4:** line count grew with 012–016; still not planned.

### Run 3 items promoted in Run 4

- `/status` leaks `lastDelivery` raw → **[017](017-project-status-last-delivery.md)**
- `executeCleanup` is not idempotent → **[018](018-idempotent-execute-cleanup.md)**
- State files written non-atomically → **[019](019-atomic-state-file-writes.md)**
- `harness issues ingest` stdin hang → **[020](020-bound-issues-ingest-stdin.md)**
- typecheck + CI scaffolding → **[021](021-typecheck-and-minimal-ci.md)**

### Run 3/4 vetted, still deferred (ranked below the five)

- **`spawn --replace` with no record closes unscoped tabs** — `src/cli.ts` gates the "already spawned" refusal on `record && !replace`, so `--replace` with no record falls through to cleanup, which matches tabs by label across *all* repositories (`herdr tab list` is not cwd-scoped). MED confidence — severity depends on label collision. Pair with 018 if an executor finishes early.
- **Chat adapter timeouts kill only the direct child** — `src/chat.ts` SIGKILLs `child` without `detached`/process-group kill, so grandchildren from real agent CLIs can survive. MED confidence.
- **`harness summary | jq` emits markdown** — `cmdStatus`/`cmdPick` use `--json || !process.stdout.isTTY`; `cmdSummary` (`src/cli.ts:1360`) checks only `--json`. S effort, dx-only; ranked below 020.
- **`waitHealth` treats any 2xx from the port as success** with no body identity check — partly subsumed by plan 012's PID identity; a squatter on 8787 can still make `gateway start` report `listening: true` briefly. Leave until 012's tests want a follow-up.
- **README/schema drift** — `README.md` still runs `harness upgrade` before extending `PATH`; `herdr-harness.schema.json` omits `adapters.chat.executeKinds` under `additionalProperties: false`; `HERDR_BIN_PATH`/`HERDR_SOCKET` undocumented; Verification section under-names test files. All S-effort docs; fold into 021's README touch or a docs-only follow-up.

### Direction options (grounded, not defects — for the maintainer to weigh)

- **The harness is not a closed loop.** `pick` names work but cannot start it (`resolveTask` resolves only config task ids, so `manager spawn "$(harness pick --json | .id)"` fails for the issue and freeform tiers by construction), and Matrix/Telegram ingress is write-only — events are resolved, acknowledged `202`, and dropped, because the freeform tier sits behind `else if (tasks.length)`. Every spawn today is a manual transcription of a `pick` output. **Run 4:** still true after plan 016's rotation.
- **Three declared config keys are inert.** `soul` is echoed into `manager status` only; `playbooks` is echoed into the summary and dispatched nowhere (dispatch hardcoded to `PLAYBOOK_SENTRY`); `enabled` is in the schema, absent from the type, and read by nothing.
- **Retiring a picked draft needs a command.** Still the top direction item after plan 016: a `harness issues done|rm` subcommand plus a third `status` in the `IssueDraft` union. Must survive a replayed upstream event (plan 007).

## Not audited in depth

- Herdr host integration beyond CLI dry-run/status surfaces (a real `herdr` binary exists on the review machine; no live worktree/tab/agent operation was performed, and plan 013's test fixtures use a fake `herdr`)
- Chat UI static assets polish
- Cross-repo plugin packaging / release-please (intentionally untouched)
- `templates/soul.md` beyond reading it
