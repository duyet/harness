# Plan 005: Make executed manager failures return a nonzero CLI status

> **Executor instructions:** Implement only after separate authorization; this run is planning-only. Follow gates and STOP conditions, then update the index row. No commits, pushes, issues, remote access or actual Herdr execution.
>
> **Drift check:** `git diff --stat b17bb04..HEAD -- src/cli.ts tests/manager-exit.test.ts tests/fixtures/manager-exit-runner.ts`
> Compare changed code to the excerpts below. Plan 003 changes gateway cwd elsewhere in this file; that expected change does not alter the manager excerpt. STOP on unexplained drift.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW — fixes shell status while preserving JSON and dry-run behavior
- **Depends on:** `plans/001-isolated-test-baseline.md`
- **Category:** bug / dx
- **Confidence:** HIGH (static control-flow verification)
- **Planned at:** commit `b17bb04`, 2026-09-16

## Why this matters

When `manager spawn --execute` runs a child command that fails, the CLI prints `ok:false` but does not set its own exit status. Scripts relying on shell success can proceed after a failed worktree operation. Propagating failure with exit code 1 makes the machine-readable envelope and process result agree without changing the intentionally permissive dry-run fallback.

## Current state

`src/cli.ts:322–340` collects statuses and prints a result:

```ts
const results = [];
for (const cmd of intendedCommands) {
  const [bin, ...args] = cmd[0] === "herdr" ? [herdr.bin, ...cmd.slice(1)] : cmd;
  const r = spawnSync(bin, args, { encoding: "utf8" });
  results.push({
    command: [bin, ...args],
    status: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  });
}
printJson({
  ok: results.every((r) => r.status === 0),
  mode: "executed",
```

The function ends after this JSON output, with no exit status assignment. By contrast, `cmdManagerRoute` (`src/cli.ts:253–260`) prints `ok:false` and exits 1 on a task-resolution error. `herdrUsable` at lines 207–224 probes `--version` and requires an existing socket path before execution. `cmdManagerSpawn:303–319` intentionally returns an `ok:true` dry-run when execution was not requested or Herdr is unavailable.

`README.md:33` explicitly documents dry-run unless `--execute` and Herdr is usable. `src/cli.ts:339` says tab/agent creation remains a stub. Preserve both decisions.

Conventions: Node argv-array subprocess calls, `printJson` with stable JSON fields, two-space indentation, semicolons and double quotes. Use one computed success boolean for JSON and final exit code; prefer `process.exitCode = 1` after printing so buffered output is not truncated.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `bun --version` | supported Bun (audit: 1.4.2) |
| Prerequisite | `bun run test` | all existing cases pass |
| New regression gate | `bun test tests/manager-exit.test.ts` | all cases pass |
| Full gate | `bun run test && git diff --check` | exit 0 |

No install/build is necessary. The audited repo has no lint/typecheck gate; do not substitute bundling for typechecking. These tests are proposed, not already run.

## Scope

**Only modify:** `src/cli.ts` (executed result success/exit handling only), `tests/manager-exit.test.ts`, `tests/fixtures/manager-exit-runner.ts` (new), and this index row.

**Out of scope:** worktree command construction, dry-run policy, Herdr probes/timeouts, new diagnostic fields, agent spawn, lifecycle/config changes, gateway code, actual Herdr/socket use, dependencies, releases, release-please, other repos, integrations, tokens, crons and remotes.

Test fixtures live exclusively in owned `dist/.test-tmp/` directories.

## Git workflow

No branch/worktree creation, commit, push or PR. Preserve unrelated work. Any later implementation or publication needs separate authorization.

## Steps

### Step 1: Establish an isolated subprocess mock harness

Create `tests/fixtures/manager-exit-runner.ts`. Launch it as a separate Bun child using Plan 001's `tests/helpers.ts` with isolated HOME/cwd/environment. Before dynamically importing `src/cli.ts`, use `mock.module("node:child_process", ...)` to replace `spawnSync`. The mock recognizes only a version probe and the expected worktree argv; unexpected commands fail the test. Stub async spawn to fail if called. Return a successful version result and a per-case simulated execution status. A regular fixture file may satisfy the existing `existsSync` socket probe; do not connect to any socket or create a real worktree. Set `HERDR_BIN_PATH` and `HERDR_SOCKET` to fixture-local placeholders.

Test parent must capture the child runner's real exit code and the CLI's stdout JSON, not merely inspect a mocked success flag. Begin with passing characterization cases: successful executed command, ordinary dry-run, unavailable Herdr with --execute falling back to dry-run, and unknown task exiting 1. Assert no mocked worktree call occurs for dry-run cases; return an invocation record through a fixture-local file, separate from JSON stdout.

**Verify:** `bun test tests/manager-exit.test.ts` → characterization cases pass with zero actual Herdr calls.

### Step 2: Align process success with result success

After collecting results, compute `const ok = results.every((r) => r.status === 0)`. Reuse it in the existing JSON object and set `process.exitCode = 1` if false after printing. Preserve the JSON fields, result order, `mode`, and TODOs. Do not map arbitrary child exit codes directly to the CLI or change dry-run exit semantics.

Add cases simulating nonzero status and null status (spawn failure or signal termination), each asserting complete parseable stdout JSON, `ok:false`, `mode:"executed"`, original result status, and child runner exit 1. Success remains exit 0. The mock may include an Error or signal on its response for realism, but adding new JSON error/signal fields is not part of this fix.

**Verify:** `bun test tests/manager-exit.test.ts` → all success/failure and fallback cases pass.

### Step 3: Run full regression and check boundaries

Run the complete suite and inspect the production diff. The only manager behavior changed should be the shell status after executed failures. An expected gateway cwd change from another plan may coexist, but do not edit it here.

**Verify:** `bun run test && git diff --check` → exit 0. `git diff -- src/cli.ts` → this plan changes only result success computation/exit status. `git status --short` → scoped changes plus existing authorized work.

## Test plan

Use the first baseline test's fixture and subprocess pattern, with module mocks confined to a fresh child. At least six cases: executed success; nonzero result; null result; default dry-run; unavailable-Herdr fallback under --execute; unknown task. Assert both stdout JSON and process exit status and record fake invocation counts. No real executable named Herdr, live socket, network, or worktree operation may run.

## Done criteria

- [ ] Focused and full Bun suites exit 0.
- [ ] Simulated executed nonzero/null statuses yield CLI exit 1 and complete `ok:false` JSON.
- [ ] Executed success and intentional dry-run fallbacks still yield exit 0.
- [ ] Tests confirm worktree execution is never reached on dry-run paths.
- [ ] `git diff --check` passes; file scope respected; index row updated.

## STOP conditions

Stop if mocks fail to intercept the CLI's subprocess import, if real Herdr can be reached, if baseline isolation is missing, if dry-run semantics have changed since planning, if output is truncated with exitCode, if out-of-scope code changes are necessary, or after two failed gate attempts. Excerpt drift in unrelated planned sections is acceptable only after confirming this function's behavior is unchanged.

## Maintenance notes

Future executed commands must feed the same aggregate success boolean. Review both JSON and shell status whenever command errors change. Capturing richer spawn diagnostics and bounding Herdr probes are deferred; do not claim this patch fixes hangs or diagnostic completeness.
