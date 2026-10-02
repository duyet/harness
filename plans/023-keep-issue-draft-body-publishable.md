# Plan 023: Keep every issue draft inside the OS single-argument limit (residual of plan 015)

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat cba1548..HEAD -- src/issues.ts tests/issues-bounds.test.ts`
> If `buildDraft` already caps the `Fingerprint:` header line **and** measures `ISSUE_PAYLOAD_MAX_BYTES` against the serialization it actually embeds, STOP and report.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW — draft identity is already derived through `storageKeyFor`, and `pick`/projection consumers only need a stable, comparable string
- **Depends on:** `plans/015-bound-issue-draft-directory.md` (shipped)
- **Category:** security / data integrity
- **Confidence:** HIGH (both vectors reproduced 2026-10-02 against `cba1548`; transcripts in "Evidence")
- **Planned at:** commit `cba1548`, 2026-10-02 (Run 5)

## Why this matters

Plan 015 established an explicit invariant, in the comment at `src/issues.ts:306-313`:

> The payload cap … must sit *below* the OS limit on a single argument, because `gh issue create` takes the whole body as one argv element and Linux caps that at MAX_ARG_STRLEN … **so a draft inside the cap is always publishable.**

Two independent holes break it. Both are reachable from a single unauthenticated POST, both land on `E2BIG`, and in both the resulting draft looks clean.

### Vector A — the fingerprint escapes every bound

`buildDraft` bounds three of its four caller-controlled header fields — `culprit`, `project`, `level`, all through `capHeader` — but **not** the fingerprint, which `fingerprintFor` returns verbatim:

```ts
export function fingerprintFor(raw: Record<string, unknown>): string {   // src/issues.ts:35
  const id = str(raw.event_id) || str(raw.eventId) || str(raw.id);
  if (id) return id;                                     // <-- uncapped
  ...
}
```

```ts
`Fingerprint: ${fingerprint}`,                            // src/issues.ts:98
```

An `event_id` (or `eventId`, or `id`) above roughly **70 KB** produces a body past both the 96 KiB payload cap and the ~131 KB OS limit. The whole event is under the payload cap throughout, so it never looks "oversized" to an operator.

### Vector B — the cap measures one serialization, the body embeds another

```ts
// src/issues.ts:84-91
const serialized = JSON.stringify(raw);                            // compact
const payloadBytes = Buffer.byteLength(serialized, "utf8");
const truncated = payloadBytes > ISSUE_PAYLOAD_MAX_BYTES;          // measured on compact
const payload = truncated
  ? bytePrefix(serialized, ISSUE_PAYLOAD_MAX_BYTES)
  : JSON.stringify(raw, null, 2);                                  // embeds PRETTY
```

The branch that **is not** truncated embeds the 2-space-indented form, which is 2-3x larger than the compact form the cap just measured. Indentation is the entire difference.

```ts
const payload = truncated
  ? bytePrefix(serialized, ISSUE_PAYLOAD_MAX_BYTES)
  : bytePrefix(JSON.stringify(raw, null, 2), ISSUE_PAYLOAD_MAX_BYTES);
```

bounds the string actually embedded, so the flag and the bytes now describe the real body.

Vector B is the more insidious of the two: because the *compact* form passed the cap, the draft carries **no truncation flag at all**. `bodyTruncated` is absent, so there is no visible signal that anything was unusual.

## Current state

The body assembly, `src/issues.ts:93-106` — every line except `Fingerprint` is already bounded:

```ts
const culprit = capHeader(str(raw.culprit) || str(raw.transaction) || str(raw.logger) || "");
const project = capHeader(str(raw.project) || str(raw.project_name) || "unknown");
const level   = capHeader(str(raw.level) || "error");
...
const body = [
  `Playbook: ${PLAYBOOK_SENTRY}`,
  `Source: ${source} (${sourceNote})`,
  `Project: ${project}`,
  `Level: ${level}`,
  culprit ? `Culprit: ${culprit}` : null,
  `Fingerprint: ${fingerprint}`,        // <-- the one unbounded line
  "",
  "```json",
  payload,
  "```",
].filter(Boolean).join("\n");
```

### Why the shipped test does not catch either vector

`tests/issues-bounds.test.ts:46-52` asserts the exact invariant that is breakable:

```ts
test("an oversized payload is truncated, flagged, and stored inside the cap", () => {
  expect(detail.serializedBytes).toBeGreaterThan(96 * 1024);
  // The issue body gh would receive stays under the OS single-argv limit.
  expect(detail.bodyBytes).toBeLessThan(128 * 1024);
```

Its fixture oversizes the payload with a `stack` field — which *is* capped — and always uses a short `event_id`:

```ts
function bigEvent(id: string, fillerKb: number) {
  return {
    event_id: id,                       // always "bound-ordinary-1", etc.
    ...
    stack: `${"x".repeat(fillerKb * 1024)}${MARKER}${TAIL}`,
  };
}
```

So the test proves the invariant *for the input space its fixture wrote*, not for the input space the endpoint accepts. It cannot see Vector A (the id is always short) or Vector B (indentation only inflates when there is structure to indent — a long flat `stack` string inflates by almost nothing). Closing that gap is part of this plan.

## Evidence

Reproduced 2026-10-02 at `cba1548` with an isolated `HOME` fixture, a scratch repo holding `.herdr-harness.json`, and a fake `gh` on a restricted `PATH`.

**Vector A, via the unauthenticated HTTP route** (`POST /ingress/sentry`, no auth of any kind):

```
=== UNAUTHENTICATED POST /ingress/sentry with a 200KB event_id ===
HTTP status: 202
fingerprint len: 200000
bodyTruncated  : True
-rw-r--r-- 1 box box 797272 ... issues/sentry-~73500ae1bd0...4102006d5d02.json
```

Publish attempt (`posix_spawn` rejects the argv before exec, so this fires regardless of what `gh` is):

```
ok    : False
ERROR : gh issue create argument list too long (E2BIG): the issue body is 298452
        bytes, past the OS limit on a single argument (~128 KiB on Linux).
        Draft payloads are capped at 98304 bytes, so this is a draft stored
        before that cap — re-ingest the event to rebuild it, or shorten the body.
CLI exit status: 1
```

The error text is **self-refuting**: the draft was created seconds earlier with the cap active, and re-ingesting rebuilds the byte-identical broken draft.

Body size vs `event_id` size — the event stays under the 96 KiB payload cap throughout:

```
event_id=  40 KB -> body   82114 bytes  ok
event_id=  60 KB -> body  123074 bytes  ok
event_id=  80 KB -> body  164034 bytes  E2BIG (>131072)
event_id= 100 KB -> body  200837 bytes  E2BIG (>131072)
event_id= 130 KB -> body  231557 bytes  E2BIG (>131072)
```

`id` is an equally good vector — `{"id":"Z"*150000,"message":"boom"}` → body 248,437 bytes.

**Vector B**, no oversized id at all — `{"event_id":"pretty-1","message":"boom","crumbs":[{"a":1}]*6554}`:

```
=== dry-run: body size vs caps ===
  draft.body bytes        : 170612
  bodyTruncated (says cut): None          <-- NO truncation flag at all

=== publish attempt ===
  ok: False
  error: gh issue create argument list too long (E2BIG): the issue body is 170609
         bytes, past the OS limit on a single argument (~128 KiB on Linux).
```

The measurement that produced it:

```
compact bytes (what the cap measures):   52461  <= 98304? True
pretty  bytes (what argv gets)      :  170445  > 131072? True
```

A 52 KB event — comfortably inside the request ceiling and inside the documented cap — yields a body 62% over the OS limit, with nothing in the draft saying so.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Prerequisite | `bun test` | 169 green |
| New gate | `bun test tests/issues-bounds.test.ts` | pass |
| Full gate | `bun test && git diff --check` | exit 0 |

## Scope

**Only modify:**
- `src/issues.ts` — `fingerprintFor` / `buildDraft` (both vectors)
- `tests/issues-bounds.test.ts` and/or `tests/fixtures/issues-bounds-runner.ts` — add both missing fixture shapes
- `plans/README.md` status row

**Out of scope:**
- The `ISSUE_PAYLOAD_MAX_BYTES` value itself (it is correct; both gaps are that a field bypasses or misapplies it)
- The E2BIG branch's wording, except as in Step 3
- The `github-created`-without-URL guard — that is plan 026
- The ingress echo of `fingerprint` in `projectIssueDraft` — that is plan 024
- `src/gateway.ts`, CLI, release-please, herdr-desk, other repos

## Steps

### Step 1: Bound the fingerprint (Vector A)

Apply the established `capHeader` where it enters the body, matching how `culprit` / `project` / `level` are already handled:

```ts
const fingerprintLine = capHeader(fingerprint);
...
`Fingerprint: ${fingerprintLine}`,
```

Alternative: cap inside `fingerprintFor` so every consumer benefits. It is deterministic — the same input always yields the same capped fingerprint, so replay idempotency (plan 007) and `storageKeyFor` keep working — but it changes the `id` and storage key of drafts whose event id is long. Drafts written before this change already cannot be published, so nothing publishable changes identity. Pick one and say which in the commit message. `ISSUE_HEADER_MAX_CHARS` (500) is the natural bound.

### Step 2: Measure the cap against what is embedded (Vector B)

Serialize once, decide truncation from that string, and bound the string actually embedded:

```ts
const payload = bytePrefix(
  truncated ? serialized : JSON.stringify(raw, null, 2),
  ISSUE_PAYLOAD_MAX_BYTES,
);
```

This keeps `bodyTruncated` / `bodyBytes` describing the bytes that end up in the body, which is what those fields claim.

### Step 3 (optional): correct the E2BIG advice

The error text asserts the draft predates the cap. Once Steps 1-2 land that is unreachable for new drafts, but drafts already on disk still hit it, and re-ingesting now *does* rebuild a publishable body — so the advice becomes correct as a side effect. Consider softening the wording so it covers both cases. **Judgment call — see STOP.**

### Step 4: Assert the invariant as a property

Extend the fixture so oversize is produced by an **oversized `event_id`/`eventId`/`id`** *and* by **many small structured keys** (which is what Vector B needs — a long flat string inflates by almost nothing under `indent: 2`). Then assert:

- `Buffer.byteLength(draft.body) < 128 * 1024` for both shapes
- a `github-created` draft can be produced end to end (the recording `gh` is actually reached)
- the existing short-id / long-flat-`stack` fixture still produces a byte-identical body

Assert "the body always fits the argv limit" as a property over a table of shapes, rather than as one more fixture — so the next field added to the header cannot silently reopen it.

## Done criteria

- [ ] No input to `/ingress/sentry` or `/ingress/bugsink` produces a `draft.body` past the OS single-argument limit
- [ ] A draft built from either an oversized `event_id` or a wide structured payload publishes successfully against the recording `gh`
- [ ] Whenever the body *is* cut, the draft says so (`bodyTruncated` / `bodyBytes`) and the numbers describe the embedded body
- [ ] Ordinary (short-id, ordinary-shaped) drafts are byte-identical to before
- [ ] Replay idempotency (plan 007) and directory bounds (plan 015) stay green
- [ ] `bun test` exit 0; `plans/README.md` row → DONE when executed

## STOP conditions

- Capping the fingerprint turns out to break plan 007's replay guard — surface it rather than weakening the guard.
- A legitimate in-repo consumer needs the *full* fingerprint (not a truncated one) for deduplication — surface it before capping.
- Bound 2 turns out to shrink real Sentry/Bugsink alerts below what a report needs — surface it; the right answer then is a different publish strategy (stdin/file), not a looser cap.