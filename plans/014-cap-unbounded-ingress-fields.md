# Plan 014: Cap the ingress event fields that plan 010 left unbounded

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat cbc0592..HEAD -- src/gateway.ts tests/gateway-state-bounds.test.ts tests/fixtures/gateway-state-bounds-runner.ts`
> This plan extends the helpers introduced by `plans/010-bound-ingress-state.md`. If `INGRESS_BODY_MAX_BYTES`, `capBody`, `capText`, `IngressEvent` or `projectEvent` have changed shape, re-read the "Current state" excerpts below before proceeding. Any drift that removes or renames an existing truncation flag is a STOP condition.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW — only pathological values change; ordinary-length values stay byte-identical
- **Depends on:** `plans/010-bound-ingress-state.md` (shipped)
- **Category:** security
- **Confidence:** HIGH (reproduced 2026-10-02 against `cbc0592`; transcript in "Evidence")
- **Planned at:** commit `cbc0592`, 2026-10-02

## Why this matters

Plan 010 bounded the two fields it thought about — the stored body (4 KB) and the display text (200 chars) — and left three siblings on the same event completely uncapped: `sender`, `channel` and `taskId`. All three are copied verbatim from the request body onto the persisted event, so a **single** unauthenticated POST writes an arbitrarily large file into the state directory, and `GET /status` then ships it back to any caller.

Plan 010's own evidence described the 20 MB-from-60-POSTs scenario. That scenario is still reachable — it just takes one request instead of sixty. The queue's byte budget cannot help either, because `trimQueue` is written to always keep the newest event (`src/gateway.ts:123`), so the single oversized event is the one guaranteed to survive.

The ingress routes are unauthenticated by design and the gateway binds loopback by default, but a browser on the loopback interface can still drive these POSTs, and `HARNESS_GATEWAY_HOST` exists precisely to bind wider. The defense that is documented — "any caller can write to the state directory" (`src/gateway.ts:51-56`) — is the defense that is incomplete.

## Current state

The bounds that exist, `src/gateway.ts:57-60`:

```ts
const INGRESS_BODY_MAX_BYTES = 4 * 1024;
const INGRESS_TEXT_MAX_CHARS = 200;
const INGRESS_QUEUE_MAX_EVENTS = 50;
const INGRESS_QUEUE_MAX_BYTES = 2 * 1024 * 1024;
```

`capText` is the shape to reuse, `src/gateway.ts:103-110`:

```ts
function capText(text: string | null): Pick<IngressEvent, "text" | "textTruncated" | "textBytes"> {
  if (text === null || text.length <= INGRESS_TEXT_MAX_CHARS) return { text };
  return {
    text: `${text.slice(0, INGRESS_TEXT_MAX_CHARS)}…`,
    textTruncated: true,
    textBytes: byteLength(text),
  };
}
```

**The three unbounded fields.** `extractTaskId` returns `raw.taskId` / `raw.task_id` verbatim, `src/gateway.ts:140-146`:

```ts
function extractTaskId(raw: Record<string, unknown>, text: string | null): string | null {
  if (typeof raw.taskId === "string" && raw.taskId) return raw.taskId;
  if (typeof raw.task_id === "string" && raw.task_id) return raw.task_id;
  if (!text) return null;
  const m = text.match(/(?:task:|\/run)\s*([a-zA-Z0-9_.:-]+)/i);
  return m?.[1] ?? null;
}
```

`normalizeMatrix` assigns sender and channel verbatim, `src/gateway.ts:148-157`:

```ts
function normalizeMatrix(raw: Record<string, unknown>) {
  const content = (raw.content as Record<string, unknown> | undefined) ?? {};
  const text =
    (typeof content.body === "string" && content.body) ||
    (typeof raw.body === "string" && raw.body) ||
    null;
  const sender = typeof raw.sender === "string" ? raw.sender : null;
  const channel = typeof raw.room_id === "string" ? raw.room_id : null;
  return { text, sender, channel, taskId: extractTaskId(raw, text) };
}
```

`normalizeTelegram` does the same for `from.username` and `chat.id`, `src/gateway.ts:159-174`.

All of them land on the persisted event at `src/gateway.ts:205-215`, where only `text` is capped:

```ts
const event: IngressEvent = {
  at: new Date().toISOString(),
  source,
  taskId: norm.taskId,
  ...capText(norm.text),
  sender: norm.sender,
  channel: norm.channel,
  freeform,
  route,
  ...capBody(raw),
};
```

The byte budget is skipped for the newest event, `src/gateway.ts:116-128`:

```ts
function trimQueue(queue: IngressEvent[]): IngressEvent[] {
  const recent = queue.slice(-INGRESS_QUEUE_MAX_EVENTS);
  const kept: IngressEvent[] = [];
  let bytes = 2;
  for (let i = recent.length - 1; i >= 0; i--) {
    const event = recent[i]!;
    const size = byteLength(`${JSON.stringify(event, null, 2)}\n`) + 1;
    if (kept.length > 0 && bytes + size > INGRESS_QUEUE_MAX_BYTES) break;
    kept.push(event);
    bytes += size;
  }
  return kept.reverse();
}
```

And `projectEvent` — the unauthenticated `/status` projection — echoes `sender` and `channel` verbatim while correctly flagging `text`/`body` truncation, `src/gateway.ts:445-465`:

```ts
function projectEvent(event: IngressEvent | null): Record<string, unknown> | null {
  if (!event) return null;
  const projection: Record<string, unknown> = {
    at: event.at, source: event.source, taskId: event.taskId,
    channel: event.channel, sender: event.sender, freeform: event.freeform,
    text: event.text,
  };
  if (event.textTruncated) { projection.textTruncated = true; projection.textBytes = event.textBytes; }
  if (event.bodyTruncated) { projection.bodyTruncated = true; projection.bodyBytes = event.bodyBytes; }
  return projection;
}
```

## Evidence

Reproduced 2026-10-02 at `cbc0592` against a running gateway with an isolated `HOME`:

```
=== ONE unauthenticated POST with a 20MB sender ===
  POST -> 202
state dir: 41M
-rw-r--r-- 20975985  .../ingress-queue.json
-rw-r--r-- 20975947  .../last-ingress.json

=== does GET /status echo it back to any caller? ===
  /status response bytes: 20971806
  sender field length: 20971520
  truncation flags present? bodyTruncated
```

41 MB written by one request, and the full 20 MB re-served by `/status` with only `bodyTruncated` set — the `sender` truncation is neither bounded nor reported.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `bun --version` | supported Bun (audit: 1.4.2) |
| Prerequisite | `bun test` | all 104 existing cases pass |
| Existing bounds gate | `bun test tests/gateway-state-bounds.test.ts` | passes unchanged |
| New regression gate | `bun test tests/gateway-ingress-caps.test.ts` | all cases pass |
| Full gate | `bun test && git diff --check` | exit 0 |

No install or build. Fixtures live only under `dist/.test-tmp/`.

## Suggested executor toolkit

- Read `src/gateway.ts:50-138` in full before starting. The caps section is self-contained and heavily commented; match its comment density and its "why this threshold" reasoning rather than adding bare constants.
- `tests/gateway-state-bounds.test.ts` plus `tests/fixtures/gateway-state-bounds-runner.ts` are the direct structural pattern for this plan's test — the fixture runner drives a real gateway against a temporary `HOME`.
- `src/issues.ts` is out of scope here. Plan 015 covers the unbounded Sentry/Bugsink draft path, which is a different module with a different risk profile.

## Scope

**Only modify:**
- `src/gateway.ts` — new cap constants/helpers, `extractTaskId`, `normalizeMatrix`, `normalizeTelegram`, the event construction at `:205-215`, the `IngressEvent` type, `projectEvent`, and `parseJsonObject`
- `tests/gateway-ingress-caps.test.ts` (new)
- `tests/fixtures/gateway-ingress-caps-runner.ts` (new)
- A short note beside plan 010's existing bounds documentation in the README
- This plan's row in `plans/README.md`

**Out of scope (do NOT touch, even though they look related):**
- `capBody`, `INGRESS_BODY_MAX_BYTES`, `INGRESS_QUEUE_MAX_EVENTS`, `INGRESS_QUEUE_MAX_BYTES` and `trimQueue` — plan 010's shipped behavior; do not retune those thresholds
- `src/issues.ts` and the `/ingress/sentry` + `/ingress/bugsink` routes' draft handling — that is plan 015
- The `/chat execute` gate, `chatOriginAllowed`, and every env flag in `src/chat.ts`
- `handleIngress`'s routing, `resolveTask`, and the `freeform` determination — these are logical, not size, concerns
- The `route` field, which holds resolved config; bounding it is a separate question and config size is operator-controlled, not request-controlled
- Tests in `tests/gateway-state-bounds.test.ts` — they must keep passing unmodified

## Git workflow

No branch/worktree creation, commit, push or PR. Preserve unrelated work. Any later implementation needs separate authorization.

## Steps

### Step 1: Generalize the cap helper

Extract the body of `capText` into a reusable `capString(value, maxChars, truncatedKey, bytesKey)` that returns the capped value plus optional truncation flags, and re-express `capText` on top of it. Keep `capText` as a named wrapper — it is referenced at the event construction site and its name carries the "display text" intent.

Choose per-field thresholds and **justify each in a comment**:
- `sender` — a Matrix user id or Telegram username. 200 chars is generous.
- `channel` — a Matrix room id or Telegram chat id. 200 chars is generous.
- `taskId` — this one is a **lookup key**, not display text: `resolveTask` compares it against config task ids. Truncating it would make a long id silently stop matching, so the cap must be high enough to never bite a real id (a few hundred chars), and truncation must be marked rather than silent. Note this trade-off in a comment — it is the reason `taskId` is capped differently from `sender`/`channel`.

**Verify:** the helper returns the input unchanged at or below the threshold and marks truncation above it.

### Step 2: Cap at the normalization boundary

Apply the caps inside `normalizeMatrix`, `normalizeTelegram` and the two direct branches of `extractTaskId`, so that **every** path that can produce a `taskId`, `sender` or `channel` goes through a cap. Do not cap in the event-construction spread instead: that would leave `normalizeChat` and the freeform path as bypasses, which is exactly the class of gap this plan exists to close.

The regex branch of `extractTaskId` (`[a-zA-Z0-9_.:-]+`) is already length-bounded by the 200-char text cap feeding it — leave it alone and say why in a comment.

**Verify:** for each of the four ingress sources, a POST with an oversized `sender` yields a capped stored value.

### Step 3: Extend `IngressEvent` and the projection

Add optional `senderTruncated` / `senderBytes`, `channelTruncated` / `channelBytes` and `taskIdTruncated` / `taskIdBytes` to `IngressEvent` (`src/gateway.ts:32-48`), all optional so ordinary events keep their current serialized shape exactly. Follow the existing comment at `:42-44` explaining that an ordinary event carries none of the flags.

Teach `projectEvent` to surface them the same way it already surfaces `textTruncated` and `bodyTruncated`. A capped field that is not visibly capped reads as data loss with no explanation — plan 010 established that rule and this plan must not break it.

**Verify:** with a truncated sender, `/status` shows a short sender string **and** a `senderTruncated: true` flag.

### Step 4: Reject oversized request bodies before parsing them

The caps above bound what is *persisted*; nothing bounds what is *read*. `parseJsonObject` (`src/gateway.ts:393-404`) calls `await req.json()` with no `Content-Length` precheck, and `Bun.serve` (`src/gateway.ts:540-546`) sets no request-size limit. One oversized request still drives the whole payload through `JSON.parse` and into memory before any cap applies.

Add a `Content-Length` precheck in `parseJsonObject` that returns HTTP 413 when the declared length exceeds a limit, sized to a small multiple of `INGRESS_BODY_MAX_BYTES` (real envelopes carry surrounding fields and, for matrix/telegram, a nested message). Also pass a matching `maxRequestBodySize` to `Bun.serve` so a lying or chunked `Content-Length` is still bounded.

Match the existing 400 shape for this failure — `{ ok: false, error: ... }` with a distinct status code — rather than inventing a new envelope.

**Verify:** a POST declaring an oversized `Content-Length` returns 413 and writes nothing to the state directory.

## Test plan

Create `tests/gateway-ingress-caps.test.ts` and `tests/fixtures/gateway-ingress-caps-runner.ts`, modeled on `tests/gateway-state-bounds.test.ts` and its runner. Cases:

1. Characterization: an ordinary matrix and telegram event round-trips with byte-identical stored and projected shape — no truncation flags appear for normal-length values. This is the anti-regression case.
2. Oversized `sender` on `/ingress/matrix`: stored value is capped, `senderTruncated` is true, `senderBytes` reports the original length.
3. Oversized `channel` on `/ingress/telegram` (`chat.id`): same behavior.
4. Oversized direct `taskId` and `task_id`: capped and flagged, and the regex-derived branch is unaffected.
5. Oversized `text` still behaves exactly as plan 010 specified (existing suite must keep passing — do not rewrite those assertions).
6. `/status` never returns more than a few KB for any of the above, and no field is silently shortened without its flag.
7. A POST declaring a `Content-Length` above the limit returns 413, writes nothing, and leaves the queue length unchanged.
8. A POST whose body is oversized but whose `Content-Length` lies is still bounded (exercises the `Bun.serve` limit).

**Verify:** `bun test tests/gateway-ingress-caps.test.ts tests/gateway-state-bounds.test.ts` → both pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun test` exits 0; `tests/gateway-state-bounds.test.ts` passes **unmodified**
- [ ] `bun test tests/gateway-ingress-caps.test.ts` passes
- [ ] No ingress route can write more than a bounded amount to the state directory from a single POST
- [ ] `GET /status` response size is bounded for every ingress source
- [ ] Every truncated field carries a visible `*Truncated` flag and its original `*Bytes`
- [ ] Events with ordinary-length fields are byte-identical to today's output
- [ ] A `taskId` at a realistic length still resolves through `resolveTask` unchanged
- [ ] `git diff -- src/gateway.ts` touches only the cap helpers, the normalizers, `extractTaskId`, the event/projection types and the body precheck
- [ ] `git diff --check` passes; file scope respected; `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Capping `taskId` would break resolution of a realistic task id — raise the threshold rather than truncating a lookup key silently.
- A truncation flag must be added as a *required* field on `IngressEvent`, which would change the serialized shape of ordinary events.
- `Bun.serve`'s `maxRequestBodySize` cannot be set on the Bun version in use, or rejects payloads that `harness`'s own clients send.
- Capping `sender`/`channel`/`taskId` would change a value that `harness summary` or `src/static/chat.html` currently depends on for routing.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **What a reviewer should scrutinize:** that every producer of these three fields routes through a cap. The bug this plan fixes was three sibling assignments, not one bad line; a fourth would reintroduce it. The right review question on any future change to `normalizeMatrix`/`normalizeTelegram`/`extractTaskId` is "which cap does this field pass through?"
- The `Content-Length` precheck is a fast path, not the guarantee — the `Bun.serve` limit is the guarantee. Both must be present; a client that omits or lies about `Content-Length` bypasses only the first.
- **Paired plan:** plan 015 bounds the `/ingress/sentry` and `/ingress/bugsink` draft path in `src/issues.ts`, which is the same threat (unauthenticated POST → unbounded disk) in a different module. Both are needed to close the class; doing 014 alone leaves the larger hole open.
- **Deferred, explicitly not in this plan:** (a) the `route` field carries the resolved config (`adapters`, `tasks`, `configPath`) into every stored event and therefore into the queue's byte budget — operator-controlled rather than request-controlled, but worth revisiting if configs grow; (b) response size is bounded by capping the stored values, while `handleIngress` (`src/gateway.ts:227`) still returns the *uncapped* `norm.text` to the caller in `task.text` and `stubReply`; capping the response too is a small follow-on that preserves the stored-vs-response distinction plan 010 already draws.
