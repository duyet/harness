# Plan 009: Bound `gh issue create` with a timeout and closed stdin

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or real GitHub calls without separate authorization.
>
> **Drift check (first):** `git diff --stat b96a1ec..HEAD -- src/issues.ts src/chat.ts src/cli.ts tests/issues-github.test.ts`
> Compare changed code against the excerpts below. Plan 007 may add a publish guard directly above this call; that expected change must not alter the argv. STOP on unexplained drift.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW — success and failure envelopes keep their fields; a slow `gh` that previously hung now reports a timeout
- **Depends on:** `plans/001-isolated-test-baseline.md`
- **Category:** bug / dx
- **Confidence:** HIGH (reproduced 2026-10-02 against `b96a1ec`; transcript in "Evidence")
- **Planned at:** commit `b96a1ec`, 2026-10-02

## Why this matters

`harness issues ingest --execute` blocks the process indefinitely if `gh` does not return: a network stall, a corporate proxy, a locked credential helper, or a `gh` build that asks a question nobody is there to answer. `spawnSync` is called with no `timeout` and default stdio, so the caller waits forever with no output and no way to tell whether the issue was filed. The harness already solved this exact problem for chat adapters — `invokeAdapter` kills on a timer and reports `timed out after Nms` (`src/chat.ts:100-107`). Publication should use the same discipline.

## Current state

`src/issues.ts:168-186`:

```ts
export function publishIssueDraft(draft: IssueDraft, ghBin = "gh"): GhCreateOutcome {
  const args = ghIssueCreateArgv(draft);
  const command = [ghBin, ...args];
  const r = spawnSync(ghBin, args, { encoding: "utf8", cwd: process.cwd() });
  const stdout = (r.stdout || "").trim().slice(0, 500);
  const stderr = (r.stderr || "").trim().slice(0, 500);
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      command,
      status: r.status,
      stdout,
      stderr,
      error: r.error
        ? `gh not usable (${ghBin}): ${r.error.message}`
        : `gh issue create exited ${r.status ?? r.signal ?? "unknown"}`,
      draft,
    };
  }
```

There is no `timeout`, no explicit `stdio`, and no `maxBuffer`. `spawnSync` is also the only blocking call on this path: it stalls the whole CLI, including the JSON envelope that would have told the operator what happened. `src/cli.ts:887-902` prints `result.error` and exits 1, so once a timeout surfaces there, the existing envelope already carries it correctly.

For contrast, `src/chat.ts:33-37` already clamps a timeout from the environment:

```ts
export function chatTimeoutMs(): number {
  const n = Number(process.env[CHAT_TIMEOUT_ENV]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHAT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(n), 100), MAX_TIMEOUT_MS);
}
```

and `invokeAdapter` kills the child and reports `timed out after ${timeoutMs}ms`. No equivalent exists on the publish path.

## Evidence

Reproduced 2026-10-02 at `b96a1ec` with a fixture `gh` that sleeps:

```
$ timeout 15 harness issues ingest --source sentry --file payload.json --execute
exit=124 elapsed=15s (124 = killed by `timeout`; the CLI never returned)
```

`gh` never returned, and neither did `harness`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `bun --version` | supported Bun (audit: 1.4.2) |
| Prerequisite | `bun test` | all 72 existing cases pass |
| New regression gate | `bun test tests/issues-gh-timeout.test.ts` | all cases pass |
| Full gate | `bun test && git diff --check` | exit 0 |

No install or build. These tests are proposed, not already run. Fixtures live only in `dist/.test-tmp/`.

## Scope

**Only modify:** `src/issues.ts` (`publishIssueDraft` spawn options plus a timeout helper), `tests/issues-gh-timeout.test.ts` (new), `tests/fixtures/issues-gh-timeout-runner.ts` (new), a short README note beside the existing `issues ingest --execute` docs, and this plan's row in `plans/README.md`.

**Out of scope:** retry/backoff logic, changing the `gh` argv, labels or body, a GitHub API client, token handling, changing plan 007's duplicate guard, chat adapter timeouts, manager Herdr calls, dependencies, release-please, other repos, crons and remotes.

## Git workflow

No branch/worktree creation, commit, push or PR. Preserve unrelated work. Any later implementation or publication needs separate authorization.

## Steps

### Step 1: Add a clamped publish timeout

Add `HARNESS_GH_TIMEOUT_MS` handling mirroring `chatTimeoutMs()`: parse the env value, fall back to a default (60 s is appropriate for a network write), and clamp to a sane range (1 s minimum, 5 minutes maximum). Export the helper for testing. Keep the environment variable name distinct from `HARNESS_CHAT_TIMEOUT_MS` so the two subprocess budgets can be tuned separately.

**Verify:** the helper returns the default for unset, non-numeric, zero and negative values, and clamps both directions.

### Step 2: Bound the spawn

Pass `timeout`, an explicit `stdio: ["ignore", "pipe", "pipe"]` so `gh` can never block on inherited terminal input, and `killSignal: "SIGKILL"` so a wedged child actually dies. Leave `cwd: process.cwd()` alone: `gh` resolves the target repository from the cwd's git remote, and that behavior is documented at `src/issues.ts:139`.

Detect the timeout through `r.error` (Node sets `code: "ETIMEDOUT"`, and `signal: "SIGKILL"`) and return an outcome shaped exactly like the existing failure: `ok: false`, `status: r.status` (null on timeout), the truncated `stdout`/`stderr`, and an `error` string reading `gh issue create timed out after ${timeoutMs}ms` with a hint that nothing was filed and the command may be re-run. Do not add new required fields to `GhCreateOutcome`; an optional `timedOut` flag is acceptable if the CLI prints it.

**Verify:** `bun test tests/issues-gh-timeout.test.ts` → timeout case returns `ok:false` with a timeout message.

### Step 3: Regression coverage

Create `tests/issues-gh-timeout.test.ts` on plan 001's `tests/helpers.ts`, with fixture `gh` scripts and a restricted `PATH`, following `tests/fixtures/issues-gh-runner.ts`. Cases:

1. Characterization: a `gh` that prints an issue URL still yields `ok:true`, `status: 0`, the recorded URL/number, and a stored `github-created` draft (unchanged behavior).
2. Characterization: a `gh` that exits nonzero still yields `ok:false` with the existing `gh issue create exited N` message and CLI exit 1.
3. Characterization: a missing `gh` still yields the existing `gh not usable (gh)` message and CLI exit 1.
4. `gh` that never returns: the CLI returns within the configured timeout (use `HARNESS_GH_TIMEOUT_MS=300`), reports a timeout in `error`, exits 1, and leaves the on-disk draft as `mock-draft`.
5. `gh` that blocks reading stdin: returns promptly rather than waiting, proving stdin is ignored.
6. `HARNESS_GH_TIMEOUT_MS` unset, non-numeric and clamped values produce a working bounded spawn.

Assert wall-clock bounds generously (the test timeout, not the configured value) so the suite is not flaky, and assert the child is gone afterwards.

**Verify:** `bun test tests/issues-gh-timeout.test.ts` → all cases pass.

### Step 4: Full regression and boundary check

**Verify:** `bun test && git diff --check` → exit 0 (72 existing cases plus the new file). `git diff -- src/issues.ts` changes only spawn options, the timeout helper and the error string. `git status --short` → scoped changes only.

## Test plan

Add `tests/issues-gh-timeout.test.ts` plus `tests/fixtures/issues-gh-timeout-runner.ts`, both in the established isolated-fixture style: temporary `HOME` under `dist/.test-tmp/`, `PATH` limited to the fixture bin, no real `gh`, no network, no GitHub. Assert stdout JSON, exit status, wall-clock bound and final draft state for every case.

## Done criteria

- [ ] Focused and full Bun suites exit 0.
- [ ] A `gh` that never returns cannot hang the CLI; it is killed and reported as a timeout.
- [ ] Success, nonzero-exit and missing-binary envelopes are byte-compatible with today's.
- [ ] `gh` can never block waiting on terminal input.
- [ ] `HARNESS_GH_TIMEOUT_MS` is clamped and documented; `git diff --check` passes; file scope respected; index row updated.

## STOP conditions

Stop if a timeout cannot be detected from `spawnSync`'s response on the Bun version in use, if bounding the spawn changes the `gh` argv or the resolved repository, if a slow-but-successful `gh` would now be reported as a failure in a way that corrupts the draft, if out-of-scope changes appear necessary, or after two failed gate attempts.

## Maintenance notes

A timeout means "we do not know whether GitHub filed it", so the failure path must stay conservative: the draft stays `mock-draft` and re-running is safe. Keep that invariant true — if plan 007's dedupe ever keys on an uncertain state, revisit this plan first. Deferred: retries with backoff and a pre-flight `gh auth status` probe.
