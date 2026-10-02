# Plan 036: Stop `waitHealth` accepting any 2xx as a healthy gateway

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 63937ed..HEAD -- src/cli.ts tests/gateway-pid.test.ts`
> If `waitHealth` already inspects the `/health` response body for this harness's own identity fields, STOP and report.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW
- **Depends on:** `plans/012-verify-gateway-pid-identity.md` (shipped)
- **Category:** bug / contract
- **Confidence:** HIGH (reproduced 2026-10-02 against `63937ed` — `gateway start` returned `ok: true` with a dead gateway)
- **Planned at:** commit `63937ed`, 2026-10-02 (Run 7)

## Why this matters

`harness gateway start` spawns the gateway, writes `gateway.pid` for the child's pid, and then asks a single question:

```ts
// src/cli.ts:1053
async function waitHealth(bind, timeoutMs = 4000) {
  const url = `http://${bind.hostname}:${bind.port}/health`;
  ...
      const r = await fetch(url);
      if (r.ok) return true;          // <-- any 2xx from any process
  ...
}
```

`r.ok` is a status-code check with no body identity check, so **any** process already listening on the port — a previous gateway that did not exit, a dev server, another tool that grabbed 8787, a port-forward — makes the probe succeed. Meanwhile the child this command just spawned has already died from `EADDRINUSE` inside `Bun.serve`, which is thrown *before* `startGatewayServer` writes `gateway.json`. The command therefore reports success, exits 0, and leaves `gateway.pid` pointing at a corpse.

This has been on the deferred list since Run 3, where it was filed as "partly subsumed by plan 012's PID identity". It is not subsumed: plan 012 governs what `gateway stop` is allowed to kill, and it already reports the truth afterwards (`identity: not-running`). Nothing governs what `gateway start` *claims*. The two answers disagree in the same invocation sequence, which is its own contract defect.

It also **manufactures the precondition for [034](../034-tokenize-the-gateway-pid-identity-check.md)**: a start that fails this way leaves a `gateway.pid` with no `gateway.json`, which is exactly the state in which plan 012's `looksLikeGateway` substring becomes the only gate standing between a recycled pid and a killed unrelated process. Do 034 first if both are taken; doing 036 first makes 034's precondition easier to reach.

## Current state

```ts
// src/cli.ts:1104-1112
  const ready = await waitHealth(bind);
  printJson({ ok: ready, pid: child.pid, bind, listening: ready, alreadyRunning: false });
  if (!ready) process.exit(1);
```

The envelope asserts two things that were never established: that *this* `child.pid` is serving, and that the responder is a harness gateway at all. `bind` is `gatewayBind()` — the *requested* bind, not the port anything is actually listening on.

**The `--foreground` twin, same root cause.** `cmdGatewayStart` writes `GATEWAY_PID_FILE` *before* calling `startGatewayServer()`, and nothing catches a bind failure on either path. In `--foreground` there is no `waitHealth` to soften it, so an occupied port produces a raw Bun stack trace out of a command whose entire output contract is JSON:

```
939 |   const server = Bun.serve({
error: Failed to start server. Is port 19191 in use?
      at startGatewayServer (src/gateway.ts:939:22)
      at cmdGatewayStart (src/cli.ts:1087:5)
EXIT=1
--- gateway.pid left behind: 3236439 ---
```

One root — *the pid file is written before the bind is known to have succeeded, and nothing reconciles the two* — produces three different wrong answers: a false `listening: true` on the detached path, a raw stack dump on the foreground path, and a pid file naming a corpse in both. This plan closes all three together.

## Evidence

An unrelated squatter holding the port, answering `200` on `/health` and `500` on everything else, with the real gateway unable to bind:

```
squatter pid=3233801  /health -> 200

--- harness gateway start (the real gateway CANNOT bind 8787) ---
{ "ok": true, "pid": 3233890, "bind": { "hostname": "127.0.0.1", "port": 8787 },
  "listening": true, "alreadyRunning": false }
exit=0

--- gateway.pid points at: ---
3233890
    PID COMMAND                       <- empty: that pid is already dead

--- what gateway status says immediately afterwards ---
{ "ok": true, "listening": false, "pid": 3233890,
  "identity": { "kind": "not-running" }, "reason": "not running" }
```

`start` said `listening: true` and exited 0. `status` said `listening: false`. The pid file was written for a process that never existed as a gateway.

## Steps

1. Give the probe an identity check, not just a status check. `/health` already returns `{ ok, service: "harness-gateway", version, bind }` — assert `service === "harness-gateway"` before returning true. That is the field the route exists to publish.
2. Correlate the answer with the child. `waitHealth` should be told which pid it is waiting for, and `cmdGatewayStart` should additionally confirm the child is still alive across the wait — a child that exits during the probe window is a failure regardless of what answered.
3. On failure, report what is actually on the port and clean up. The current failure path exits 1 but **leaves `gateway.pid` written for the dead child** — on *both* paths, since `cli.ts:1103` and `cli.ts:1086` both write before the readiness check. Either unlink it on the failure branch (the same recovery `cmdGatewayStop` already performs for a recycled pid) or say plainly in the envelope that the pid file was left behind. Leaving it silently is the part that makes the next `gateway stop` operate on a pid nobody started — and it is also what manufactures [034](../034-tokenize-the-gateway-pid-identity-check.md)'s precondition.
4. Catch the bind failure on the `--foreground` path and answer in the same JSON envelope as every other command, naming the port. A raw `Failed to start server` stack trace is the one output shape this CLI does not have, and it is the one an operator is most likely to hit.
5. Surface the conflict in the error message. "port already in use" with the other listener's identity is the difference between a two-minute fix and a debugging session.

## Tests

- **The squatter case, end to end:** a real listener on the port returning `200 {"squatter":true}` on `/health`; assert `gateway start` exits nonzero, that `listening` is not `true`, and that the envelope names the conflict.
- A listener returning `200` with a JSON body that is not an object, and one returning `200` with no body at all — both must fail, since a non-JSON body is not this gateway.
- A listener returning `200` with `service: "harness-gateway"` from a *different* version — decide and assert the intended answer; matching on `service` alone is the minimum, and pinning `version` too would break a legitimate restart across an upgrade.
- **The happy path must not regress:** a real `gateway start` still reports `listening: true`, exits 0, and `gateway status` agrees. Assert the pid in the envelope is the live gateway.
- A child that exits mid-wait (kill the spawned child inside the probe window) must fail even if something on the port answers 200.
- **The `--foreground` twin:** with the port occupied, assert `gateway start --foreground` answers the documented JSON envelope naming the port, exits nonzero, and does **not** leave a `gateway.pid` behind. Assert the raw stack-trace shape is gone.
- A squatter returning **404** on `/health` must still fail with a correct exit status, and the pid file must be reconciled on that path too — a status-code check alone is what the current code already gets right, and the fix must not regress it.
- Assert the pid file is either removed or explicitly reported on the failure path — a test that only checks the exit code misses the part that reaches `gateway stop`.
- One mutation-check: restore `if (r.ok) return true` and confirm the squatter case fails.

## Gates

- `bun test` green; `bun run typecheck` exit 0.
- `src/gateway.ts` untouched — the `/health` route is already correct and this is about how the CLI reads it.

## STOP conditions

- **Do not** add a `net.connect`/port-ownership probe or attempt to identify the squatter's process. Naming the conflict in the message is enough; identifying someone else's process is not this tool's job.
- **Do not** change what `/health` returns or add authentication to it. The route is documented as unauthenticated and plan 029/017's projections deliberately kept the read side open; this plan only reads it more carefully.
- **Do not** make `gateway start` kill or evict whatever holds the port. Refusing and saying so is the correct behaviour.
- **Do not** bundle 034's tokenizer fix. Independent functions, independent tests; merging them makes a red test ambiguous.

## Acceptance

- A 2xx from a process that is not a harness gateway never makes `gateway start` report `listening: true`.
- `gateway start --foreground` on an occupied port answers JSON, not a Bun stack trace.
- A failed start leaves the state directory in a state `gateway stop` can act on safely, and says which state that is.
- A real start still succeeds, and `start` and `status` agree.
- 202+ tests green; `bun run typecheck` exit 0.
