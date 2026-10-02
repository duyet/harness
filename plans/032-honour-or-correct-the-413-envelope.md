# Plan 032: Honour or correct the documented 413 JSON envelope (residual of plan 014 / README contract)

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 23f7471..HEAD -- src/gateway.ts src/static/chat.html README.md tests/gateway-*.test.ts`
> If oversize POSTs already receive `{ ok:false, error:"request body exceeds …" }` with status 413 **or** the README no longer promises that envelope, STOP and report.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW — option (a) changes the oversize fast path; option (b) is docs-only
- **Depends on:** `plans/014-cap-unbounded-ingress-fields.md` (shipped — introduced the 256 KB ceiling), `plans/004-validate-gateway-json.md` / `plans/025-answer-hostile-input-with-json-envelope.md` (envelope family)
- **Category:** bug / contract
- **Confidence:** HIGH (reproduced 2026-10-02 against `23f7471`)
- **Planned at:** commit `23f7471`, 2026-10-02 (Run 6)

## Why this matters

`README.md:159` promises:

> A request body over 256 KB is refused before any of this with **413** and the same `{ "ok": false, "error": "request body exceeds 262144 bytes" }` envelope.

That envelope is never sent for the common case. `Bun.serve`'s `maxRequestBodySize: INGRESS_REQUEST_MAX_BYTES` (`src/gateway.ts:858`) matches the ceiling and rejects first with a **bodiless** 413, so `payloadTooLarge()` (`src/gateway.ts:551`) — whose only two call sites are inside `parseJsonObject` (`src/gateway.ts:629,632`) — is unreachable whenever the client declares `Content-Length` over the limit (the path every ordinary `fetch`/`curl -d @file` takes).

**Knock-on in the static page.** `src/static/chat.html:65` is `const j = await r.json();` with no `try`/`catch` (unlike `refresh()` at `:39-49`). A bodiless 413 rejects that promise, so a >256 KB paste renders the user's bubble with **no reply and no error** — a silent failure in the one surface a human watches. Contract-and-dx; no security impact.

This is the same family as plan 025 (documented JSON envelope vs what the wire actually carries), one status code over.

## Current state

```ts
// src/gateway.ts:551 — written, almost never reached for Content-Length oversize
function payloadTooLarge(): Response {
  return Response.json(
    { ok: false, error: `request body exceeds ${INGRESS_REQUEST_MAX_BYTES} bytes` },
    { status: 413 },
  );
}

// src/gateway.ts:858 — Bun rejects first
maxRequestBodySize: INGRESS_REQUEST_MAX_BYTES,

// src/static/chat.html:65 — no try/catch
const j = await r.json();
```

`payloadTooLarge` can still fire for bodies without a usable `Content-Length` that blow the budget inside `readBoundedText`; the documented *ordinary* oversize path never hits it.

## Evidence

```
$ curl -sS -D- -o /tmp/body -X POST localhost:<port>/chat \
    -H 'content-type: application/json' --data-binary @big.json   # >256 KB
HTTP/1.1 413 Request Entity Too Large
… (no JSON body)
$ wc -c /tmp/body   # 0
```

Confirmed against `23f7471` with a real gateway on a high port. `chat.html` then fails `r.json()` and leaves the assistant bubble empty.

## Steps — pick exactly one of (a) or (b); plus the chat.html harden either way

### Option (a) — honour the documented contract

Arrange for the handler (or a Bun error hook) to emit `payloadTooLarge()` for oversize requests, **or** catch the server's 413 and re-emit the JSON envelope. Costs a behavioural change to a fast path; keep `maxRequestBodySize` as a safety net if feasible.

### Option (b) — correct the documentation (default if no preference)

State that oversize requests are refused by the HTTP server with a bodiless 413 before the handler runs; delete `payloadTooLarge()` and its two call sites (or keep them only for the `readBoundedText` path and document that distinction); note the JSON envelope applies only to the shapes the handler does see. S effort, no behaviour change on the Content-Length path.

### Either way — harden `chat.html`

Wrap the `r.json()` in `try`/`catch` (mirror `refresh()`), and on failure show a visible error bubble naming the HTTP status. A bodiless 413 must never look like "the assistant said nothing."

## Tests

- POST >256 KB with `Content-Length` set → assert the chosen contract (JSON envelope under (a), bodiless 413 under (b)) and that it matches README after the edit.
- If (a): mutation-check that removing the re-emit fails the envelope assertion.
- `chat.html`: a non-JSON / empty error response must surface an error string in the UI (fixture or small static-page test if one exists; otherwise a documented manual check in the plan's Acceptance).

## STOP conditions

- Doing both (a) and (b) halfway — pick one contract and make README + code agree.
- Removing `maxRequestBodySize` without a replacement bound — do not weaken the ceiling.
- Touching release-please or herdr-desk.

## Acceptance

- README and the wire agree on what a >256 KB POST returns.
- `chat.html` never silently drops an oversize / non-JSON error.
- 185+ tests green; `bun run typecheck` exit 0.
