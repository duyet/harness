# Plan 030: Carry plan 024's response contract to every POST route (residual of plans 024 + 023)

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 23f7471..HEAD -- src/gateway.ts src/issues.ts tests/gateway-ingress-caps.test.ts tests/issues-bounds.test.ts`
> If `projectIssueDraft` already caps `id`/`fingerprint` with a truncation flag **and** `projectTask` re-flags all four capped fields, STOP and report.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW
- **Depends on:** `plans/024-project-ingress-post-responses.md` (shipped), `plans/014-cap-unbounded-ingress-fields.md` (shipped), `plans/023-keep-issue-draft-body-publishable.md` (shipped)
- **Category:** bug / defense-in-depth
- **Confidence:** HIGH (reproduced 2026-10-02 against `23f7471`; numbers in "Evidence")
- **Planned at:** commit `23f7471`, 2026-10-02 (Run 6)

## Why this matters

Plan 024 projected the ingress POST responses but reached **3 of 5** routes, and re-flags only one of the four capped fields. Two vectors in the same surface; file as one plan.

### Vector A — the two issue routes echo an uncapped `fingerprint`/`id`

`projectTask` was applied to `/chat`, `/ingress/matrix` and `/ingress/telegram`. The two error routes get `projectIssueDraft` instead, and it copies `id` and `fingerprint` verbatim (`src/gateway.ts:749-750`). `fingerprintFor` (`src/issues.ts:38`) returns a caller-supplied `event_id`/`eventId`/`id` **uncapped** — deliberately, since the whole id is the draft's identity (plan 023's comment at `src/issues.ts:90-94`). That decision is right for *storage* and wrong for a *reflection*: 023 bounded the copy that enters the body, but the response re-emits the raw one.

This is a reflection of the caller's own bytes (same framing as 024: dx / defense-in-depth), and the exact "applied to N of M" shape Run 5 found inside 024 itself, one level up.

### Vector B — only `text` is re-flagged on the response surface

`projectTask` (`src/gateway.ts:210`) spreads `...capText(task.text)` and nothing else. The stored event and `GET /status` carry all four truncation flag pairs; the response carries one. A shortened `taskId` (513 chars), `sender` and `channel` arrive with **no** flag, while `textTruncated` sits beside them in the same object.

**Framing precision:** `README.md:155` promises the flags for *"the stored event and `GET /status`"*, and **both keep that promise** — this is not a broken README claim. The response surface falls outside that sentence while not honouring the same section's principle: *"a shortened value is always visibly shortened."* File as consistency/honesty on the response surface, not as a contract violation.

## Current state

```ts
// src/gateway.ts:210 — only text
function projectTask(task) {
  return { ...task, ...capText(task.text) };
}

// src/gateway.ts:749-750 — verbatim id/fingerprint
id: draft.id,
fingerprint: draft.fingerprint,
```

## Evidence

| Route | POST | Response | |
|---|---|---|---|
| `/ingress/sentry` (200 KB `event_id`) | 200,053 B | **400,477 B** | unbounded |
| `/ingress/bugsink` (200 KB `event_id`) | 200,053 B | **400,482 B** | unbounded |
| `/ingress/matrix` (200 KB `taskId`) | 200,041 B | 706 B | capped (024) |
| `/chat` (200 KB `text`) | 200,015 B | 274 B | capped (024) |
| `/ingress/sentry` (200 KB `message`, short id) | 200,015 B | 558 B | control — only the *id* path leaks |

```
POST /ingress/matrix  {content:{body: 5000×x}, taskId: 900×T, sender: 900×S, room_id: 900×C}
  RESPONSE task keys include textTruncated only
    id: 513   text: 201   sender: 201   channel: 201
  STORED event flags: bodyTruncated, channelTruncated, senderTruncated,
                      taskIdTruncated, textTruncated
  GET /status lastEvent: all five flag pairs present
```

Reproduced 2026-10-02 at `23f7471` with isolated `HOME` and a real gateway on a high port. Note also: the test named *"the /ingress/sentry 202 is bounded"* (`tests/issues-bounds.test.ts`) oversizes with a field that *is* capped and so cannot catch Vector A — same "fixture couldn't reach the property" shape Run 5 named for 015/007.

## Steps

1. **Vector A:** cap `id`/`fingerprint` in `projectIssueDraft` through a bound (reuse the `capHeader` / 500-char idea 023 already applies where the fingerprint enters the *body*), and emit a truncation flag so a shortened fingerprint never reads as a real one. Do **not** cap inside `fingerprintFor` — that would break the draft's identity and reopen the 200-char prefix-collapse deferred note the wrong way.
2. **Vector B:** have `handleIngress` return the other three capped fields' flags alongside the task, and have `projectTask` apply all four through **one list** — not four ad-hoc spreads, so the next capped field cannot reopen it.
3. Ordinary (uncut) responses must stay **byte-identical** to before; 024 established that constraint and the property test that holds it.

Pairs naturally with 029 (same function, same file) — do them together if an executor takes both.

## Tests

- Table of oversized `event_id` on both error routes → response size bounded; truncation flag present; storage fingerprint still the full id.
- Table of oversized `taskId`/`sender`/`channel`/`text` on matrix/telegram/chat → response carries the matching `*Truncated` / `*Bytes` flags.
- Uncut shapes stay byte-identical to the pre-change response (property over a table).
- Mutation-check: force the fingerprint cap off / drop one flag from the list and confirm the matching test fails.
- Optionally tighten the existing *"202 is bounded"* test so its fixture uses an uncapped field (the `event_id` branch), so it can no longer pass vacuously.

## STOP conditions

- Capping inside `fingerprintFor` — breaks draft identity; stop and re-read Step 1.
- Changing the stored-event / `/status` flag contract — out of scope; those already keep the README promise.
- Treating this as a disclosure / adding auth — it is a reflection; keep the 024 framing.

## Acceptance

- All five POST routes return bounded projections; shortened fields are visibly shortened.
- Uncut responses byte-identical to before.
- Draft identity (`draft.fingerprint` on disk) unchanged.
- 185+ tests green; `bun run typecheck` exit 0.
