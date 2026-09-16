# Plan 003: Preserve the caller's repository context in the background gateway

> **Executor instructions:** This is a plan, not current authorization to implement. After approval, run every gate and honor STOP conditions. Update the index row; no commit, push, issue, remote operation or external-service call.
>
> **Drift check:** `git diff --stat b17bb04..HEAD -- src/cli.ts README.md tests/gateway-context.test.ts tests/fixtures/gateway-context-runner.ts`
> Compare changed files with the excerpts. Unexplained mismatches are a STOP. Baseline-only additions to README's verification section are expected from Plan 001.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW — executable paths are already absolute
- **Depends on:** `plans/001-isolated-test-baseline.md`
- **Category:** bug
- **Confidence:** HIGH (static call-chain verification)
- **Planned at:** commit `b17bb04`, 2026-09-16

## Why this matters

The CLI searches upward from the user's working directory for repo configuration, but background startup changes the gateway child's cwd to the plugin checkout. Ingress therefore ignores a caller repo's configuration and can route using the bundled sample instead. Foreground startup does not change cwd, making the two modes inconsistent. Preserve the caller's context without redesigning the single local gateway.

## Current state

`src/cli.ts:410–416`:

```ts
mkdirSync(STATE_DIR, { recursive: true });
const child = spawn("bun", [join(ROOT, "src", "gateway.ts")], {
  detached: true,
  stdio: "ignore",
  env: { ...process.env },
  cwd: ROOT,
});
```

`src/shared.ts:95–105`:

```ts
let dir = process.cwd();
for (;;) {
  const candidate = join(dir, ".herdr-harness.json");
  if (existsSync(candidate)) return candidate;
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
const example = join(ROOT, "examples", "minimal", ".herdr-harness.json");
```

`src/gateway.ts:97–102` loads config and calls `resolveTask` inside the gateway process. `src/gateway.ts:16` already uses `join(ROOT, "src", "static", "chat.html")` for HTML, so its asset resolution does not require cwd to be ROOT. `README.md:60–65` promises upward config discovery; `README.md:106` says ingress routes in-process, without Herdr spawn.

Conventions: retain Node `spawn` with argv arrays, existing JSON responses and `.ts` import style. `src/cli.ts:411–416` is the process-launch exemplar; only cwd changes. Do not alter stub routing, default-adapter rules, or the fallback config policy.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `bun --version` | supported Bun (audit: 1.4.2) |
| Baseline | `bun run test` | pass before modification |
| Context tests (new) | `bun test tests/gateway-context.test.ts` | all pass |
| Full gate | `bun run test && git diff --check` | exit 0 |

No dependency install or build is required. No existing lint/typecheck configuration exists; do not invent a successful static-analysis gate. The advisor did not run these proposed tests.

## Scope

**Only modify:** `src/cli.ts` (background spawn cwd only), `README.md` (context behavior note only), `tests/gateway-context.test.ts` (new), `tests/fixtures/gateway-context-runner.ts` (new), and this plan's index row.

**Out of scope:** shared config search, gateway HTTP behavior, PID/health/stop logic, multi-repo multiplexing, auth, ports, runtime executable selection, real background gateways, versions, release-please, Herdr operations, other repos, integrations, tokens, crons and remotes.

Temporary files belong only to owned directories under `dist/.test-tmp/` through the baseline fixture helper.

## Git workflow

No automatic branch/worktree, commit, push or PR. Preserve pre-existing work and honor the user's separate authorization boundary for implementation.

## Steps

### Step 1: Build a no-background-process regression harness

Use Plan 001's fixture factory for isolated HOME, cwd and env. `tests/fixtures/gateway-context-runner.ts` runs in a fresh Bun subprocess so mocks cannot leak into other tests. Before dynamically importing `src/cli.ts`, mock `node:child_process` using Bun's built-in `mock.module`. Its fake `spawn` must record argv/options to stdout with an unmistakable prefix and return an object with a positive fake pid and no-op `unref`; it must never launch a process. Stub any other exported child-process functions used by the imported CLI and fail if unexpectedly called. Mock global fetch to return a successful health response so this narrow startup-options test does not wait or contact a server. Set argv to gateway start and run from a nested directory inside the fixture repo.

In the parent test, parse the recorded spawn options. Initially assert the script path is absolute and fixture state is isolated; do not pretend the currently wrong cwd is desired behavior. Ensure tests never use a live PID for the fake child and never invoke gateway stop.

**Verify:** `bun test tests/gateway-context.test.ts` → launch-capture scaffolding passes with zero real spawn/network calls.

### Step 2: Preserve cwd and test actual routing under the captured context

Change the spawn option from `cwd: ROOT` to `cwd: process.cwd()`. Add an assertion that the captured cwd equals the nested caller directory.

Create a fixture config at its parent with a task ID and adapter route unlike the bundled sample. In a second isolated subprocess, import `handleIngress` from the absolute gateway module and execute it with cwd set to the captured child cwd and HOME to the fixture home. Assert that the task and adapter resolve from the fixture config. This exercises actual config discovery and routing while the launch test proves which cwd production startup supplies. Do not call `startGatewayServer`.

Also test direct foreground-equivalent in-process routing from that same cwd, and verify matching task/adapter results. Assert the spawned script still points into ROOT rather than the caller repo.

**Verify:** `bun test tests/gateway-context.test.ts` → caller cwd, nested discovery, foreground parity and absolute executable assertions pass.

### Step 3: Document the singleton boundary and run regressions

Add a concise README note: a newly started gateway uses the launching cwd for repo config discovery; starting again while it is already running does not switch repositories; stop/restart is needed to change context. Do not add multi-repo switching or promise a new API.

**Verify:** `bun run test && git diff --check` → exit 0. `git diff -- src/cli.ts` → only the spawn cwd change for this plan. `git status --short` → scoped changes plus pre-existing authorized work.

## Test plan

Use baseline isolated fixtures and Bun assertions. Cover nested caller directory, fixture task/adapter selection distinct from the example, absolute gateway script path, foreground-equivalent routing parity and zero network/process side effects in the launch harness. Keep mock setup in a dedicated child runner, not the shared test process. These are launch-contract plus routing integration tests, not a claim of end-to-end daemon lifecycle coverage.

## Done criteria

- [ ] `bun test tests/gateway-context.test.ts` and `bun run test` pass.
- [ ] Captured production spawn cwd equals the caller cwd and actual routing under it uses the fixture config.
- [ ] No actual background server or Herdr process is launched in tests.
- [ ] README describes restart-required context switching accurately.
- [ ] `git diff --check` passes, file scope is respected, and index row updated.

## STOP conditions

Stop if Bun mocks cannot intercept the named spawn import before CLI evaluation, if a real subprocess/network launch escapes the fake, if state isolation fails, if config discovery is no longer cwd-based, if the gateway now depends on ROOT cwd for assets, or if gates fail twice. Do not solve test difficulty by starting the real user gateway. Stop on unexplained drift or need for wider production changes.

## Maintenance notes

A global gateway remains bound to one launching context. Multi-repo sessions would require an explicit new design. Keep script/static asset paths anchored to ROOT and config paths anchored to caller context. PID ownership and startup-health correctness remain separately deferred.
