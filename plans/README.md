# Harness improvement plans

Two advisory runs. Plans 001-006 are from commit `b17bb04` (2026-09-16 / Asia/Saigon 2026-09-17) via **anyr claude --model stealth/union-alpha** + `/improve` (non-interactive default: top 5 by leverage). Plans 007-011 are a focused re-review at commit `b96a1ec` (2026-10-02), targeting the manager/gateway/issues/chat surface and the features added after 006 (chat execute, `gh issue create`, pick priority, summary pickup, spawn cleanup).

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
| 011 | Surface live spawns in `manager status` + recovery hints | OPEN | 001, 006 |

## Considered and rejected / deferred

- Large product scope (Matrix real tokens, new crons, GitHub create, release-please changes): explicitly out of scope for this burn-test.
- Expanding gateway into multi-tenant / auth: direction-only; not planned.
- Full CI pipeline / lint/typecheck scaffolding beyond the hermetic Bun test baseline: deferred until 001 proves value.

## Not audited in depth

- Herdr host integration beyond CLI dry-run/status surfaces
- Chat UI static assets polish
- Cross-repo plugin packaging / release-please (intentionally untouched)
