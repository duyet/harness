# Plan 019: Write all harness state files atomically (temp + rename)

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 5fd3cf0..HEAD -- src/shared.ts src/gateway.ts src/issues.ts src/cli.ts`
> `writeJsonAtomic` already exists at `src/gateway.ts:120` for ingress only. If `saveState` / `saveSpawns` / `writeIssueDraft` / `writeSummaryDelivery` already use atomic writes, STOP.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW — same bytes on disk; only the write protocol changes
- **Depends on:** none (pairs with plan 010's ingress atomic helper)
- **Category:** bug / data integrity
- **Confidence:** HIGH (code inspection at `5fd3cf0`; readers already silent-fallback on parse failure)
- **Planned at:** commit `5fd3cf0`, 2026-10-02 (Run 4)

## Why this matters

`writeJsonAtomic` (temp file + `renameSync`) exists in `src/gateway.ts` with a comment explaining crash-safety, but only the two ingress files use it. Every other durable record uses bare `writeFileSync`:

| Writer | Path |
|---|---|
| `saveState` | `src/shared.ts:118-120` |
| `saveSpawns` | `src/shared.ts:147-149` |
| `writeIssueDraft` | `src/issues.ts:245` |
| `writeSummaryDelivery` | `src/cli.ts:1268-1270` |

Every reader silently falls back to empty / null on parse failure (`loadState`, `loadSpawns`, `readStoredDraft`, `lastDelivery`). Worst cases:

- Truncated `spawns.json` → empty map → `manager spawn` creates a **duplicate** worktree for a live task.
- Truncated issue draft → `readStoredDraft` returns `null` → bypasses plan 007's published-once guard and can file a second GitHub issue.

## Current state

Atomic helper (ingress only), `src/gateway.ts:120-125` (approx):

```ts
function writeJsonAtomic(path: string, value: unknown) {
  // temp + rename ...
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}
```

Non-atomic siblings as cited above. `gateway.pid` / `gateway.json` are small and rewritten by a single process; still prefer atomic for `gateway.json` if you touch that path, but PID files are often written as plain text — leave PID write strategy alone unless trivial.

## Evidence

Code inspection at `5fd3cf0` (2026-10-02). No crash injection required: the asymmetry is explicit in-tree, and the silent parse fallbacks are the amplifiers. Optional executor proof: open a state file, write a truncated prefix without rename, confirm `loadSpawns()` returns `{ spawns: {} }`.

## Scope

**Only modify:**
- Move or re-export `writeJsonAtomic` to `src/shared.ts` (preferred) and call it from gateway ingress + `saveState` + `saveSpawns` + `writeIssueDraft` + `writeSummaryDelivery` (JSON file)
- Markdown `last-summary.md` may stay `writeFileSync` or use temp+rename for text
- Tests proving a mid-write truncate cannot be observed as valid empty state (optional but valuable)
- `plans/README.md` status row

**Out of scope:**
- Redesigning the state schema
- Locking / multi-writer coordination beyond atomic replace
- release-please

## Steps

1. Promote `writeJsonAtomic` to `src/shared.ts` and import it from `gateway.ts`.
2. Switch `saveState`, `saveSpawns`, `writeIssueDraft`, and the JSON half of `writeSummaryDelivery` to the helper.
3. Add a small unit/fixture test that writes via the helper and, separately, documents that a hand-truncated file is treated as empty (characterization of today's reader).
4. Full `bun test`.

## Done criteria

- [ ] No durable JSON state writer under `src/` uses bare `writeFileSync` for the final path (PID files excepted)
- [ ] Ingress still uses the same helper (no behaviour change)
- [ ] `bun test` exit 0

## STOP conditions

- Cross-device `renameSync` limitations on a platform you must support — stop and report rather than inventing copy+unlink without review.
