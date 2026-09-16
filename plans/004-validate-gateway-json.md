# Plan 004: Return predictable JSON errors for invalid gateway requests

> **Executor instructions:** Implement only after separate authorization. Run each gate; STOP rather than broadening scope. Update the index row. No commit, push, issues, remotes or live integration calls.
>
> **Drift check:** `git diff --stat b17bb04..HEAD -- src/gateway.ts README.md tests/gateway-input.test.ts tests/fixtures/gateway-input-runner.ts`
> Compare changes with the excerpts. Prior plans' README additions are expected; unexplained production drift is a STOP.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW — success responses remain unchanged
- **Depends on:** `plans/001-isolated-test-baseline.md`
- **Category:** bug / tests
- **Confidence:** HIGH — malformed JSON returned 500 in the advisory probe; shape defects are source-verified
- **Planned at:** commit `b17bb04`, 2026-09-16

## Why this matters

All five POST routes parse JSON without catching parse errors and then cast arbitrary values to objects. Malformed JSON produces HTTP 500 instead of a client error, while valid JSON such as arrays or scalars can be accepted as empty events or fail inside normalization. A small shared boundary should return JSON 400 for invalid input without writing state, while preserving permissive valid stub payloads.

## Current state

`src/gateway.ts:182–185`:

```ts
if (req.method === "POST" && url.pathname === "/chat") {
  const body = (await req.json()) as Record<string, unknown>;
  const result = handleIngress("chat", body);
  return Response.json({
```

The same unchecked parse occurs at `src/gateway.ts:203–220` for Matrix, Telegram, Sentry and Bugsink. `normalizeMatrix` at lines 57–65 casts `content`; `normalizeTelegram` at lines 68–82 casts `message`, `chat`, and `from`. TypeScript casts do not validate JSON.

Existing response convention (`src/gateway.ts:223`):

```ts
return Response.json({ ok: false, error: "not found" }, { status: 404 });
```

Use that style with stable short error strings. Existing `/chat` success is 200; ingress successes are 202. `src/gateway.ts:39–46` persists chat/Matrix/Telegram events, and `src/issues.ts:77–78` writes issue drafts: reject before reaching either.

`README.md:86–106` documents a local gateway stub with no real Matrix/Telegram network, and in-process routing only. Keep empty objects valid for compatibility, permit extra fields and optional missing fields, and do not turn this into a full provider schema or token/auth implementation.

Conventions: dependency-free helpers, named exports only where needed, double quotes, semicolons, two-space indentation and existing `Response.json` envelopes.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `bun --version` | supported Bun; audit used 1.4.2 |
| Baseline | `bun run test` | passing prerequisite tests |
| Focused tests (new) | `bun test tests/gateway-input.test.ts` | all cases pass |
| Full gate | `bun run test && git diff --check` | exit 0 |

No install/build is needed, and no lint/typecheck gate exists at the audited commit. New tests here are proposed, not already executed. The earlier advisory live probe was a constraint violation, not a testing pattern to repeat.

## Scope

**Only modify:** `src/gateway.ts`, `README.md` (error contract paragraph), `tests/gateway-input.test.ts` and `tests/fixtures/gateway-input-runner.ts` (new), plus this index row.

**Out of scope:** CLI ingestion, issue storage encoding, config validation, state repair, UI retry handling, body-size/rate limits, authentication, CORS, binding, daemon lifecycle, integrations, tokens, dependencies, releases, release-please, other repos, cron and remotes.

All test state stays in owned fixtures under `dist/.test-tmp/`. No listening network socket is required.

## Git workflow

Do not create branches/worktrees, commit, push or publish. Preserve unrelated work. Separate implementation authorization is required; this advisory plan itself changes no source.

## Steps

### Step 1: Expose the existing request handler without changing behavior

Move the anonymous `async fetch(req)` function body in `startGatewayServer` into an exported `handleGatewayRequest(req: Request, bind: ReturnType<typeof gatewayBind>): Promise<Response>`. The server's fetch callback delegates to it with its existing bind. Do not move server startup, metadata persistence or `import.meta.main` behavior. Preserve all existing branches and response shapes.

Create an isolated child runner importing only `handleGatewayRequest`, never `startGatewayServer`. Set fixture HOME/cwd before import using `tests/helpers.ts`. Call the handler with synthetic `Request` objects and an explicit local bind. Add happy cases for GET health, HTML at `/` and `/chat`, unknown route 404, chat 200, and all four ingress routes 202. Use benign synthetic payloads and fixture repo config.

**Verify:** `bun test tests/gateway-input.test.ts` → characterization cases pass without binding a socket or writing outside the fixture.

### Step 2: Validate POST bodies before normalization or persistence

Use a small `isRecord` predicate: value is non-null object and not array. A shared async parse helper must distinguish JSON parse failure from shape failure, return a discriminated success/error result, and never catch exceptions from routing/persistence. Invalid JSON returns status 400 with `{ ok: false, error: "invalid JSON" }`; top-level non-object JSON returns status 400 with `{ ok: false, error: "expected JSON object" }`.

For Matrix only, an explicitly non-null `content` must be a record. For Telegram only, an explicitly non-null `message` must be a record; on the selected message object (nested message or raw fallback), explicitly non-null `chat` and `from` must be records. Treat absent/null optional containers as missing, matching current `??` behavior. Wrong nested container types return status 400 with `{ ok: false, error: "invalid payload shape" }`. Do not reject unknown fields, empty objects, missing text, or existing task-id aliases.

Apply the helper to all five POST branches. Do not wrap the entire handler in a catch that labels disk/config errors as bad JSON. Keep GET and unknown-route behavior intact; do not require a new Content-Type contract in this patch.

**Verify:** `bun test tests/gateway-input.test.ts` → malformed/empty JSON and non-object body cases return JSON 400 on all five routes; nested-container cases fail as specified.

### Step 3: Prove rejected input has no persistence effects and document the contract

For invalid-case groups, snapshot the isolated state directory recursively before and after and compare existence, names and contents. Ensure no last-ingress, queue or draft is created/changed. In separate valid cases, check expected persistence and unchanged successful response fields. Include a handler rejection test with an unwritable/invalid state destination inside the fixture to ensure storage failures are not relabeled 400; do not change Bun's server-level 500 handling in this plan.

Document the three short 400 error messages and unchanged success statuses in README. Describe the error response, not provider schema completeness.

**Verify:** `bun test tests/gateway-input.test.ts` and `bun run test` → all pass; `git diff --check` → exit 0; `git status --short` → scope only plus prior work.

## Test plan

Use the prerequisite baseline's subprocess fixture pattern. Cover at least five POST routes × malformed JSON, empty body, null, array and scalar top-level payload; wrong Matrix content and Telegram message/chat/from containers; absent/null optional containers; valid task aliases; 200/202 happy paths; GET HTML/health and 404 preservation; no rejected-request writes; and storage errors not becoming client errors. Table-driven tests may group assertions, but failures must identify route and input class. No actual HTTP server is necessary.

## Done criteria

- [ ] Focused and full Bun suites exit 0.
- [ ] Every invalid POST case returns JSON 400 with the specified envelope.
- [ ] Rejected payloads leave state unchanged; valid payloads retain their response and persistence behavior.
- [ ] Server startup remains guarded; tests do not bind sockets.
- [ ] Storage/config exceptions are not classified as JSON parse errors.
- [ ] README, diff check, scoped file list and index status are complete.

## STOP conditions

Stop if callers rely on top-level scalar/array requests, if handler extraction requires unrelated production edits, if tests bind the real gateway or touch real state, if baseline fixtures are unavailable, on unexplained drift, or after two failed verification attempts. Full provider validation, size limits and UI error recovery require separate scope.

## Maintenance notes

New POST routes should use the same parse/shape boundary. Keep request errors distinct from server/storage errors. If content types or body limits are added later, specify 415/413 semantics separately and test streaming bodies rather than assuming this validation bounds memory use.
