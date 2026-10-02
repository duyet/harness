# Plan 025: Answer hostile input with the JSON envelope, not a 500 or a stack trace

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat cba1548..HEAD -- src/gateway.ts src/shared.ts src/issues.ts src/cli.ts tests/`
> If `parseJsonObject` already bounds nesting depth, **or** `readJsonFile` / `loadIngressQueue` already validate the parsed shape, STOP and report whichever half is already fixed.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW
- **Depends on:** `plans/004-validate-gateway-json.md` (shipped), `plans/019-atomic-state-file-writes.md` (shipped)
- **Category:** bug / robustness / dx
- **Confidence:** HIGH (both halves reproduced 2026-10-02 against `cba1548`; transcripts in "Evidence")
- **Planned at:** commit `cba1548`, 2026-10-02 (Run 5)

## Why this matters

The README promises, for all five POST routes:

> All five POST routes … return **400** with `{ "ok": false, "error": "..." }` for invalid input … Success statuses remain **200** for `/chat` and **202** for the four ingress routes.

and, for `/chat` specifically:

> `/chat` never hangs or 500s.

Plan 004 was filed to deliver exactly that. Two classes of input still escape it, and both end the same way — an uncaught exception thrown from inside the request handler, surfacing as Bun's HTML **500** page with an empty body and an unhandled-rejection line on stderr.

### Half A — a 160 KB request 500s all four ingress routes

`parseJsonObject` bounds the request at 256 KB and validates that the top level is a non-array object. Nothing bounds **depth**. `JSON.parse` is iterative in V8 and accepts arbitrary nesting; `JSON.stringify` is recursive and throws past roughly 40,000 levels. Both throw sites sit *after* validation and *before* any state write:

- `capBody`, `src/gateway.ts:124` — `JSON.stringify(raw)` on the request body
- `fingerprintFor`, `src/issues.ts:38` — `JSON.stringify(raw).slice(0, 200)` inside the hash fallback

A single unauthenticated POST of **160,007 bytes** — well under the documented 256 KB ceiling, so it is accepted by every documented check — is enough.

### Half B — a wrong-shaped state file 500s `/chat` and crashes `pick`

Two readers check that the bytes *parse* but never that the value has the right *shape*. `JSON.parse("null")`, `JSON.parse("{}")` and `JSON.parse('"x"')` all succeed, so they escape both fallbacks and reach `.push` / `.filter`:

```ts
function readJsonFile<T>(path: string, fallback: T): T {         // src/gateway.ts:111
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;          // `as T` asserts; it never checks
  } catch { return fallback; }
}
```

The contrast with a reader that *does* check is in the same file set — `lastDelivery` (`src/shared.ts:211-219`) validates with `parsed && typeof parsed === "object"`, and `loadSpawns` (`src/shared.ts:171-179`) normalizes with `parsed?.spawns ?? {}`. The pattern exists; two callers just do not use it.

There is a **third** instance of the same gap, in a file this plan's Half B does not otherwise reach: `listIssueDrafts` (`src/issues.ts:450-458`) pushes whatever `JSON.parse` returned, while its own sibling `readStoredDraft` (`src/issues.ts:148-156`) checks `isRecord` first. A file holding `null`, `[]` or `"x"` is pushed, and `src/cli.ts:1209` (`.filter((d) => d.status === …)`) and `src/cli.ts:1380` (`drafts.map((d) => ({ …d.fingerprint … }))`) then throw a raw `TypeError`. Fix it in the same pass — it is the same one-line class.

For `ingress-queue.json`, `persistIngress` runs **inside the unauthenticated handler**, so the exception becomes a 500 on the main chat route. `harness pick` dies with a raw stack trace.

## Current state

Half A — the throw sites, both after validation, both before any write:

```ts
// src/gateway.ts:123-126
function capBody(raw: Record<string, unknown>): ... {
  const serialized = JSON.stringify(raw);    // RangeError past ~40k levels
  ...
}

// src/issues.ts:38
const msg = str(raw.message) || str(raw.title) || JSON.stringify(raw).slice(0, 200);
```

Half B — the two unchecked readers and their consumers:

```ts
const queue = readJsonFile<IngressEvent[]>(INGRESS_QUEUE_FILE, []);
queue.push(event);                          // src/gateway.ts:208 — inside the handler

const freeform = queue.filter((e) => e.freeform);   // src/cli.ts:1274
```

Nothing partial is written in either half: every throw is upstream of the first `writeJsonAtomic`, so this is not a data-integrity bug. It is a "documented contract says 400, reality says 500" bug, on routes that are unauthenticated by design.

## Evidence

Reproduced 2026-10-02 at `cba1548`, isolated `HOME`, gateway on `127.0.0.1:8901`.

**Half A** — one 160,007-byte POST per route, no auth of any kind:

```
  bytes 160007
  /chat               -> HTTP 500
  /ingress/sentry     -> HTTP 500
  /ingress/telegram   -> HTTP 500
  /ingress/matrix     -> HTTP 500

--- response body ---
(empty)

--- gateway stderr ---
RangeError: Maximum call stack size exceeded.
      at capBody (src/gateway.ts:124:27)
      at handleIngress (src/gateway.ts:331:8)
      at handleGatewayRequest (src/gateway.ts:735:20)
POST - http://127.0.0.1:8901/ingress/matrix failed

RangeError: Maximum call stack size exceeded.
      at buildDraft (src/issues.ts:80:23)
```

The 256 KB ceiling does not help: the payload is 160 KB. Depth 40,000 at 2 bytes per level is enough.

**Half B** — one line planted into the state file:

```
$ printf '{"not":"an array"}' > $STATE/ingress-queue.json
```

`POST /chat`:

```
HTTP 500
<!doctype html>
<html lang="en">
  ...
  <!-- The bracketed placeholders below are filled in by DevErrorPage.rs; keep prettier aw
is HTML error page: True

# gateway stderr:
208 |   queue.push(event);
TypeError: queue.push is not a function. (In 'queue.push(event)', 'queue.push' is undefined)
```

`harness pick` on the freeform tier (fixture config with `"tasks": []` and an empty issues dir, so the `else` branch is reached):

```
1274 |     const freeform = queue.filter((e) => e.freeform);
      |                                     ^
TypeError: queue.filter is not a function.
--- exit: 1 ---
```

How `ingress-queue.json` becomes a non-array is a fair question — today only `persistIngress` writes it, and plan 019's atomic writes make a torn read impossible. The exposure is a hand-edit, a state directory restored from another tool, or a future writer. Half A needs no such setup at all, which is why it is the P1 half.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Prerequisite | `bun test` | 169 green |
| New gate | `bun test tests/gateway-input.test.ts tests/gateway-state-bounds.test.ts tests/pick-rotation.test.ts` | pass |
| Full gate | `bun test && git diff --check` | exit 0 |

## Scope

**Only modify:**
- `src/gateway.ts` — `parseJsonObject` (depth), `readJsonFile` (shape)
- `src/cli.ts` — `loadIngressQueue` (shape)
- `src/issues.ts` — `listIssueDrafts` (shape)
- `tests/` — `tests/gateway-input.test.ts` for the depth case; state-bounds / pick / issues tests for the shape cases (+ fixture runners)
- `plans/README.md` status row

**Out of scope:**
- Lowering `INGRESS_REQUEST_MAX_BYTES` (it is correct and doing its job)
- The atomic writer (plan 019 shipped it)
- A schema/validator dependency — the shapes are two lines each
- Bounds on any field (plans 010/014/015/023/024 own those)
- release-please, herdr-desk, other repos

## Steps

### Step 1: Bound nesting depth at the request gate

The cheapest correct place is `parseJsonObject`, which already owns the request-shape contract and already produces the 400 envelope. Walk the parsed value iteratively (do **not** recurse — that is the bug) and refuse anything past a small ceiling with the existing error shape:

```ts
const MAX_JSON_DEPTH = 64;   // real Matrix/Telegram/Sentry payloads are ~10
```

Return `{ ok: false, response: Response.json({ ok: false, error: "JSON nesting too deep" }, { status: 400 }) }`.

64 is far above any real provider payload, so ordinary traffic is unaffected. An iterative walk keeps this independent of the engine's own recursion limit, which is what makes the threshold a stable contract rather than a V8-version-dependent accident.

Note this also protects `buildDraft`'s `JSON.stringify` on the error routes without touching `src/issues.ts`.

### Step 2: Make the state readers shape-aware

Keep the parse-failure fallback and add a shape check beside it. Either pass a guard into `readJsonFile`:

```ts
function readJsonFile<T>(path: string, fallback: T, isValid: (v: unknown) => v is T): T {
  if (!existsSync(path)) return fallback;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isValid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
```

or validate at each call site, in the style of `lastDelivery` / `loadSpawns`. Prefer whichever gives the smaller diff; both are defensible.

For `loadIngressQueue`:

```ts
const parsed: unknown = JSON.parse(readFileSync(INGRESS_QUEUE_FILE, "utf8"));
return Array.isArray(parsed) ? (parsed as IngressEvent[]) : [];
```

For `listIssueDrafts`, gate on `isRecord` exactly as `readStoredDraft` already does two functions above — so the two readers of the same directory cannot disagree about what a file may contain.

### Step 3: Consider a last-resort handler wrapper

Both halves would also be contained by catching in `handleGatewayRequest` and answering the JSON envelope for *any* unexpected throw, rather than letting Bun render its HTML page. That is a small belt-and-braces addition and it makes the documented contract hold for input classes neither step above anticipated.

**Judgment call — see STOP.**

### Step 4: Regression

- Half A: for each POST route, depth just under and just over the ceiling → 200/202 and 400 with the JSON envelope, never 500. Assert no state file was written by the refused request.
- Half B: plant `{}`, `null`, `"string"`, `[]`, a valid array and an unparseable file; assert `/chat` answers a JSON envelope and `pick` reports its normal result ("nothing to pick", exit 1) instead of a stack trace.
- Ordinary shallow payloads are byte-identical to before.

## Done criteria

- [ ] No input to any POST route returns a 500 or an HTML error page
- [ ] A wrong-shaped state file cannot throw inside a handler or a CLI command
- [ ] Deeply nested JSON is refused with the documented 400 envelope and writes no state
- [ ] Ordinary payloads are byte-identical to before
- [ ] `bun test` exit 0; `plans/README.md` row → DONE when executed

## STOP conditions

- Step 1 turns out to need a real parser dependency — stop and record it in the README's deferred notes rather than adding one.
- A real out-of-repo consumer sends payloads nested deeper than the chosen ceiling — surface it before choosing the number.