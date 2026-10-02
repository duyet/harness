# Plan 027: Hold `/chat` summary pickup to the same bind check as execute

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat cba1548..HEAD -- src/gateway.ts README.md tests/gateway-chat-auth.test.ts`
> If pickup is already gated on bind/Origin, STOP and report.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW–MED — pickup is opt-in per request and has no in-repo consumer
- **Depends on:** `plans/008-gate-chat-execute.md` (shipped), `plans/017-project-status-last-delivery.md` (shipped)
- **Category:** security / consistency
- **Confidence:** HIGH on the mechanism (reproduced); MED on significance — see "Why this matters"
- **Planned at:** commit `cba1548`, 2026-10-02 (Run 5)

## What this plan does *not* claim

The README states a deliberate, accepted decision (`README.md:163`):

> Stub mode (no `execute`) still works on any bind — the gate only applies to execution.

A Run 5 audit pass checked this plan against that line and correctly concluded that a general "gate ingress on loopback" proposal would re-litigate a documented choice. This plan does not do that. Stub replies echo the caller's own message back to the caller; that stays as documented.

This plan is narrower and is about one field.

## Why this matters

`POST /chat` has one response path that returns **stored operator state the caller did not send**: the summary pickup.

```ts
if (reply.mode === "stub" && chatPickupRequested(parsed.body, url, result.task.text)) {
  const delivery = lastDelivery();
  body.lastSummary = delivery ? { at: delivery.at, excerpt: delivery.excerpt } : null;
  if (delivery) {
    body.reply = `${reply.reply}\n\nlast summary (${delivery.at}):\n${delivery.excerpt}`;
  }
}
```

It is ungated. So on the very configuration where the execute gate is doing its job, the gate refuses the spawn — and the same request still receives the data:

```
=== A) execute on a NON-loopback bind (plan 008 gate) ===
mode    : stub
refusal : execute refused: bind 0.0.0.0 is not a loopback address. /chat is
          unauthenticated by design and must not be exposed to an untrusted
          network — bind loopback with HARNESS_GATEWAY_HOST, or set
          HARNESS_CHAT_ALLOW_REMOTE=1 to opt in.

=== B) pickup on the SAME bind ===
mode         : stub
executeError : execute refused: bind 0.0.0.0 is not a loopback address. ...
lastSummary  : {"at": "2026-10-02T13:02:37.680Z", "excerpt": "# harness daily
                summary (on-demand)\n\nGene
reply        : stub: freeform via grok-build — /summary |  | last summary
                (2026-10-02T13:02:37...
```

The refusal text states the threat model — *"must not be exposed to an untrusted network"* — and then hands the unauthenticated caller the report anyway in the same response. That is the specific incoherence worth fixing.

The payload is the operator's own summary, capped at 600 characters on write: version, session id, `lastPicked`, playbook ids, and issue-draft fingerprints/titles/timestamps. A fuller report also carries the last-delivery absolute path (visible in the markdown body) and the gateway pid. None of it is a secret from a third party, and reaching it requires opting into a non-loopback bind — so this is a MED, not a HIGH.

It also partly undoes plan 017. That plan removed absolute paths from unauthenticated `GET /status` because they embed the OS username; `/chat` pickup is the remaining unauthenticated path to the same excerpt.

## Current state

- `chatExecuteGate`, `src/gateway.ts:399-434` — loopback + Origin + kind checks, but it gates **only execution**
- `chatReply`, `src/gateway.ts:441-489` — returns a stub with `executeError` when the gate refuses, which is correct and should stay
- `handleGatewayRequest`, `src/gateway.ts:710-718` — applies pickup to any stub reply, including a gate-refused one, with no bind/Origin check

`chatOriginAllowed` and `isLoopbackHostname` already exist and are already tested (`tests/gateway-chat-auth.test.ts`); this plan reuses them rather than adding new policy.

## Evidence

Reproduced 2026-10-02 at `cba1548`, isolated `HOME`, gateway started with `HARNESS_GATEWAY_HOST=0.0.0.0 HARNESS_GATEWAY_PORT=8901 HARNESS_CHAT_EXECUTE=1`. Transcript in the block above: execute is refused on the non-loopback bind and the pickup excerpt is returned in the same response.

The excerpt is real operator state, not a stub — from a stored `last-delivery.json`:

```
# harness daily summary (on-demand)
Generated: 2026-10-02T13:09:00.321Z
Version: 0.0.0.6
## Session
- started: false at —
- sessionId: —
- lastPicked: demo (task)
## Playbooks
- `desk:sentry-issues` Sentry/Bugsink error events → mock GitHub issue drafts …
## Issue drafts (6)
- 2026-10-02T13:03:49.432Z `ZZZZ…` …
```

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Prerequisite | `bun test` | 169 green |
| New gate | `bun test tests/gateway-chat-auth.test.ts` | pass |
| Full gate | `bun test && git diff --check` | exit 0 |

## Scope

**Only modify:**
- `src/gateway.ts` — gate the pickup branch on the same bind (and optionally Origin) conditions
- `tests/gateway-chat-auth.test.ts` — the new cases
- `README.md` — one sentence stating pickup is covered by the bind check
- `plans/README.md` status row

**Out of scope:**
- Gating stub replies or ingress generally (`README.md:163` — accepted decision)
- Auth on ingress (direction-only; see README)
- `projectDelivery` / `/status` (plan 017 shipped it)
- The execute gate's shape, release-please, herdr-desk, other repos

## Steps

### Step 1: Gate pickup on bind

Reuse the exact loopback condition the execute gate uses, including the same `HARNESS_CHAT_ALLOW_REMOTE=1` escape hatch, so a deliberate remote opt-in keeps working:

```ts
// Pickup returns stored operator state the caller did not send — unlike a stub
// reply, which echoes the caller's own text back. Hold it to the same bind
// condition as execute, so a request the gate refuses is not also handed the
// report on the same bind.
const pickupAllowed = isLoopbackHostname(bind.hostname) || chatEnvEnabled(CHAT_ALLOW_REMOTE_ENV);
```

When it is not allowed, return the normal stub reply **without** `lastSummary` and without appending the excerpt — silently omitting is right here, because the reply is already a stub and an operator on loopback (the default, and the only bind where this changes nothing) is unaffected.

### Step 2: Decide on the Origin check

`chatOriginAllowed` is a browser cross-origin guard and is the *wrong* tool for this — an absent Origin must keep working for curl and for the chat page served from the gateway itself. The bind condition is the correct one. **Do not add an Origin requirement to pickup.**

### Step 3: Regression

- Loopback bind + pickup → `lastSummary` present (unchanged; this is the default and must not regress)
- Non-loopback bind + pickup, no `HARNESS_CHAT_ALLOW_REMOTE` → no `lastSummary`, excerpt absent from `reply`, still `200 ok:true` and `mode:"stub"`
- Non-loopback bind + `HARNESS_CHAT_ALLOW_REMOTE=1` → unchanged behavior
- The chat page still works (it posts to a loopback gateway)

### Step 4: Update the README

`README.md:163` currently says the gate "only applies to execution". Update it to note that summary pickup is covered by the same bind check, since it returns stored state rather than an echo. Keep the "stub mode still works on any bind" sentence — that remains true.

## Done criteria

- [ ] A non-loopback bind without `HARNESS_CHAT_ALLOW_REMOTE` never returns the summary excerpt
- [ ] Loopback behavior is byte-identical to before
- [ ] The gate-refused response no longer carries stored state
- [ ] `bun test` exit 0; `plans/README.md` row → DONE when executed

## STOP conditions

- The chat page turns out to depend on pickup over a non-loopback bind — surface it; that would mean the plan needs a different fix, not a weaker gate.
- This turns out to need auth rather than a bind check — record it in the README's direction notes and stop.