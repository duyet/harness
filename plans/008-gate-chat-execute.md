# Plan 008: Gate `/chat execute` behind a bind check, an origin check and a kind allowlist

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, remotes, or real adapter/LLM execution without separate authorization.
>
> **Drift check (first):** `git diff --stat b96a1ec..HEAD -- src/gateway.ts src/chat.ts src/cli.ts tests/gateway-chat.test.ts`
> Compare changed code against the excerpts below. Plan 004's `parseJsonObject` boundary is expected in `src/gateway.ts`; plan 003's preserved-cwd behavior means the gateway resolves the caller's config. Neither may be reverted. STOP on unexplained drift.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED — execute paths that depend on a non-allowlisted route kind or a non-loopback bind stop working by default; document and provide config/env opt-ins
- **Depends on:** `plans/001-isolated-test-baseline.md`
- **Category:** security
- **Confidence:** HIGH (executed 2026-10-02 against `b96a1ec` through `handleGatewayRequest`; transcript in "Evidence")
- **Planned at:** commit `b96a1ec`, 2026-10-02

## Why this matters

`/chat` with `"execute": true` is the harness running a process on behalf of whoever can reach the port. Three properties compound: the gateway has **no authentication and never inspects the request's remote address**; the binary that gets executed is named by the repository's `.herdr-harness.json`, not by the harness; and a web page in any browser can trigger it cross-origin with a CORS-simple `text/plain` request whose response nobody can read. `manager spawn` gates the same class of decision through `HERDR_AGENT_KINDS`; `/chat execute` has no equivalent. Because plan 003 deliberately preserved the caller's working directory, the config that decides what runs is whatever config sits in the repo the gateway was started in.

## Current state

The opt-in is a single predicate (`src/chat.ts:26-31`):

```ts
export function chatExecuteEnabled(raw: Record<string, unknown>): boolean {
  const field =
    raw.execute === true || raw.execute === "true" || raw.execute === "1";
  const env = /^(1|true|yes|on)$/i.test(process.env[CHAT_EXECUTE_ENV] ?? "");
  return field || env;
}
```

Any caller may set `field`. `chatAdapterArgv` (`src/chat.ts:41-57`) turns the config route into argv, with the route kind as `argv[0]`:

```ts
const kind = route?.kind || adapterId;
const argv = [
  kind,
  ...(route?.via ? [route.via] : []),
  ...(NONINTERACTIVE_ARGS[kind] ?? []),
  ...(route?.model ? ["--model", route.model] : []),
  ...(route?.flags ?? []),
];
```

`invokeAdapter` (`src/chat.ts:68-147`) then runs `spawn(argv[0], argv.slice(1), { stdio: ["ignore","pipe","pipe"] })` — a PATH-resolved binary, no allowlist, no absolute path. The route comes from `findConfigPath()` (`src/shared.ts:173-185`), which walks up from `process.cwd()`, so the repository decides what `kind` names.

`handleGatewayRequest` (`src/gateway.ts:273-342`) routes `POST /chat` with no bind, origin or credential check:

```ts
if (req.method === "POST" && url.pathname === "/chat") {
  const parsed = await parseJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const result = handleIngress("chat", parsed.body);
  const reply = await chatReply(result, parsed.body);
```

`gatewayBind()` (`src/shared.ts:227-231`) accepts `HARNESS_GATEWAY_HOST`, so the same code path serves a LAN-reachable bind with identical protections. For contrast, `agentSpec` (`src/cli.ts:310-327`) only reaches `herdr agent start` when the kind is in `HERDR_AGENT_KINDS`, and otherwise falls back to `pane run`.

## Evidence

Reproduced 2026-10-02 at `b96a1ec` by calling `handleGatewayRequest` directly in a fixture `HOME`:

```
# config in the cwd names the binary
{"adapters":{"default":"attacker-pwned","routes":{"attacker-pwned":{"kind":"attacker-pwned"}}},
 "tasks":[{"id":"t1","adapter":"attacker-pwned"}]}

POST http://evil:8787/chat {"text":"task: t1","execute":true}   bind {hostname:"0.0.0.0"}
-> 200 {"mode":"executed","execute":{"command":["attacker-pwned","task: t1"]}}
exec.log: PWNED argv: task: t1

# cross-origin, loopback bind, CORS-simple content type (no preflight)
POST http://127.0.0.1:8787/chat
  headers: {content-type: text/plain, origin: https://evil.example}
  body:   {"text":"task: t1","execute":true}
-> status 200, access-control-allow-origin: null
exec.log: PWNED argv: task: t1     <-- executed; the reply is unreadable, the side effect is not
```

The attacker chooses the final argument; the repository chooses `argv[0]`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `bun --version` | supported Bun (audit: 1.4.2) |
| Prerequisite | `bun test` | all 72 existing cases pass |
| New regression gate | `bun test tests/gateway-chat-auth.test.ts` | all cases pass |
| Full gate | `bun test && git diff --check` | exit 0 |

No install or build. These tests are proposed, not already run. Fixtures live only in `dist/.test-tmp/`.

## Scope

**Only modify:** `src/chat.ts`, `src/gateway.ts` (execute gate only), `src/shared.ts` (config type additions only), `tests/gateway-chat-auth.test.ts` (new), `tests/fixtures/gateway-chat-auth-runner.ts` (new), README execute-gate documentation, and this plan's row in `plans/README.md`.

**Out of scope:** adding real Matrix/Telegram transports, TLS, user accounts, rate limiting, sandboxing the adapter process, changing stub replies, changing the `execute` request field name or accepted values, changing the non-interactive arg table, manager code, dependencies, release-please, other repos, tokens, crons and remotes.

## Git workflow

No branch/worktree creation, commit, push or PR. Preserve unrelated work. Any later implementation or publication needs separate authorization.

## Steps

### Step 1: Allowlist the executable kind

Keep `chatAdapterArgv` pure. Add a separate predicate in `src/chat.ts`, e.g. `chatKindAllowed(kind, config)`, that admits a route kind when it is either a key of `NONINTERACTIVE_ARGS` (the known non-interactive agent CLIs) or listed in a new optional config field `adapters.chat.executeKinds`. Anything else is denied. `handleGatewayRequest` should then return the existing stub-shaped body with `mode: "stub"`, an `executeError` naming the denied kind and the exact config key to add, and HTTP 200 — matching how other adapter failures are surfaced, so the endpoint still never 500s.

Do not silently fall back to executing an unknown kind. Default deny is the point of this step.

**Verify:** `bun test tests/gateway-chat.test.ts` → all six existing adapter cases still pass (their route kinds are fixture names, so re-point them at allowlisted kinds or set `adapters.chat.executeKinds` in the fixture config).

### Step 2: Refuse execute on a non-loopback bind

In the `/chat` handler, consult the `bind` already passed into `handleGatewayRequest`. When `bind.hostname` is not a loopback address (`127.0.0.1`, `::1`, `localhost`) and execution was requested, refuse with the stub body plus an `executeError` naming `HARNESS_GATEWAY_HOST`, unless `HARNESS_CHAT_ALLOW_REMOTE=1` is set explicitly. Ingress without `execute` stays unchanged on any bind.

Do not change the default `127.0.0.1` in `gatewayBind()`.

**Verify:** `bun test tests/gateway-chat-auth.test.ts` → non-loopback bind refuses execute, loopback still executes.

### Step 3: Reject browser-originated execute requests

Before honoring an execute request, inspect the `Origin` header. If it is present and not in an allowed set (`HARNESS_CHAT_ALLOW_ORIGIN`, comma-separated, defaulting to empty), refuse execute with the same stub body and an `executeError` naming the setting. Absent `Origin` (curl, a local script) is allowed — this is a browser-cross-origin guard, not an authentication system. Do not add CORS response headers.

Note in the refusal text that `/chat` is unauthenticated by design and must not be exposed to an untrusted network; the plan does not add authentication.

**Verify:** `bun test tests/gateway-chat-auth.test.ts` → a foreign `Origin` refuses; no `Origin` still executes on loopback.

### Step 4: Document the gate

Add a short README subsection next to the existing `HARNESS_CHAT_EXECUTE` documentation listing: the kind allowlist and its config key, the loopback requirement, the `Origin` guard, and that reaching `/chat` means reaching the harness's ability to spawn processes. State plainly that the endpoint is unauthenticated.

**Verify:** README diff contains the four items; no other README section changes.

### Step 5: Full regression and boundary check

**Verify:** `bun test && git diff --check` → exit 0. `git diff -- src/gateway.ts` shows only the execute gate and no change to route parsing, status codes or stub replies. `git status --short` → scoped changes only.

## Test plan

Create `tests/gateway-chat-auth.test.ts` plus `tests/fixtures/gateway-chat-auth-runner.ts`, following `tests/fixtures/gateway-chat-runner.ts`: mock adapter binaries in a fixture `bin` that append to a marker file when executed, `PATH` restricted, `Bun.serve`/`fetch` spied to fail loudly, and calls driven through `handleGatewayRequest` with an explicit `bind`. Cases:

1. Allowlisted kind on loopback executes (marker file written).
2. Non-allowlisted kind is refused: no marker file, `mode:"stub"`, `executeError` names the config key.
3. Allowlisted kind listed only via `adapters.chat.executeKinds` executes.
4. `HARNESS_CHAT_EXECUTE=1` alone does not override a denied kind.
5. Non-loopback bind refuses execute; `HARNESS_CHAT_ALLOW_REMOTE=1` re-enables it.
6. Foreign `Origin` on a loopback bind refuses execute; allowed `Origin` and absent `Origin` execute.
7. Plain stub mode (no `execute`) is unaffected in every bind/Origin combination.

No adapter that talks to a network or an LLM may run; fixtures are local shell scripts only.

## Done criteria

- [ ] Focused and full Bun suites exit 0.
- [ ] A route kind outside the allowlist never spawns a process, and the error names the config key that would permit it.
- [ ] Execute is refused when the bind is not loopback unless explicitly opted in.
- [ ] Execute is refused for a foreign `Origin` unless explicitly allowed.
- [ ] All existing stub replies, status codes and adapter argv shapes are unchanged for allowlisted loopback use.
- [ ] README documents the gate; `git diff --check` passes; file scope respected; index row updated.

## STOP conditions

Stop if denying a kind would require changing `chatAdapterArgv`'s output shape, if `handleGatewayRequest` has no reliable access to the bind, if plan 004's JSON 400 boundary would be bypassed, if out-of-scope changes appear necessary, or after two failed gate attempts.

## Maintenance notes

This gate narrows an execution surface, not an authentication system: anyone who can POST to the port can still ingest events and, for allowlisted kinds, run those CLIs. Treat any widening of `executeKinds` as a security review. If real authentication is ever added, it should replace — not sit beside — these checks. Defer: per-user tokens, sandboxing, and an audit log of executed argv.
