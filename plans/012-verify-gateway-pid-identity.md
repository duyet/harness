# Plan 012: Verify the gateway PID still belongs to a harness gateway before signalling it

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat cbc0592..HEAD -- src/cli.ts src/shared.ts src/gateway.ts tests/`
> Compare the changed code against the excerpts below. Plan 011 added the `spawns` listing to `cmdManagerStatus`; it does not touch the PID path, so any change to `readPid`/`pidAlive`/`gatewayListening`/`cmdGatewayStop` is unexpected drift. STOP on unexplained drift.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW — the only behavior that changes is refusing to signal a process that is provably not the harness gateway
- **Depends on:** none (independent of plans 001–011; may reuse plan 001's fixture harness)
- **Category:** bug / dx
- **Confidence:** HIGH (reproduced 2026-10-02 against `cbc0592`; transcript in "Evidence")
- **Planned at:** commit `cbc0592`, 2026-10-02

## Why this matters

`harness gateway stop` reads a PID from `~/.local/state/herdr-harness/gateway.pid` and sends that process `SIGTERM`, then `SIGKILL`. Nothing checks that the process behind that PID is still a harness gateway. The PID file is only unlinked on a clean stop (`src/cli.ts:863-867`), so after a crash, a `kill -9`, a reboot, or a `--foreground` run the user Ctrl-C'd, the file survives — and the operating system eventually recycles that PID to an unrelated process of the same user.

When that happens `harness gateway stop` kills an innocent process, and `harness gateway start` refuses to start a real gateway forever because it believes one is already running (`alreadyRunning` short-circuit at `src/cli.ts:784`). This is the most damaging bug currently in the codebase: the failure mode is destroying unrelated user work, and the recovery requires knowing to hand-edit a state file.

## Current state

The liveness check is a bare `kill(pid, 0)` — "does *any* process have this PID". `src/cli.ts:735-748`:

```ts
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  if (!existsSync(GATEWAY_PID_FILE)) return null;
  const n = Number(readFileSync(GATEWAY_PID_FILE, "utf8").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}
```

`gatewayListening` treats any live PID as the gateway, `src/cli.ts:750-763`:

```ts
function gatewayListening(): { pid: number | null; bind: ReturnType<typeof gatewayBind>; alive: boolean; lastEvent: unknown; lastDelivery: LastDelivery | null } {
  const pid = readPid();
  const alive = pid != null && pidAlive(pid);
  let bind = gatewayBind();
  if (existsSync(GATEWAY_META_FILE)) {
    try {
      const meta = JSON.parse(readFileSync(GATEWAY_META_FILE, "utf8"));
      if (meta.bind) bind = meta.bind;
    } catch {
      /* ignore */
    }
  }
  return { pid, bind, alive, lastEvent: lastIngress(), lastDelivery: lastDelivery() };
}
```

`cmdGatewayStop` signals whatever `readPid` returned, `src/cli.ts:840-869`:

```ts
function cmdGatewayStop() {
  const pid = readPid();
  if (pid == null || !pidAlive(pid)) {
    printJson({ ok: true, stopped: false, reason: "not running" });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) { ... }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && pidAlive(pid)) {
    spawnSync("sleep", ["0.05"]);
  }
  if (pidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
  }
  try { unlinkSync(GATEWAY_PID_FILE); } catch { /* ignore */ }
  printJson({ ok: true, stopped: true, pid });
}
```

There is already a second record that could disambiguate — `GATEWAY_META_FILE` (`gateway.json`), written by the gateway process itself at `src/gateway.ts:548-551`, carries `pid`, `bind` and `version`:

```ts
writeFileSync(
  GATEWAY_META_FILE,
  `${JSON.stringify({ pid: process.pid, bind: { hostname: server.hostname, port: server.port }, version: VERSION }, null, 2)}\n`,
);
```

Nothing ever cross-checks `gateway.pid` against `gateway.json`. Both paths are declared at `src/shared.ts:100-101`:

```ts
export const GATEWAY_PID_FILE = join(STATE_DIR, "gateway.pid");
export const GATEWAY_META_FILE = join(STATE_DIR, "gateway.json");
```

**There is no test coverage for `gateway start`, `gateway stop` or `gateway status`** — verified 2026-10-02: `grep -rl "gateway stop" tests/` returns nothing. This plan adds the coverage along with the fix.

## Evidence

Reproduced 2026-10-02 at `cbc0592` with an isolated `HOME` and a stale PID file pointing at an unrelated `sleep`:

```
stale pid file points at innocent process: 2245444 (sleep)

$ bun src/cli.ts gateway status
{ "ok": true, "listening": true, "pid": 2245444, "bind": {...8787}, ... }

$ bun src/cli.ts gateway stop
{ "ok": true, "stopped": true, "pid": 2245444 }

RESULT: innocent process 2245444 WAS KILLED by 'harness gateway stop'
```

`gateway status` reported a gateway that never existed, and `gateway stop` destroyed an unrelated process.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `bun --version` | supported Bun (audit: 1.4.2) |
| Prerequisite | `bun test` | all 104 existing cases pass |
| New regression gate | `bun test tests/gateway-pid.test.ts` | all cases pass |
| Full gate | `bun test && git diff --check` | exit 0 |

No install or build. Fixtures live only under `dist/.test-tmp/`.

## Suggested executor toolkit

None required. `tests/helpers.ts` (from plan 001) already provides the isolated `HOME`/`PATH` fixture pattern; read it before writing the new test.

## Scope

**Only modify:**
- `src/cli.ts` — `pidAlive`, a new identity helper, `readPid`, `gatewayListening`, `cmdGatewayStart`, `cmdGatewayStop`
- `src/shared.ts` — only if you add a shared `readGatewayMeta()` reader; no other change
- `tests/gateway-pid.test.ts` (new)
- `tests/fixtures/gateway-pid-runner.ts` (new)
- The gateway lifecycle section of `README.md`
- This plan's row in `plans/README.md`

**Out of scope (do NOT touch, even though they look related):**
- `src/gateway.ts` — the gateway is already writing the meta file correctly; do not change the server
- `herdrUsable()` / `herdr` PID checks — the Herdr CLI owns its own processes; unrelated
- The `--foreground` path's PID write, which is already correct
- Any change to how `bind` is resolved, or to the `/status` HTTP route
- Chat/ingress/issue code, dependencies, release-please, other repos

## Git workflow

No branch/worktree creation, commit, push or PR. Preserve unrelated work. Any later implementation needs separate authorization.

## Steps

### Step 1: Add a gateway identity check

Add a helper next to `pidAlive` in `src/cli.ts` that answers "is this PID a harness gateway?" using layered evidence, cheapest first:

1. **PID-file/meta agreement.** Read `GATEWAY_META_FILE`; if it parses and carries a numeric `pid`, require it to equal the PID from `gateway.pid`. A mismatch means the PID file is stale.
2. **Process command line.** On Linux read `/proc/<pid>/cmdline` (NUL-separated); elsewhere fall back to `spawnSync("ps", ["-p", String(pid), "-o", "command="])`. Return true only if the command line mentions the harness gateway entrypoint (`gateway.ts`).
3. **Live health probe (optional third layer).** If a bind is known from `gateway.json`, a `GET /health` returning `service: "harness-gateway"` confirms a gateway is actually serving on that port.

Make step 1 alone sufficient to *refuse*, and let the helper return a discriminated result rather than a bare boolean, so the CLI can explain the refusal:

```ts
type PidIdentity =
  | { kind: "gateway" }
  | { kind: "not-running" }
  | { kind: "recycled"; command: string | null };
```

A missing or unparseable `gateway.json` must NOT be treated as proof of a match — treat it as "cannot verify" and fall through to step 2, and if step 2 also cannot verify, report `recycled`. Erring toward "not ours" is the safe direction: a false refusal is recoverable, a false match destroys an unrelated process.

**Verify:** a unit-level check that a live non-gateway PID returns `{ kind: "recycled" }` and never `{ kind: "gateway" }`.

### Step 2: Route `gatewayListening` through the identity check

Change `gatewayListening` so `alive` reflects a *verified* gateway, and return the identity so callers can explain it. Keep the existing return fields (`pid`, `bind`, `lastEvent`, `lastDelivery`) byte-compatible — `harness gateway status` prints them directly — but add an optional `identity` field so a stale file is visible rather than silent. Report `listening: false` for `recycled`.

**Verify:** `harness gateway status` against a stale PID file now prints `"listening": false` plus a reason naming the mismatch.

### Step 3: Make `cmdGatewayStop` refuse to signal an unverified PID

Before any `process.kill`, resolve the identity:

- `gateway` → behave exactly as today (SIGTERM, 2 s wait, SIGKILL, unlink the PID file).
- `not-running` → today's `{ ok: true, stopped: false, reason: "not running" }`.
- `recycled` → **do not signal.** Print `ok: false` with a reason that names the observed command line and the recorded `gateway.json` PID, and remove the stale `gateway.pid` so the next `gateway start` works. Support an explicit `--force` flag that overrides the refusal and signals anyway, for an operator who knows the PID really is theirs.

The stale-file cleanup is the important half: without it the user stays wedged even though nothing is killed.

**Verify:** against a stale PID file pointing at an unrelated `sleep`, `harness gateway stop` exits 1, the message names the mismatch, and the `sleep` is still running afterwards. With `--force`, the process is signalled.

### Step 4: Fix the `alreadyRunning` short-circuit

`cmdGatewayStart` currently returns `alreadyRunning: true` on `current.alive`. With Step 2 that value is now trustworthy, so a recycled PID no longer blocks startup. Confirm the stale-file branch then proceeds to spawn a real gateway and that `waitHealth` succeeds. No code change is expected here beyond removing any local recomputation of liveness — if you find yourself editing this branch, re-read Step 2 first.

**Verify:** with a stale PID file present, `harness gateway start` starts a gateway and exits 0.

### Step 5: Regression coverage

Create `tests/gateway-pid.test.ts` plus `tests/fixtures/gateway-pid-runner.ts` on plan 001's `tests/helpers.ts`, following `tests/fixtures/gateway-context-runner.ts`. Cases:

1. Characterization: a real gateway running → `gateway status` reports `listening: true` and `gateway stop` stops it (unchanged happy path).
2. Stale PID pointing at a long-lived non-gateway child (`sleep 300`) → `gateway status` reports `listening: false`; `gateway stop` exits 1 and the child is **still alive** afterwards.
3. Stale PID, then `gateway start` → a real gateway comes up and the health endpoint answers.
4. PID file present, `gateway.json` present but holding a different PID → treated as `recycled`.
5. `gateway.json` absent or corrupt → not treated as a match; falls back to the command-line check.
6. `--force` on a recycled PID → the process is signalled (proves the escape hatch works).
7. Truncated/empty/negative `gateway.pid` → `not-running`, no signal, no throw.

Assert the child process is alive or dead explicitly in cases 2, 3 and 6 — that assertion is the regression.

**Verify:** `bun test tests/gateway-pid.test.ts` → all cases pass.

### Step 6: Full regression and boundary check

**Verify:** `bun test && git diff --check` → exit 0 (104 existing cases plus the new file). `git diff -- src/cli.ts` touches only the PID/identity functions. `git status --short` → scoped changes only.

## Test plan

Add `tests/gateway-pid.test.ts` and `tests/fixtures/gateway-pid-runner.ts` in the established isolated-fixture style: temporary `HOME` under `dist/.test-tmp/`, no network beyond loopback, no real gateway left running, child processes reaped. Structure them exactly like `tests/fixtures/gateway-context-runner.ts`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun test` exits 0; the new `tests/gateway-pid.test.ts` passes
- [ ] `harness gateway stop` cannot signal a PID that is not a harness gateway, except with `--force`
- [ ] `harness gateway status` reports `listening: false` for a recycled PID
- [ ] A stale PID file no longer blocks `harness gateway start`
- [ ] Happy path (real gateway) is unchanged: `listening: true`, `stop` exits 0
- [ ] `grep -n "process.kill" src/cli.ts` shows no unguarded signal path
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Verifying process identity is not reliably possible on the target platform with the available primitives, and a weaker check would be guesswork.
- The layered check produces false "not ours" verdicts against a **real, freshly started** gateway — that would break normal operation and must not be papered over.
- The fix appears to require changing `src/gateway.ts`'s server or meta-file format (out of scope; report instead).
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **What a reviewer should scrutinize:** the failure direction. Any code path where "cannot verify" resolves to "safe to signal" reintroduces the original bug. Err toward refusing.
- Adding a field to the `gatewayListening` return type or the `gateway status` JSON changes a machine-readable surface; if `harness status --json` or any external consumer parses it, keep the new fields optional and additive.
- The `--force` flag is an intentional escape hatch and should stay loudly named. If it is ever removed, the refusal becomes terminal for a false negative.
- **Deferred, not in this plan:** `cmdGatewayStop`'s 2-second busy-wait uses `spawnSync("sleep", ["0.05"])` in a loop (`src/cli.ts:852-855`); a bounded await would be cleaner, but that is an unrelated readability change. Gateway-lifecycle coverage for `start`/`stop` beyond the PID question (e.g. port conflicts, double-start races) is also deferred — plan 012 fixes the identity bug, not the whole lifecycle.
