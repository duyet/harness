# Plan 017: Project `lastDelivery` on unauthenticated `GET /status` (residual of plan 010)

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 5fd3cf0..HEAD -- src/gateway.ts src/shared.ts tests/gateway-state-bounds.test.ts src/static/chat.html`
> Plan 010 projected `lastEvent` via `projectEvent` but left `lastDelivery: lastDelivery()` raw on the same route. If `/status` or `LastDelivery` has already been projected, STOP and report.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW — `/status` consumers only need `lastEvent` today (`src/static/chat.html`); chat pickup already uses a projected `{ at, path, excerpt }` shape
- **Depends on:** `plans/010-bound-ingress-state.md` (shipped)
- **Category:** security
- **Confidence:** HIGH (reproduced 2026-10-02 against `5fd3cf0`; transcript in "Evidence")
- **Planned at:** commit `5fd3cf0`, 2026-10-02 (Run 4)

## Why this matters

Plan 010 stopped `/status` from echoing raw ingress bodies by introducing `projectEvent`. On the same route it still returns `lastDelivery()` verbatim. An unauthenticated `GET /status` therefore leaks absolute filesystem paths that embed the OS username (`summaryPath`, `summaryJsonPath`, `deliveryPath`) plus up to 600 characters of the last daily-summary report.

This was the top deferred candidate from Run 3 and still applies after 012–016 shipped. No consumer of the HTTP route needs the absolute paths: `src/static/chat.html` reads only `lastEvent`, and the `/chat` pickup path already projects delivery to `{ at, path, excerpt }` at `src/gateway.ts:670-672`.

## Current state

Unauthenticated `/status`, `src/gateway.ts:680-688`:

```ts
if (req.method === "GET" && url.pathname === "/status") {
  return Response.json({
    ok: true,
    listening: true,
    version: VERSION,
    bind,
    lastEvent: projectEvent(lastIngress()),
    lastDelivery: lastDelivery(),
  });
}
```

`LastDelivery` shape, `src/shared.ts:167-175`:

```ts
export type LastDelivery = {
  kind: "summary";
  at: string;
  summaryPath: string;
  summaryJsonPath: string;
  deliveryPath: string;
  bytes: number;
  excerpt: string;
};
```

Chat pickup already projects safely, `src/gateway.ts:670-672`:

```ts
body.lastSummary = delivery
  ? { at: delivery.at, path: delivery.summaryPath, excerpt: delivery.excerpt }
  : null;
```

Note `path` there is still absolute — project `/status` first; optionally tighten pickup in the same change to expose only a basename or omit `path` entirely if no consumer needs it.

## Evidence

Reproduced 2026-10-02 at `5fd3cf0` with an isolated `HOME` fixture and a planted `last-delivery.json` whose paths embed `alice-leak-test`:

```
{"embedsUsername":true,"excerptLen":595,
 "paths":{"s":"/home/alice-leak-test/.local/state/herdr-harness/last-summary.md",
          "d":"/home/alice-leak-test/.local/state/herdr-harness/last-delivery.json"},
 "lastEventProjected":true}
```

`lastEvent` is projected (null / no raw body); `lastDelivery` is not.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Prerequisite | `bun test` | 148 green |
| New gate | `bun test tests/gateway-state-bounds.test.ts` (or a dedicated status-projection file) | pass |
| Full gate | `bun test && git diff --check` | exit 0 |

## Scope

**Only modify:**
- `src/gateway.ts` — add `projectDelivery` (or inline projection) on `/status`; optionally align `/chat` pickup
- `tests/` — extend state-bounds or add `tests/gateway-status-projection.test.ts` (+ fixture runner if needed)
- `plans/README.md` status row

**Out of scope:**
- `harness gateway status` / `harness summary` CLI JSON (local, not the HTTP leak)
- Changing how `writeSummaryDelivery` stores the record on disk
- Auth / Origin on ingress or `/status` (direction-only; see README)
- release-please, herdr-desk, other repos

## Steps

### Step 1: Add `projectDelivery`

Next to `projectEvent`, project a delivery to a public shape that keeps `kind`, `at`, `bytes`, and a short `excerpt` (already capped at 600 on write) but **drops** `summaryPath` / `summaryJsonPath` / `deliveryPath`, or replaces them with basenames only if a consumer truly needs a path hint.

### Step 2: Wire `/status`

Replace `lastDelivery: lastDelivery()` with `lastDelivery: projectDelivery(lastDelivery())`.

### Step 3: Align `/chat` pickup (optional, same PR)

If `body.lastSummary.path` is unused by `chat.html`, drop it or basename it so the HTTP surface is consistent.

### Step 4: Regression

Assert `/status` with a planted delivery never embeds `STATE_DIR` or the username; assert `lastEvent` projection is unchanged; assert ordinary null delivery still returns `null`.

## Done criteria

- [ ] `GET /status` never returns absolute paths under the user home
- [ ] Existing chat stub / pickup behaviour stays green
- [ ] `bun test` exit 0; `plans/README.md` row → DONE when executed

## STOP conditions

- A real in-repo consumer of `/status.lastDelivery.summaryPath` (or siblings) is found — surface it before changing the shape.
- Drift has already projected delivery; do not double-edit.
