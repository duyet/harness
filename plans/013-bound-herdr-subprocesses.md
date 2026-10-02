# Plan 013: Bound every Herdr subprocess with a timeout, and stop shelling out on dry-run paths

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat cbc0592..HEAD -- src/cli.ts tests/manager-spawn-agent.test.ts tests/fixtures/manager-spawn-runner.ts`
> Plan 011 added a `spawns` listing to `cmdManagerStatus` and recovery hints to `cmdManagerSpawn`. It did not change `runHerdr`, `herdrUsable`, or the argv shape. Any change to the recorded Herdr argv or to the order of the three spawn steps is unexpected drift. STOP on unexplained drift.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW — argv, call ordering and JSON envelopes are unchanged; only a new bound and a reordered probe
- **Depends on:** none (independent of 001–011; pairs naturally with `plans/009-bound-gh-timeout.md`)
- **Category:** bug / dx
- **Confidence:** HIGH (reproduced 2026-10-02 against `cbc0592`; transcript in "Evidence")
- **Planned at:** commit `cbc0592`, 2026-10-02

## Why this matters

`harness manager spawn --execute` and `harness manager cleanup --execute` block forever if the `herdr` CLI does not return — a wedged server socket, a subcommand waiting on a prompt, a hung daemon. `spawnSync` is called with no `timeout`, so the operator gets no output, no interrupt path, and (in the spawn case) a worktree that may already be on disk with nothing able to clean it up.

This is the exact failure plan 009 just eliminated for `gh issue create`, and it was left behind because 009 scoped itself to the publish path. The Herdr path has a second, worse variant: **the `herdrUsable()` probe itself is unbounded, and it runs before the dry-run gate.** So `harness manager spawn <taskId>` — with no `--execute`, the documented safe default — can also hang indefinitely. The "default is dry-run" safety property printed at `src/cli.ts:543` does not hold.

## Current state

The single unbounded call behind every Herdr step, `src/cli.ts:422-430`:

```ts
function runHerdr(herdrBin: string, args: string[]): HerdrStep {
  const r = spawnSync(herdrBin, args, { encoding: "utf8" });
  return {
    command: [herdrBin, ...args],
    status: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  };
}
```

`runHerdr` is called from seven sites: `src/cli.ts:460`, `:462`, `:488`, `:494` (cleanup) and `:633`, `:656`, `:678` (spawn).

The unbounded liveness probe, `src/cli.ts:232-249`:

```ts
function herdrUsable(): { ok: boolean; reason: string; bin: string } {
  const bin = herdrBin();
  const sock =
    process.env.HERDR_SOCKET ||
    join(homedir(), ".config", "herdr", "herdr.sock");
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    return {
      ok: false,
      reason: `herdr binary not usable (${bin}): ${probe.error?.message ?? probe.stderr ?? `exit ${probe.status}`}`,
      bin,
    };
  }
  if (!existsSync(sock)) {
    return { ok: false, reason: `no herdr socket at ${sock}`, bin };
  }
  return { ok: true, reason: "herdr binary + socket present", bin };
}
```

**The probe runs before both short-circuits.** In `cmdManagerSpawn` (`src/cli.ts:517-541`):

```ts
function cmdManagerSpawn() {
  ...
  const resolved = resolveTask(taskId);
  const intendedCommands = intendedSpawnCommands(resolved);
  const herdr = herdrUsable();          // <- line 526: unbounded subprocess
  const record = taskId ? loadSpawns().spawns[taskId] : undefined;

  if (resolved.error) {                 // <- line 529: never reached if the probe hangs
    printJson({ ok: false, mode: "dry-run", ... });
    process.exit(1);
  }
  ...
  if (!execute || !herdr.ok) {          // <- line 541: the dry-run gate, also never reached
    const why = !execute
      ? "default is dry-run; pass --execute to attempt herdr worktree create"
      : herdr.reason;
    ...
    return;
  }
```

`cmdManagerCleanup` has the same ordering (`src/cli.ts:702` probe, `:706` gate).

For contrast, the two sibling subprocess paths are already bounded. `src/issues.ts:191-195` (plan 009):

```ts
export function ghTimeoutMs(): number {
  const n = Number(process.env[GH_TIMEOUT_ENV]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GH_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(n), MIN_GH_TIMEOUT_MS), MAX_GH_TIMEOUT_MS);
}
```

and `src/issues.ts:240-249` passes `timeout: timeoutMs`, `stdio: ["ignore","pipe","pipe"]` and `killSignal: "SIGKILL"`.

## Evidence

Reproduced 2026-10-02 at `cbc0592` with a fixture `herdr` that answers `--version` and then never returns, injected via `HERDR_BIN_PATH`:

```
$ timeout -s KILL 12 bun src/cli.ts manager spawn alpha --execute
Killed    (exit 137, elapsed 12s)
RESULT: HUNG — no timeout on runHerdr/spawnSync

$ timeout -s KILL 12 bun src/cli.ts manager cleanup alpha --execute
Killed    (exit 137, elapsed 12s)
```

The same fixture also hangs the **dry-run** path, confirming the probe ordering bug:

```
$ bun src/cli.ts manager spawn alpha --json      # no --execute
... "herdr": { "ok": true, "reason": "herdr binary + socket present" } ...
$ bun src/cli.ts manager spawn alpha --json | grep '"bin"'
"bin": "/tmp/h812-herdr/bin/herdr"      # the probe DID run in dry-run mode
```

With a `herdr` that never returns, that dry-run invocation never returns either.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `bun --version` | supported Bun (audit: 1.4.2) |
| Prerequisite | `bun test` | all 104 existing cases pass |
| New regression gate | `bun test tests/manager-herdr-timeout.test.ts` | all cases pass |
| Full gate | `bun test && git diff --check` | exit 0 |

No install or build. Fixtures live only under `dist/.test-tmp/`.

## Suggested executor toolkit

- **Read `plans/009-bound-gh-timeout.md` first.** It is the shipped exemplar for exactly this shape of change — clamp helper, spawn options, timeout detection, conservative failure path, and its "Implementation notes" section records two Bun-specific gotchas you should not rediscover (the `ETIMEDOUT`/`SIGKILL` detection pair, and that Bun's default `spawnSync` stdio already EOFs the child's stdin).
- `tests/fixtures/manager-spawn-runner.ts` is the existing 16-mode Herdr fixture; add modes to it rather than building a second harness.
- `tests/helpers.ts` (plan 001) provides the isolated `HOME`/`PATH`/`TMPDIR` and the `HERDR_BIN_PATH` / `HERDR_SOCKET` overrides this plan needs.

## Scope

**Only modify:**
- `src/cli.ts` — a `herdrTimeoutMs()` helper, `runHerdr`, `herdrUsable`, and the probe ordering in `cmdManagerSpawn` / `cmdManagerCleanup`
- `tests/manager-herdr-timeout.test.ts` (new)
- `tests/fixtures/manager-spawn-runner.ts` (add fixture modes only; do not change existing ones)
- The manager section of the README's env-var table
- This plan's row in `plans/README.md`

**Out of scope (do NOT touch, even though they look related):**
- `agentSpec`, `intendedSpawnCommands`, `intendedCleanupCommands` and the argv they build — the recorded commands are asserted by `tests/manager-spawn-agent.test.ts` and must not change
- The `tabId`/`paneId`/`workspaceId` parse-and-recover logic added by plan 011
- `executeCleanup`'s success/failure accounting — the idempotency bug there is a separate finding, deliberately not in this plan
- `src/issues.ts` (the `gh` path is already bounded by plan 009), `src/chat.ts` (bounded), `src/gateway.ts`
- `src/shared.ts`'s `gitDescribe()` — also unbounded, but out of the Herdr path and genuinely low-risk; noted in "Maintenance notes" instead
- Any real Herdr invocation, socket, daemon, or workspace. Tests use fixture binaries only.
- Dependencies, release-please, other repos

## Git workflow

No branch/worktree creation, commit, push or PR. Preserve unrelated work. Any later implementation needs separate authorization.

## Steps

### Step 1: Add a clamped Herdr timeout

Add a `HARNESS_HERDR_TIMEOUT_MS` helper mirroring `ghTimeoutMs()` (`src/issues.ts:191-195`). Keep the env name distinct from `HARNESS_CHAT_TIMEOUT_MS` and `HARNESS_GH_TIMEOUT_MS` so the three subprocess budgets stay independently tunable.

Pick the default deliberately and justify it in a comment: Herdr steps are local (worktree/tab/agent ops) but `agent start` can be slow on a cold or loaded machine. A default in the range plan 009 uses for `gh` (60 s) is appropriate; clamp to something like `[1000, 300000]` ms. Export the helper for direct unit testing.

**Verify:** the helper returns the default for unset, non-numeric, zero and negative values, and clamps in both directions.

### Step 2: Bound `runHerdr`

Pass `timeout: herdrTimeoutMs()`, an explicit `stdio: ["ignore", "pipe", "pipe"]`, and `killSignal: "SIGKILL"` so a wedged child actually dies. Extend `HerdrStep` (`src/cli.ts:415-420`) with an **optional** `timedOut?: boolean`; do not add required fields, since `results` is printed verbatim into the JSON envelope and existing consumers read `command`/`status`/`stdout`/`stderr`.

Timeout detection must use the same pair plan 009 settled on, because `spawnSync` reports a timer hit through the error object:

```ts
const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
const timedOut = code === "ETIMEDOUT" || r.signal === "SIGKILL";
```

Treat a timed-out step exactly like any other failure — `status` stays `r.status` (typically `null`), and the caller at `src/cli.ts:635-640` / `:658-664` / `:682-688` already turns a nonzero status into its existing "herdr ... failed" envelope plus a recovery hint. **Do not** invent a new envelope shape; the point of this step is that a wedged CLI becomes an ordinary, already-handled step failure. Add the timeout detail to `stderr` so the operator can see why.

One consequence to handle explicitly: `argvFor(i)` re-renders commands from `intendedSpawnCommands(resolved, ctx)`. A timeout must not disturb that index-based re-rendering.

**Verify:** `bun test tests/manager-herdr-timeout.test.ts` → the hang case returns a normal `ok:false` envelope with a timeout message instead of hanging.

### Step 3: Bound the `herdrUsable()` probe

Apply the same timeout and `killSignal` to the `--version` probe at `src/cli.ts:237`. A wedged probe currently hangs the CLI before it can even report "not usable", which is precisely backwards.

Also note the socket check at `src/cli.ts:245-247`: `existsSync(sock)` only proves a socket *file* exists, so a stale socket left by a crashed `herdr` passes the gate and the next real call wedges. Do not try to fix the socket semantics in this plan — bounding the subprocess is what makes that failure recoverable now. Leave a comment pointing at the limitation.

**Verify:** with a `herdr` fixture that never returns even `--version`, `harness manager spawn <task>` returns promptly with the existing `skippedExecute` text naming the probe failure.

### Step 4: Move the probe after the short-circuits

This is the fix that makes the documented safe default actually safe. In both `cmdManagerSpawn` and `cmdManagerCleanup`, call `herdrUsable()` **after**:
- the `resolved.error` early-exit (`src/cli.ts:529`), and
- the `!execute` dry-run gate.

Both functions need `herdr` for their dry-run JSON output (it is printed as the `herdr` field). Handle this by making the dry-run branch tolerate `herdr` being `null`: emit the same shape with `herdr: null` when the probe was skipped because `--execute` was absent, and probe only on the execute path. The `todo` line at `src/cli.ts:562` already tells the operator to pass `--execute`; extend its wording to note the probe is deferred until then.

**Verify:** `harness manager spawn <unknown-task>` with a wedged `herdr` exits 1 promptly with the `resolved.error` payload, and `harness manager spawn <task>` with no `--execute` returns promptly with the dry-run envelope. Neither spawns anything.

### Step 5: Regression coverage

Create `tests/manager-herdr-timeout.test.ts` on plan 001's `tests/helpers.ts`, following `tests/fixtures/manager-spawn-runner.ts` and the wall-clock discipline of `tests/issues-gh-timeout.test.ts`. Add fixture modes rather than a new harness. Cases:

1. Characterization: every currently-asserted success path still produces byte-identical JSON — reuse the existing `manager-spawn-agent.test.ts` assertions as the reference and confirm `bun test` still passes unchanged.
2. Characterization: `herdr` exiting nonzero on a spawn step still yields the existing `herdr worktree create failed` envelope with its recovery `hint`, and exit 1.
3. `herdr` that never returns on `worktree create`: the CLI returns within the clamp, reports a timeout, exits 1.
4. `herdr` that returns step 1 but hangs on `tab create`: the CLI returns within the clamp and still emits the plan-011 recovery `hint` and `recover` commands.
5. `herdr` that never returns on `--version`: dry-run and both execute paths return promptly.
6. `herdr manager cleanup --execute` against a hanging `herdr`: returns within the clamp, exit 1, and **the spawn record is still on disk** (cleanup failing must not delete the record).
7. `HARNESS_HERDR_TIMEOUT_MS` unset, non-numeric, zero, negative and clamped-high values each produce a working bounded spawn.

Assert wall-clock bounds generously (the test timeout, not the configured value) so the suite is not flaky, and assert no fixture child is left running.

**Verify:** `bun test tests/manager-herdr-timeout.test.ts` → all cases pass.

### Step 6: Full regression and boundary check

**Verify:** `bun test && git diff --check` → exit 0 (104 existing cases plus the new file). `git diff -- src/cli.ts` touches only the timeout helper, `runHerdr`, `herdrUsable`, the `HerdrStep` optional field, and the probe ordering. `git status --short` → scoped changes only.

## Test plan

Add `tests/manager-herdr-timeout.test.ts` plus new modes in `tests/fixtures/manager-spawn-runner.ts`, in the established isolated-fixture style: temporary `HOME` under `dist/.test-tmp/`, `PATH` limited to the fixture bin, `HERDR_BIN_PATH`/`HERDR_SOCKET` pointed at fixtures, no real Herdr, no network, no real worktrees. Every case asserts exit status, JSON envelope, wall-clock bound and final spawn-record state.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun test` exits 0; the new `tests/manager-herdr-timeout.test.ts` passes
- [ ] No `herdr` invocation can hang longer than the configured timeout, on any path
- [ ] `harness manager spawn <task>` **without** `--execute` performs no subprocess at all
- [ ] `harness manager spawn <unknown-task>` performs no subprocess at all
- [ ] All 16 existing `manager-spawn-runner.ts` modes still pass unchanged
- [ ] Recorded Herdr argv is byte-identical (`bun test tests/manager-spawn-agent.test.ts` passes untouched)
- [ ] A failed cleanup still leaves the spawn record on disk
- [ ] `HARNESS_HERDR_TIMEOUT_MS` is clamped and documented; `git diff --check` passes; file scope respected; index row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Timeout detection cannot be confirmed from `spawnSync`'s response on the Bun version in use — re-verify against `plans/009-bound-gh-timeout.md`'s implementation notes before concluding.
- Bounding the spawn changes the recorded Herdr argv, the order of the three spawn steps, or the repository/worktree resolution.
- Moving the probe after the short-circuits cannot preserve the dry-run JSON shape — do not invent a new envelope; report instead.
- A bounded step would now be reported as a failure in a way that deletes a spawn record or orphans a worktree the current code would have handled.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **What a reviewer should scrutinize:** the failure direction on Step 2. A Herdr timeout must land in the existing "step failed" path, never in a path that deletes the spawn record. `executeCleanup` only calls `deleteSpawn` when every recorded step returned 0 (`src/cli.ts:505-506`), so a timeout keeps the record — that invariant is load-bearing and case 6 of the test plan exists to pin it.
- Adding `timedOut` to `HerdrStep` changes a JSON envelope printed in `manager spawn --execute` and `manager cleanup --execute` output. Keep it optional and additive.
- Every future Herdr subcommand added to `runHerdr` is automatically bounded by Step 2. A new call site that bypasses `runHerdr` and calls `spawnSync` directly would reintroduce this bug — the review question to ask on any such diff is "why not `runHerdr`?"
- **Deferred, explicitly not in this plan:** (a) `executeCleanup`'s idempotency bug — a nonzero from `tab close`/`worktree remove` makes `ok` false, skips `deleteSpawn`, and can wedge a task permanently; (b) `cmdGatewayStop`'s `spawnSync("sleep", ["0.05"])` polling loop at `src/cli.ts:852-855`, which shells out to a PATH binary and would silently spin in the restricted-PATH fixtures — `await Bun.sleep(50)` matches `waitHealth` at `src/cli.ts:775` and is the better shape; (c) `gitDescribe()` at `src/shared.ts:92-100`, also an unbounded `spawnSync`, called from `cmdStart` — low risk because `git describe --tags --always` does no network I/O, but worth a timeout if `harness start` is ever on a hot path.
