# Plan 020: Refuse interactive stdin for `harness issues ingest` (same hang class as plan 009)

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 5fd3cf0..HEAD -- src/cli.ts tests/issues-*.test.ts`
> If `readJsonPayload` already rejects TTY stdin or applies a read timeout, STOP and report.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW — only the no-pipe interactive path changes; `--file` and piped JSON stay identical
- **Depends on:** none (mirrors plan 009's hang-class fix one step upstream)
- **Category:** bug / dx
- **Confidence:** HIGH (code path at `5fd3cf0`; same `Bun.stdin.text()` hang class as plan 009's pre-fix `gh`)
- **Planned at:** commit `5fd3cf0`, 2026-10-02 (Run 4)

## Why this matters

`harness issues ingest` without `--file` and without a pipe awaits `Bun.stdin.text()` forever. A user who runs the subcommand interactively (or a script that forgets to pipe) wedges the CLI with no timeout and no hint — the same availability failure plan 009 fixed for `gh issue create`, one step upstream of the GitHub call.

## Current state

`src/cli.ts:1034-1042`:

```ts
async function readJsonPayload(from: number): Promise<Record<string, unknown>> {
  const file = optValue("--file", from);
  const text = file
    ? readFileSync(file, "utf8")
    : await Bun.stdin.text();
  if (!text.trim()) {
    throw new Error("empty payload; pass --file PATH or JSON on stdin");
  }
  return JSON.parse(text) as Record<string, unknown>;
}
```

`cmdIssues` ingest at `src/cli.ts:1052+` calls this before any `--execute` / `gh` work.

## Evidence

Code inspection at `5fd3cf0`. Optional reproduce: `timeout 3 bun src/cli.ts issues ingest --source sentry` on a TTY → hangs until timeout (no usage error). Do **not** leave a hung process in CI — always wrap with `timeout`.

## Scope

**Only modify:**
- `src/cli.ts` — `readJsonPayload` (and ingest error messaging)
- Tests for TTY / empty-stdin refusal (fixture can stub `process.stdin.isTTY` or invoke with no pipe under `timeout`)
- `plans/README.md` status row; brief README usage note if the ingest docs claim bare stdin without a pipe

**Out of scope:**
- Changing `--file` behaviour
- Bounding other CLI subcommands' stdin unless they share `readJsonPayload`
- release-please

## Steps

1. If `!file && process.stdin.isTTY` (or equivalent Bun check), print JSON `ok:false` with usage (`--file PATH` or pipe JSON) and `process.exit(1)` — do not read stdin.
2. Optionally add a read deadline for non-TTY stdin so a stuck pipe cannot hang forever (mirror plan 009 timeout magnitudes if practical; S-effort minimum is the TTY guard alone).
3. Regression: TTY path exits 1 promptly; piped `{"message":"x"}` still ingests; `--file` unchanged.

## Done criteria

- [ ] Interactive `issues ingest` without `--file` exits nonzero in &lt;1s with a clear error
- [ ] Piped and `--file` paths stay green
- [ ] `bun test` exit 0

## STOP conditions

- Bun's stdin TTY detection is unreliable in the environments you must support — stop and report; do not guess.
