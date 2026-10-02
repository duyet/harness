# Plan 039: Settle `invokeAdapter` on the timer, not on stdio EOF

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 63937ed..HEAD -- src/chat.ts tests/gateway-chat-auth.test.ts tests/gateway-chat.test.ts README.md`
> If `invokeAdapter` already resolves its promise from the timeout path independently of the child's `close` event — e.g. a race between the timer and `close`, or a `detached` process-group kill — STOP and report.

## Status

- **Priority:** P0
- **Effort:** S–M
- **Risk:** MED
- **Depends on:** `plans/008-gate-chat-execute.md` (shipped), `plans/009-bound-gh-timeout.md` (shipped), `plans/013-bound-herdr-subprocesses.md` (shipped)
- **Category:** bug / hang
- **Confidence:** HIGH (reproduced 2026-10-02 against `63937ed`; independently surfaced by a Run 7 audit agent and re-verified)
- **Planned at:** commit `63937ed`, 2026-10-02 (Run 7)

## Why this matters

`/chat` documents itself as unable to hang:

> `README.md:157` — *"Any gate refusal or invoke failure still returns `ok:true` with `mode:"stub"` and an `executeError` field — **the chat endpoint never hangs or 500s on adapters**."*

The timeout is real but it does not bound the request. `invokeAdapter` settles its promise from exactly one place — the child's `close` event:

```ts
// src/chat.ts:138-145
const timer = setTimeout(() => {
  timedOut = true;
  try { child.kill("SIGKILL"); } catch { /* already exited */ }
}, timeoutMs);
...
// src/chat.ts:162
child.on("close", (code) => { ... finish(...) });
```

`spawn` uses `stdio: ["ignore","pipe","pipe"]` (`src/chat.ts:114`), so **any** grandchild inherits fds 1 and 2. When the timer SIGKILLs the direct child, the pipe is still held open by the grandchild, so the pipe never reaches EOF, `close` never fires, `finish` is never called and `resolve` never runs. The promise settles when the *grandchild* happens to exit — or never.

A real agent CLI that backgrounds anything trips this, and `NONINTERACTIVE_ARGS` (`src/chat.ts:18-24`) is a list of exactly those CLIs. `HARNESS_CHAT_EXECUTE=1` is process-wide, so on a loopback bind with a builtin default adapter, **every** unauthenticated `POST /chat` reaches this path.

**This is the "chat adapter grandchild kill" item deferred from Runs 3, 4, 5 and 6, and reproduction shows the note understated it by a factor of one failure mode.** The deferred item reads *"SIGKILLs `child` without `detached`/process-group kill, so grandchildren from real agent CLIs can survive"* — that is an orphan-process leak. The actual defect is worse: the **request itself never returns**, and it is a hang on an unauthenticated endpoint, not a leak. Runs 1-6 closed three sibling hang classes (009 at `gh`, 013 at `herdr`, 020 at `issues ingest` stdin); this is the fourth, and the only one still open.

## Current state

```ts
// src/chat.ts:106
export function invokeAdapter(argv: string[], timeoutMs = DEFAULT_CHAT_TIMEOUT_MS): Promise<InvokeResult> {
  return new Promise((resolve) => {
    ...
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code) => { /* the ONLY settle path */ });
  });
}
```

`clearTimeout(timer)` lives inside `finish`, so the timer and the `close` event are already wired to each other — what is missing is a second, independent settle path. Nothing in the function ever resolves without `close`.

## Evidence

A fake adapter that backgrounds a grandchild holding stdout, then exits — the shape of a real agent CLI shelling out. `timeoutMs=1000`:

```
    0ms calling invokeAdapter(argv, timeoutMs=1000)
 2003ms settled=false  grandchild.txt exists=false
 4007ms settled=false  grandchild.txt exists=false
 5001ms settled=false  grandchild.txt exists=false
 6008ms RESOLVED: { timedOut: true, error: "timed out after 1000ms" }
 6008ms settled=true  grandchild.txt exists=true
```

The promise was still unsettled at **5× the timeout**. It resolved at 6008 ms — when the *grandchild* exited and released the pipe — not when the timer fired. The grandchild also survived the SIGKILL and wrote its file.

With a grandchild that never exits, an independent audit agent measured the promise **still unsettled at 20 s** against a 1 s timeout, and end to end on a real `Bun.serve`:

```
$ curl -m 30 -X POST http://127.0.0.1:PORT/chat -d '{"text":"( sleep 600 ) & echo started","execute":true}'
http_code=000 time_total=30.002290s
curl: (28) Operation timed out after 30002 milliseconds with 0 bytes received

### orphans still alive:
3234386      53      30 sleep 600     <-- reparented to init, still running
```

Thirty seconds, zero bytes, no response at all — and the orphaned process tree survives to reparent to init. Bun imposed no idle cap, so the request holds its socket indefinitely. *N* concurrent unauthenticated POSTs are *N* wedged requests and *N* orphaned process trees.

## Steps

1. **Give the timer its own settle path.** When the timer fires, finish the promise from there with the same `timedOut: true` result `close` would have produced. `close` is already idempotent through `settled`, so whichever arrives first wins and the other is a no-op. This alone converts the unbounded hang into a bounded one and is the minimum that makes the README true.
2. **Kill the process group, not the child.** Spawn `detached: true` and signal the group (`process.kill(-child.pid, "SIGKILL")`) so the grandchild dies with the child. Without this the request is bounded but every timed-out execute still leaks a process tree — which is the original deferred finding, and it is what makes step 1 leak instead of clean up.
3. **Do not let step 2 change what an ordinary run does.** A `detached` child is in its own process group and is *not* reaped by the gateway exiting; make sure an ordinary (non-timeout) adapter still resolves on `close` with its real exit code and stdout, and that the gateway's own shutdown is unaffected.
4. Consider `exit` in place of, or raced against, `close`. `close` waits for stdio; `exit` does not. Raced against a short grace period it is the most robust form, but step 1 already makes the timeout authoritative — do not treat step 4 as required.
5. Leave `chatAdapterArgv`, the gate, and the origin/bind checks exactly as they are. This plan is about the subprocess lifecycle, not about who is allowed to reach it.

## Tests

- **The hang case, as a bounded-time assertion.** A fake adapter that backgrounds a never-exiting grandchild: assert the promise settles within a small multiple of `timeoutMs` (say 2×), and that it settles with `timedOut: true`. The current code never settles, so a test that only checks the *result* once it eventually arrives cannot catch this — the assertion has to be about time-to-settle.
- **The group-kill case.** Assert the grandchild is gone after the timeout, by pid — not by "the file was not written eventually". Use a child that would write a file well after the timeout and assert the file never appears within a bounded window.
- **No regression on the happy path:** an adapter that writes to stdout and exits 0 must still resolve on `close` with `ok:true`, its real exit code, and its **full** stdout. Pin the ordinary case as a literal; a fix that resolves on the timer unconditionally would truncate every successful reply.
- A non-zero exit, an adapter that writes to stderr and exits non-zero, and a spawn failure (`ENOENT`) — all three must keep their current shapes and messages.
- An adapter that exits *without ever closing* its stdout within the timeout, to pin step 1 independently of step 2.
- One mutation-check: remove the timer's settle path and confirm the bounded-time test fails by timing out rather than by asserting a wrong value.

## Gates

- `bun test` green; `bun run typecheck` exit 0.
- The new tests must be **time-bounded with a generous CI-safe margin** and must not leak real processes. A test that hangs is worse than the bug; give the fake adapters their own pid bookkeeping and clean up in an `afterAll`.

## STOP conditions

- **Do not** add an overall request timeout to `handleGatewayRequest` as the fix. That bounds the symptom and leaves the orphaned process tree running; the defect is that the subprocess outlives its own timer.
- **Do not** change the gate, the origin check, or the bind check, and do not add a `HARNESS_CHAT_ALLOW_REMOTE`-style opt-out. Those are plans 008 and 027 and they are decided.
- **Do not** treat `HARNESS_CHAT_EXECUTE=1` being process-wide as a defect to fix here. It is documented (`README.md:157`, env table `:185`); what is missing is only that this plan's fix makes it safe to leave on.
- **Do not** raise `MAX_CHAT_TIMEOUT_MS` or lower it as part of this change. The ceiling is not the problem; the timer not being authoritative is.
- **Do not** bundle plan 040's response-projection work, even though both are in `src/chat.ts`. Separate contracts, separate tests; merging them makes a red test ambiguous.

## Acceptance

- An adapter that leaves a grandchild holding stdout can no longer wedge a `/chat` request: the response arrives within a small multiple of the configured timeout, with `timedOut: true` and the existing stub-shaped envelope.
- The grandchild is killed with the direct child, so a timed-out execute leaks no process tree.
- An ordinary successful adapter run is byte-identical to before, including full stdout.
- `README.md:157`'s "never hangs" claim is true.
- 202+ tests green; `bun run typecheck` exit 0.
