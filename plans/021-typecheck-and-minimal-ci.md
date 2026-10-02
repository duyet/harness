# Plan 021: Add a `typecheck` script and a one-file CI workflow

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 5fd3cf0..HEAD -- package.json tsconfig.json .github/`
> If CI or `bunx tsc` already runs on PRs, STOP and report rather than duplicating.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW — additive scripts/workflow; no runtime behaviour change
- **Depends on:** `plans/001-isolated-test-baseline.md` (shipped; proven value — 148 tests)
- **Category:** tests / dx
- **Confidence:** HIGH (deferred explicitly from Runs 1–3 as "candidates for Run 4" once 001 proved value)
- **Planned at:** commit `5fd3cf0`, 2026-10-02 (Run 4)

> **Executed — partial, via STOP; closed by 022.** `tsconfig.json`, `package.json#scripts.typecheck` (+ `typescript`/`@types/bun` devDeps) and `.github/workflows/test.yml` all landed — the last in `fe4f640`, after the first push was rejected for lacking the token's `workflow` scope. The typecheck was **not green** at this plan's exit: 23 errors, 3 in `src/gateway.ts`. The STOP condition held — no `src/` was edited to force green, and no knob was loosened to fake it (measured: `strict: false` is worse at 25; canonical `@tsconfig/bun` is 189). The CI typecheck job shipped `continue-on-error: true`; the `test` job was a real blocking gate.
>
> **Both halves are now complete.** [022](022-clear-typecheck-baseline.md) cleared the 23 errors without touching a single `tsconfig.json` knob and removed `continue-on-error`, so the typecheck job is a real gate too. Its own boxes stay unticked because they were not true when this plan was handed back; the criteria are met as of 022.

## Why this matters

Plan 001 established a hermetic Bun test baseline. Runs 2–4 have stacked ~20 plan-driven refactors on top with **no** `tsc` / CI gate. A one-line `typecheck` script and a single GitHub Actions workflow that runs `bun test` (+ typecheck) on push/PR would have caught several of the class of mistakes these plans fix (signature drift, unused exports, missing fields) before review. Run 3's README already named this as a Run 4 candidate after 001 proved value (then 104 tests; now 148).

## Current state

`package.json` scripts today:

```json
"scripts": {
  "start": "bun src/cli.ts start",
  "status": "bun src/cli.ts status",
  "test": "bun test"
}
```

No `.github/` workflows. No `tsconfig.json` in-repo (Bun typechecks optionally via `bunx tsc --noEmit` once a minimal config exists, or `bun --bun tsc`).

## Evidence

Inventory at `5fd3cf0`: `ls .github` → absent; `package.json` has no typecheck. Deferred note in `plans/README.md` (Run 3): "A `typecheck` script and a one-file CI workflow are both S-effort and would guard the ~14 refactors this plans directory anticipates — candidates for Run 4."

## Scope

**Only modify:**
- `package.json` — add `"typecheck": ...`
- `tsconfig.json` (new, minimal, `noEmit`, cover `src/` + `tests/`)
- `.github/workflows/test.yml` (new) — bun setup, `bun test`, `bun run typecheck`
- README Verification blurb if it still names only 2 of 19 test files
- `plans/README.md` status row

**Out of scope:**
- Full lint/eslint/prettier scaffolding
- release-please / multi-package CI
- Changing runtime code to satisfy overly strict `strict` flags on day one — start with settings that pass on tip `5fd3cf0`; tighten later
- Paying for / configuring external coverage services

## Steps

1. Add a minimal `tsconfig.json` that typechecks the current tree green at `5fd3cf0` (adjust `strict` knobs only if tip is already clean under stricter settings).
2. Add `package.json#scripts.typecheck`.
3. Add `.github/workflows/test.yml` on `push`/`pull_request` to `master` (and `main` if needed): checkout, setup-bun, `bun test`, `bun run typecheck`.
4. Update README Verification to mention `bun test` (19 files / 148 cases) and `bun run typecheck`.
5. Locally: `bun test && bun run typecheck`.

## Done criteria

Met by [022](022-clear-typecheck-baseline.md), 2026-10-02 (this plan's own STOP barred `src/` edits, so they could not be met at this plan's exit):

- [x] `bun run typecheck` exits 0 on tip
- [x] Workflow file present and runs test + typecheck
- [x] No `src/` behaviour changes
- [x] `plans/README.md` row updated on execute

## STOP conditions

- Tip does not typecheck without substantial `src/` edits — stop, file a follow-up listing the errors, do not silently weaken the codebase to greenwash CI.
- Org policy blocks Actions — stop and report; leave the `typecheck` script even if the workflow cannot land.
