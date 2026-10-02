# Plan 035: Make `writeFileAtomic` durable and mode-preserving (residual of plan 019)

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 63937ed..HEAD -- src/shared.ts tests/atomic-state-writes.test.ts`
> If `writeFileAtomic` already `fsync`s the temp file before the rename **and** carries the target's existing mode across, STOP and report.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW
- **Depends on:** `plans/019-atomic-state-file-writes.md` (shipped)
- **Category:** bug / data integrity + security
- **Confidence:** HIGH (both halves measured 2026-10-02 against `63937ed`)
- **Planned at:** commit `63937ed`, 2026-10-02 (Run 7)

## Why this matters

Plan 019 routed every durable state file through one helper so that a crash cannot leave a torn file. The comment above it states the guarantee:

```ts
// src/shared.ts:139-143
// So: write a sibling temp file, then rename over the target. Readers see
// either the old bytes or the new ones, never a prefix.
```

That holds for a **process** crash and not for a **machine** crash, and the second half of the promise — that the helper owns the file's identity, not just its bytes — was never made. Two concrete gaps:

**Durability.** The helper does not `fsync`. `writeFileSync` + `renameSync` returns once the bytes are in the page cache; on power loss or a kernel panic the rename can be durable while the data behind it is not, leaving a correctly-named, zero-length file. Every reader here treats that as *"no state"*, silently and with no error — which is precisely the outcome the function was written to prevent, one failure class further out. `grep -rn "fsync\|fdatasync\|openSync" src/` returns nothing today.

**Mode.** The temp file is created fresh, so it takes the process umask (`0666 & ~umask`, typically `0644`) and the rename puts it over the target **unconditionally**, discarding whatever mode the target had. An operator who has tightened a file — and `STATE_DIR` is `0755`, so every state file is world-*readable*-by-default in a world-traversable directory to begin with — silently gets it loosened again on the next write. What those files carry: `spawns.json` (worktree paths, tab/pane/workspace ids), and the issue drafts, whose bodies are **full error payloads from whatever application is being monitored** — stack traces, internal file paths, breadcrumb lists.

This has been on the deferred list since Run 5 and was re-checked in Run 6 without being promoted. It is promoted now as one finding rather than two because both are the same function and the same acceptance gap.

**Not a regression.** Before plan 019 these files were written with bare `writeFileSync`, which has the identical mode behaviour. This plan does not reopen anything 019 fixed; it extends the guarantee 019 claimed to a case 019 did not reach.

## Current state

```ts
// src/shared.ts:144
export function writeFileAtomic(path: string, contents: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, contents);      // 0666 & ~umask; no fsync of the data
    renameSync(tmp, path);             // no fsync of the directory either
  } catch (e) { /* unlink tmp */ throw e; }
}
```

## Evidence

**Mode is reset, measured on the real helper:**

```
umask: 0022
before: 600 /tmp/run7/home/.local/state/herdr-harness/spawns.json
  (operator runs `chmod 600`)
wrote
after:  644 /tmp/run7/home/.local/state/herdr-harness/spawns.json   <- mode reset

STATE_DIR: 755 /tmp/run7/home/.local/state/herdr-harness
```

One ordinary `writeJsonAtomic` call — a no-op write of a record that already existed — undid the `chmod`.

**No durability barrier exists anywhere in the module:**

```
$ grep -rn "fsync\|fdatasync\|openSync" src/
(no fsync anywhere in src/)
```

## Steps

1. Carry the target's mode across the rename. When the target exists, read its mode first and re-`chmod` the temp file to match before renaming; when it does not, create the temp with an explicit mode rather than letting the umask decide alone.
2. Decide and state that explicit mode. `0600` is the defensible default for a state directory that holds worktree paths and third-party error payloads, and it matches the "one user, one machine" model the rest of the CLI assumes. Whatever is chosen, it must be a **literal**, not `0666 & ~umask` — the current behaviour is not a decision, it is an omission.
3. `fsync` the temp file's descriptor before the rename, and `fsync` the containing directory after it, so the rename itself is durable and not just the bytes. Both are cheap, and both run on writes that already do a `writeFileSync` + `renameSync` pair.
4. Keep the existing `catch`/`unlink` behaviour exactly as is — an orphan temp must never survive a failed write.
5. Keep the `gateway.pid` exemption. Plan 019's acceptance criterion explicitly exempts it and this plan does not reopen it.

## Tests

- **Mode preservation:** write a file, `chmod 600` it, write it again through the helper, assert the mode is still `600` from `stat`. Repeat at `640` and `644` so a hardcoded constant cannot pass by accident.
- **Mode on create:** assert a file that did not exist before takes the documented default mode, asserted as a literal so a umask change in CI does not silently redefine it.
- **Durability:** assert the data is `fsync`ed before the rename — a fake `fs` is overkill here, so assert the *ordering* by making the rename throw and checking the temp file was already synced-and-closed, plus a direct assertion that an `fsync` call is reached on the success path. Do not attempt to simulate a power cut.
- **No regression on the failure path:** the existing torn-write tests from plan 019 must still pass, and the "no orphan `.tmp` beside the real file" assertion must still hold.
- One mutation-check: drop the `chmod` carry-over and confirm the `600` case fails.

## Gates

- `bun test` green; `bun run typecheck` exit 0.
- `src/cli.ts`, `src/gateway.ts` and `src/issues.ts` untouched — this is a `shared.ts`-only change plus tests.

## STOP conditions

- **Do not** change `STATE_DIR`'s own mode, and do not add a `mkdir` mode. Widening into directory permissions is a separate decision about the state directory's layout, and plan 029/017's projections assumed the current one.
- **Do not** add a `chown`. The harness is single-user by design; a helper that can change ownership is a helper that can be used to plant a file.
- **Do not** make the write fail when `fsync` is unavailable on a filesystem that does not support it. A durability barrier that can refuse to write is a worse failure than the one it prevents — degrade to the current behaviour rather than throwing.
- **Do not** bundle a migration that rewrites existing state files' modes. The first write after this ships fixes each file on its own, and a sweep would touch files an operator may have deliberately set.

## Acceptance

- A file tightened with `chmod` keeps its mode across any number of subsequent writes.
- A file created by the helper takes a documented literal mode, independent of the process umask.
- The data and the rename are both `fsync`ed before the call returns.
- 202+ tests green; `bun run typecheck` exit 0.
