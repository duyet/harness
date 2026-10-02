# Plan 010: Bound gateway ingress state growth and stop echoing raw payloads on `/status`

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, remotes or external calls without separate authorization.
>
> **Drift check (first):** `git diff --stat b96a1ec..HEAD -- src/gateway.ts src/cli.ts src/static/chat.html tests/gateway-context.test.ts`
> Compare changed code against the excerpts below. Plan 004's `parseJsonObject` boundary is expected in `src/gateway.ts`. `src/static/chat.html` must keep working; see Step 3. STOP on unexplained drift.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW — bounds only apply above a generous per-event and per-queue threshold; small normal events are stored verbatim
- **Depends on:** `plans/001-isolated-test-baseline.md`
- **Category:** security / dx
- **Confidence:** HIGH (reproduced 2026-10-02 against `b96a1ec`; measurements in "Evidence")
- **Planned at:** commit `b96a1ec`, 2026-10-02

## Why this matters

Every ingress request is stored twice on disk — once whole in `last-ingress.json`, once whole again in the retained queue — with no size limit on the payload and no authentication on either route. A loop of POSTs fills the state directory to a size that can break the box, and `/status` hands the entire last payload back to any caller. The gateway is documented as a loopback service, but a stale `HARNESS_GATEWAY_HOST` or a future transport should not turn into unbounded disk use. This is a resource and disclosure bound on the ingress boundary, not an authentication design.

## Current state

`src/gateway.ts:121-132` stores the caller's raw body verbatim on every event:

```ts
const event: IngressEvent = {
  at: new Date().toISOString(),
  source,
  taskId: norm.taskId,
  text: norm.text,
  sender: norm.sender,
  channel: norm.channel,
  freeform,
  route,
  body: raw,
};
```

`src/gateway.ts:46-54` keeps a rolling window by count only:

```ts
function persistIngress(event: IngressEvent) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LAST_INGRESS_FILE, `${JSON.stringify(event, null, 2)}\n`);
  const queue = readJsonFile<IngressEvent[]>(INGRESS_QUEUE_FILE, []);
  queue.push(event);
  const trimmed = queue.slice(-50);
  writeFileSync(INGRESS_QUEUE_FILE, `${JSON.stringify(trimmed, null, 2)}\n`);
  return { last: event, queued: trimmed.length };
}
```

Fifty events is a cap on count, not on bytes. `GET /status` (`src/gateway.ts:305-314`) returns `lastEvent: lastIngress()` in full, and `harness summary --json` embeds the same object as `gatewayLastEvent` (`src/cli.ts:1069`). The chat page consumes `ev.at`, `ev.source` and `ev.taskId || ev.text` from `/status` (`src/static/chat.html:38-49`), so `text` must survive any truncation.

## Evidence

Measured 2026-10-02 at `b96a1ec` through `handleGatewayRequest` with an isolated `HOME`, 60 POSTs to `/ingress/telegram` of 200 KB each:

```
ingress-queue.json    20M      (50 retained events x ~400 KB on disk)
last-ingress.json     392K
GET /status response  400281 bytes echoed to any caller
```

A single unauthenticated loop fills tens of megabytes, and each `/status` call re-ships the last payload.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `bun --version` | supported Bun (audit: 1.4.2) |
| Prerequisite | `bun test` | all 72 existing cases pass |
| New regression gate | `bun test tests/gateway-state-bounds.test.ts` | all cases pass |
| Full gate | `bun test && git diff --check` | exit 0 |

No install or build. These tests are proposed, not already run. Fixtures live only in `dist/.test-tmp/`.

## Scope

**Only modify:** `src/gateway.ts` (persistence and `/status` response only), `src/shared.ts` (config type additions only, if an env knob is used), `tests/gateway-state-bounds.test.ts` (new), `tests/fixtures/gateway-state-bounds-runner.ts` (new), and this plan's row in `plans/README.md`.

**Out of scope:** adding authentication (plan 008's gate is the interim control), changing ingress routing or normalization, dropping the `body` field from `IngressEvent` outright, adding a database or log rotation service, changing `harness summary` output, chat UI changes beyond keeping `text` present, dependencies, release-please, other repos, crons and remotes.

## Git workflow

No branch/worktree creation, commit, push or PR. Preserve unrelated work. Any later implementation or publication needs separate authorization.

## Steps

### Step 1: Bound the stored body

Keep `body` in the event type, but store a capped representation. Above a generous per-event threshold (4 KB serialized is far above any ordinary chat or error payload), keep the first chunk and add sibling fields such as `bodyTruncated: true` and `bodyBytes: <original byte length>`. Below the threshold, store the body unchanged so ordinary events are byte-identical to today and existing tests keep passing.

Normalize `text` separately: it is what the UI and `summary` display, so cap it on its own (a few hundred characters) and mark it truncated, rather than letting it be cut arbitrarily by the body cap.

**Verify:** `bun test tests/gateway-chat.test.ts tests/pick-delivery.test.ts` → unchanged and green.

### Step 2: Bound the queue by bytes as well as count

Keep the `slice(-50)` count window, and additionally drop oldest events once the serialized queue exceeds a total budget (for example 2 MB), so a burst of large events cannot accumulate. Preserve `queued` semantics as "number of events currently retained". Writing the queue atomically (write to a temp file in the same directory, then rename) is worth doing here since the file is rewritten on every request; keep it simple and do not add a lock or a database.

**Verify:** `bun test tests/gateway-state-bounds.test.ts` → queue stays under budget.

### Step 3: Redact `/status`

Return a summary projection on `GET /status`: `at`, `source`, `taskId`, `channel`, `sender`, `freeform`, the text cap, and `bodyBytes`/`bodyTruncated` when applicable — but not the raw body. `src/static/chat.html` reads only `at`, `source`, `taskId` and `text`, so the page keeps working unchanged; verify by confirming those fields survive the projection. If an operator needs the full event, `harness summary --json` still exposes it locally, and that is the documented place for full detail.

**Verify:** `bun test tests/gateway-state-bounds.test.ts` → `/status` contains no raw body and still carries the fields the UI uses.

### Step 4: Full regression and boundary check

**Verify:** `bun test && git diff --check` → exit 0 (72 existing cases plus the new file). `git diff -- src/gateway.ts` touches only `persistIngress` and the `/status` response. `git status --short` → scoped changes only.

## Test plan

Create `tests/gateway-state-bounds.test.ts` plus `tests/fixtures/gateway-state-bounds-runner.ts` in the established style (isolated `HOME` under `dist/.test-tmp/`, calls through `handleGatewayRequest`, `Bun.serve`/`fetch` spied to fail loudly). Cases:

1. Characterization: one small `/ingress/telegram` and one `/chat` post produce the same files and the same fields as today.
2. A single oversized event stores a capped body, sets the truncation fields, and reports the original byte length.
3. Sixty large events leave `ingress-queue.json` under budget while `last-ingress.json` stays small.
4. `GET /status` returns the projection, includes `at`/`source`/`taskId`/`text` for the chat page, and does not contain the payload's distinctive marker string.
5. `harness summary --json` still reports `gatewayLastEvent` with the truncation markers, so local detail is not lost.
6. The count window still holds: after more than 50 events the oldest are dropped.

No network and no external service. Use `statSync`/`readFileSync` on the fixture state directory for size assertions; do not assert on wall-clock timing here.

## Done criteria

- [ ] Focused and full Bun suites exit 0.
- [ ] Ingress persistence has a per-event byte cap and a total queue budget; the count window still applies.
- [ ] Ordinary-sized events are stored exactly as before.
- [ ] `GET /status` no longer returns raw bodies but still serves every field `src/static/chat.html` uses.
- [ ] Truncation is visible to operators (flag plus original size), not silent.
- [ ] `git diff --check` passes; file scope respected; index row updated.

## STOP conditions

Stop if bounding the payload would break `harness summary` consumers, if the chat page needs a field the projection drops, if atomic rename is not safe on the target filesystem, if plan 008's auth gate has made this redundant, if out-of-scope changes appear necessary, or after two failed gate attempts.

## Maintenance notes

Keep the caps well above ordinary payloads; the goal is to stop abuse, not to truncate real reports. If the event body is ever needed for debugging, prefer an explicit operator-only command over widening `/status`. Deferred: log rotation, retention windows, and a real append-only journal.
