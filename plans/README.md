# Harness improvement plans

Advisory run against commit `b17bb04` (2026-09-16 / Asia/Saigon 2026-09-17) via **anyr claude --model stealth/union-alpha** + `/improve` (non-interactive default: top 5 by leverage).

**Hard rules for executors:** these plans are not authorization to implement. Execute only when separately requested. Source was not modified by the advisory run. Leave release-please alone. No remotes/push. Do not touch herdr-desk.

## Leverage table (vetted findings → plans)

| # | Finding | Category | Impact | Effort | Risk | Confidence | Plan |
|---|---------|----------|--------|--------|------|------------|------|
| 1 | No automated test baseline; subsequent fixes lack a hermetic regression gate | tests / dx | High | M | LOW | HIGH | [001](001-isolated-test-baseline.md) |
| 2 | Issue-draft paths incorporate unvalidated event IDs (path separators / `..`) | security | High | S | MED | HIGH | [002](002-contain-issue-draft-paths.md) |
| 3 | Background gateway `chdir`s to plugin checkout; loses caller repo config context | bug | High | S | LOW | HIGH | [003](003-preserve-gateway-repo-context.md) |
| 4 | Gateway POST routes: malformed JSON → HTTP 500; non-object JSON poorly handled | bug / tests | Med-High | S | LOW | HIGH | [004](004-validate-gateway-json.md) |
| 5 | `manager spawn --execute` prints `ok:false` but exits 0 on child failure | bug / dx | Med | S | LOW | HIGH | [005](005-propagate-manager-exit-status.md) |

Non-interactive selection: all five above (top leverage cluster). No additional plans written.

## Recommended execution order

```
001 (test baseline)
 ├── 002 (path containment)     — needs test harness from 001
 ├── 003 (gateway cwd/context)  — needs test harness from 001
 ├── 004 (gateway JSON 400s)    — needs test harness from 001
 └── 005 (manager exit status)  — needs test harness from 001
```

Run **001 first**. 002–005 are independent of each other after 001 and may be parallelized.

## Status

| Plan | Title | Status | Depends on |
|------|-------|--------|------------|
| 001 | Establish an isolated Bun test baseline | DONE | none |
| 002 | Keep issue-draft writes inside the issues directory | DONE | 001 |
| 003 | Preserve the caller's repository context in the background gateway | TODO | 001 |
| 004 | Return predictable JSON errors for invalid gateway requests | TODO | 001 |
| 005 | Make executed manager failures return a nonzero CLI status | TODO | 001 |

## Considered and rejected / deferred

- Large product scope (Matrix real tokens, new crons, GitHub create, release-please changes): explicitly out of scope for this burn-test.
- Expanding gateway into multi-tenant / auth: direction-only; not planned.
- Full CI pipeline / lint/typecheck scaffolding beyond the hermetic Bun test baseline: deferred until 001 proves value.

## Not audited in depth

- Herdr host integration beyond CLI dry-run/status surfaces
- Chat UI static assets polish
- Cross-repo plugin packaging / release-please (intentionally untouched)
