# Plan 024: Project the unauthenticated ingress POST responses instead of echoing raw `task.text` (residual of plan 015)

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat cba1548..HEAD -- src/gateway.ts src/static/chat.html tests/`
> If `/ingress/matrix`, `/ingress/telegram` or `/chat` already return a projected `task`, STOP and report.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW–MED — three response envelopes change shape; the only in-repo consumer of `/chat` is `src/static/chat.html`
- **Depends on:** `plans/015-bound-issue-draft-directory.md` (shipped), `plans/014-cap-unbounded-ingress-fields.md` (shipped)
- **Category:** dx / defense-in-depth (NOT a disclosure — see "Why this matters")
- **Confidence:** HIGH (reproduced 2026-10-02 against `cba1548`; transcript in "Evidence")
- **Planned at:** commit `cba1548`, 2026-10-02 (Run 5)

## Why this matters

**Read this first, because it is the honest scope.** The response is a reflection of the caller's *own* bytes: no third-party data is disclosed and the amplification is roughly 1× (`/ingress/matrix`, `/ingress/telegram`) to 2× (`/chat`, which carries the text in both `task.text` and `reply`). This is **not** a confidentiality vulnerability, and it should not be filed as one. A Run 5 audit pass specifically challenged the framing and was right to.

It is still worth fixing, for three reasons that do hold:

1. **The bound is real on one side and absent on the other.** Plan 014 caps what is *persisted*. Nothing bounds what is *returned*, so an endpoint documented as bounding ingress does not bound its own response — the two halves of the same contract disagree by three orders of magnitude (203 bytes stored vs 200,000 returned, below).
2. **It contradicts the documented contract.** The README promises that a shortened value is "always visibly shortened" and that the caps apply. On the response path the value is neither shortened nor flagged — it is simply the full input.
3. **`/chat` doubles it for no reason.** `task.text` *and* the interpolated `reply` carry the same payload.

The fix is small and the in-repo pattern (`projectEvent`, `projectIssueDraft`) already exists. Plan 015 found this exact defect on the draft routes and wrote the remedy down; this plan applies it to the three routes it was missed on.

`handleIngress` normalizes caller text without a bound (`normalizeMatrix` / `normalizeTelegram` / `normalizeChat` all return `text` raw; `capText` is applied only when building the stored `event`), and then hands the raw value back in `result.task.text`:

`handleIngress` normalizes caller text without a bound (`normalizeMatrix` / `normalizeTelegram` / `normalizeChat` all return `text` raw; `capText` is applied only when building the stored `event`), and then hands the raw value back in `result.task.text`:

```ts
task: {
  id: norm.taskId.value,
  text: norm.text,          // <-- UNBOUNDED
  ...
}
```

All three routes return it verbatim:

```ts
// /chat
return Response.json({ ok: true, ...reply, task: result.task, ... });
// /ingress/matrix and /ingress/telegram
return Response.json(result, { status: 202 });
```

`stubReply` then interpolates the same raw text into the human-readable `reply`, so `/chat` carries it **twice**.

So plan 014's caps work exactly as designed — and are silently bypassed one line later, on the way out of the process.

## Current state

Every unauthenticated route, `src/gateway.ts`:

| Route | Line | Returns | Projected? |
|---|---|---|---|
| `GET /status` | 727 | `projectEvent(lastIngress())` | yes |
| `POST /ingress/sentry` | 749 | `projectIssueDraft(draft)` | yes |
| `POST /ingress/bugsink` | 755 | `projectIssueDraft(draft)` | yes |
| `POST /chat` | 705 | `task: result.task` — **raw** | **no** |
| `POST /ingress/matrix` | 736 | `result` — **raw** | **no** |
| `POST /ingress/telegram` | 743 | `result` — **raw** | **no** |

The normalizers return text uncapped, `src/gateway.ts:233-279`:

```ts
function normalizeMatrix(raw: Record<string, unknown>) {
  const content = (raw.content as Record<string, unknown> | undefined) ?? {};
  const text =
    (typeof content.body === "string" && content.body) ||   // no cap
    (typeof raw.body === "string" && raw.body) ||
    null;
  ...
}
```

`capText` is applied only on the stored event, `src/gateway.ts:326`:

```ts
const event: IngressEvent = {
  ...
  ...capText(norm.text),       // stored copy is capped
  ...
};
...
task: { ..., text: norm.text, ... }   // returned copy is not
```

## Evidence

Reproduced 2026-10-02 at `cba1548`, isolated `HOME`, gateway on `127.0.0.1:8899`.

**The stored copy is capped; the response is not** — one POST of 200 KB, both read from the same run:

```
=== /ingress/matrix 202 response vs the stored (capped) event ===
202 response bytes      : 200203
echoed task.text bytes  : 200000      <-- UNCAPPED in the response

--- what was actually PERSISTED (capped, per plan 014) ---
stored text bytes : 203
textTruncated     : True
stored body bytes : 4103
```

The cap fired correctly (203 bytes stored, `textTruncated: true`) and the full 200 KB still went back to the caller.

**`/chat` is worse — it echoes twice:**

```
  /chat response bytes : 400513
  task.text bytes      : 200000      <- UNCAPPED in the response
  reply interpolates it: True        (stubReply embeds the raw text)
```

The 202 on the error routes echoes the uncapped fingerprint too — see plan 023, which bounds that field at its source.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Prerequisite | `bun test` | 169 green |
| New gate | `bun test tests/gateway-ingress-caps.test.ts` | pass |
| Full gate | `bun test && git diff --check` | exit 0 |

## Scope

**Only modify:**
- `src/gateway.ts` — add a `projectTask`-style projection and wire it into `/chat`, `/ingress/matrix`, `/ingress/telegram`
- `src/static/chat.html` — only if it reads a field the projection drops
- `tests/` — extend `tests/gateway-ingress-caps.test.ts` (or add a dedicated response-projection test) + fixture runner
- `plans/README.md` status row

**Out of scope:**
- The stored-event caps (plans 010/014 — they work; this plan is about the return path)
- `projectIssueDraft` / the fingerprint field itself (plan 023)
- Auth / Origin on ingress (direction-only; see README)
- release-please, herdr-desk, other repos

## Steps

### Step 1: Add a task projection

Mirror `projectEvent`'s idiom — keep the fields a caller needs to correlate an ingest, cap the one that carries the payload:

```ts
// `task.text` is the caller's own message; the bound exists because this
// response is unauthenticated, not because the text is secret.
function projectTask(task: IngressResult["task"]) {
  const { text, ...rest } = task;
  return {
    ...rest,
    ...capText(text),          // reuse the existing cap + truncation flags
  };
}
```

`capText` already returns `{ text, textTruncated?, textBytes? }`, so truncation stays visible rather than becoming silent data loss — the property plan 014 established for the stored event.

### Step 2: Wire all three routes

- `/chat`: `task: result.task` → `task: projectTask(result.task)`
- `/ingress/matrix` and `/ingress/telegram`: `Response.json(result, …)` → `Response.json({ ok: true, ...result, task: projectTask(result.task) }, …)`

Keep `lastEvent` and `queued` — they are small and useful for correlation.

### Step 3: Bound `stubReply` too

`stubReply` interpolates `t.text` into a string that `/chat` returns. Cap it the same way, or build the reply from the projected task. Without this, `/chat` still doubles the payload even after Step 2.

### Step 4: Regression

- Ordinary short messages: response byte-identical to before (no `textTruncated` key, same text).
- Oversized text: response stays bounded and carries `textTruncated` / `textBytes`.
- The stored event's shape is unchanged.
- `src/static/chat.html` still renders a reply (it reads `reply`; confirm it does not read a dropped field).

## Done criteria

- [ ] No input to `/chat`, `/ingress/matrix` or `/ingress/telegram` returns a response proportional to the request size
- [ ] Truncation stays visible on the response (`textTruncated` / `textBytes`), matching the stored event's contract
- [ ] Ordinary messages are byte-identical to before
- [ ] The chat page still works
- [ ] `bun test` exit 0; `plans/README.md` row → DONE when executed

## STOP conditions

- A real out-of-repo consumer turns out to read the full `task.text` from a 202 — surface it before changing the shape.
- The plan turns out to need auth on ingress to be safe — that is direction-only; stop and record it in the README's direction notes instead.