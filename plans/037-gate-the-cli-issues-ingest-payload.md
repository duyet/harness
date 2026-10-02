# Plan 037: Gate the `harness issues ingest` payload on shape, depth and size (residual of plan 025)

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 63937ed..HEAD -- src/cli.ts tests/issues-stdin-bound.test.ts tests/issues-bounds.test.ts`
> If `readJsonPayload` already rejects non-object payloads, bounds nesting, and caps the byte length, STOP and report.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW
- **Depends on:** `plans/025-answer-hostile-input-with-json-envelope.md` (shipped, residual noted in its status row), `plans/020-bound-issues-ingest-stdin.md` (shipped), `plans/023-keep-issue-draft-body-publishable.md` (shipped)
- **Category:** bug / robustness
- **Confidence:** HIGH (all three vectors reproduced 2026-10-02 against `63937ed`)
- **Planned at:** commit `63937ed`, 2026-10-02 (Run 7)

## Why this matters

Plan 025 gave every JSON entry point a shape contract and a depth ceiling, and it left one reader behind. The reader is the CLI's own, and it is the only payload surface in the harness with none of the three bounds:

```ts
// src/cli.ts:1193
  const text = file ? readFileSync(file, "utf8") : await Bun.stdin.text();
  if (!text.trim()) throw new Error("empty payload; ...");
  return JSON.parse(text) as Record<string, unknown>;   // <-- asserted, not checked
```

That cast is the exact pattern plan 025 replaced everywhere else. `ingestErrorEvent` then hands whatever came out to `buildDraft`, which reads `raw.message`, `raw.culprit`, `raw.event_id` and serializes it. Three consequences, all reproduced:

1. **`null` produces a raw `TypeError` string** in the envelope, from a *cast* that promised an object.
2. **`"x"` and `[1,2,3]` are accepted, exit 0, and write a permanent draft to disk.** `fingerprintFor` is happy to hash either — `fingerprintFor("x")` is `e8a7f60dcb3afe09` — so a junk draft lands in the drafts directory with a stable, content-derived identity and a title of `[sentry] unknown: unknown error`. That is a real entry in `harness issues list`, `harness pick` and `harness summary` from a payload that is not an error event at all.
3. **No depth ceiling and no byte ceiling.** `readFileSync` reads the file whole and `JSON.parse` takes it whole; the first thing that bounds either is `buildDraft`'s `JSON.stringify`, which overflows the stack and surfaces as `RangeError: Maximum call stack size exceeded.`

Plan 025's own status row records this as a known residual — *"`harness issues ingest --file` on a deeply nested payload still reports a raw `RangeError` string in its (already graceful) `ok: false` envelope, since no depth gate covers that surface."* That is accurate, and it is the only part of this plan that is already written down; the shape hole and the unbounded read are not.

**One correction to that note, for the record.** The row implies the gateway's own 40,000-level reproducer reaches the CLI path. It does not — 40,000 levels (240,001 bytes) ingests cleanly, because Bun 1.4.2's `JSON.stringify` does not overflow until roughly 80,000. The residual is real but sits at twice the depth, which matters only because this plan is adding a depth gate that must be set with a measured number rather than the gateway's.

**Reachability, stated honestly:** this is an operator-invoked command, not an unauthenticated route. The payload comes from a file or a pipe the operator chose. It ranks where it does because it is the last unguarded reader of a contract the rest of the harness now holds, and because the junk drafts it writes are indistinguishable from real ones afterwards.

## Current state

```ts
// src/cli.ts:1181
async function readJsonPayload(from: number): Promise<Record<string, unknown>> {
  const file = optValue("--file", from);
  if (!file && process.stdin.isTTY) { throw new Error("refusing to read the payload from a terminal; ..."); }
  const text = file ? readFileSync(file, "utf8") : await Bun.stdin.text();
  if (!text.trim()) throw new Error("empty payload; ...");
  return JSON.parse(text) as Record<string, unknown>;
}
```

`cmdIssues` wraps the call in a `try`/`catch` that prints `{ ok: false, error: String(e) }` and exits 1 — so every failure is *graceful*, and the operator's only signal is an exception class name in an `error` string that is not written for them to read.

## Evidence

Isolated `HOME`, real `src/cli.ts`, a scratch repo holding `.herdr-harness.json`:

```
=== wrong-shaped payloads through issues ingest --file ===
arr    -> { "ok": true,  "mode": "dry-run", ... "title": "[sentry] unknown: unknown error" }   exit=0
null   -> { "ok": false, "error": "TypeError: null is not an object (evaluating 'raw.message')" }
str    -> { "ok": true,  "mode": "dry-run", ... "title": "[sentry] unknown: unknown error" }   exit=0
```

Two of the three exit 0 having written a draft. The identity is content-derived and stable:

```
fingerprintFor("x")    = e8a7f60dcb3afe09
fingerprintFor([1,2,3]) = 44b0a592d9753c19

--- the drafts now in ~/.local/state/herdr-harness/issues ---
sentry-44b0a592d9753c19.json  fp=44b0a592d9753c19  status=mock-draft  title="[sentry] unknown: unknown error"
sentry-e8a7f60dcb3afe09.json  fp=e8a7f60dcb3afe09  status=mock-draft  title="[sentry] unknown: unknown error"
```

The depth residual, and the measurement that corrects plan 025's note:

```
payload bytes: 480001
--- 80k-deep payload through the CLI (no ceiling, no depth gate) ---
{ "ok": false, "error": "RangeError: Maximum call stack size exceeded."}

   2000 bytes=   12001 ok        40000 bytes=  240001 ok
  10000 bytes=   60001 ok        80000 bytes=  480001 RangeError: Maximum call stack size exceeded.
  20000 bytes=  120001 ok       200000 bytes= 1200001 RangeError: Maximum call stack size exceeded.
```

## Steps

1. Check the shape, do not cast it. Reuse the `isRecord` predicate already present in `src/issues.ts` (and mirrored in `gateway.ts` and `shared.ts`); `null`, `[]` and `"x"` should be a named refusal in the same envelope style as `"empty payload"`, not a `TypeError` string and not a silent success.
2. Bound the bytes before the read is parsed. `readFileSync` reads the whole file, so the ceiling has to be applied to the *file* — `stat` it, or read with a byte-limited read — rather than to the parsed result, or the allocation this is meant to prevent has already happened. Use the same ceiling the gateway enforces for the same payload, so the two entry points cannot disagree about what an event is.
3. Bound nesting, reusing the gateway's own `exceedsJsonDepth` / `MAX_JSON_DEPTH` constant. This is the same serialized-payload `RangeError` the gateway route was hardened against; the CLI is the same surface one step later.
4. Keep the TTY refusal (plan 020) and the empty-payload refusal exactly as they are. They are the reason this command is usable and neither is in scope.
5. Report the refusal in the operator's language — a named reason per bound, the way `payloadTooLarge` and the "invalid JSON" branch do — not `String(e)` over an internal exception.

## Tests

- Shape table: `null`, `[]`, `[1,2,3]`, `"x"`, `42`, `true` — each must be refused with a named error, exit nonzero, and **write no draft**. The "writes no draft" half is the load-bearing assertion; asserting only the exit code is what let this through.
- Depth: 40,000 levels refused, and a 64-level payload **accepted** — the ceiling must be a stated contract, not "whatever overflows". Assert both sides, per plan 025's lesson that the ceiling is a number and not a V8 accident.
- Size: a file just under the ceiling ingests; one just over is refused without the parse being attempted.
- A real Sentry-shaped event still ingests byte-identically — pin the ordinary case as a literal, the way plan 030 pinned uncut responses.
- One mutation-check: restore the bare cast and confirm the `null` case fails.

## Gates

- `bun test` green; `bun run typecheck` exit 0.
- `src/gateway.ts` untouched. If the depth helper is genuinely needed in two modules, promote it rather than importing `gateway.ts` into `cli.ts` — `cli.ts` already imports `lastIngress` from `gateway.ts`, so a small shared predicate in `shared.ts` is the clean direction, and a test should assert `gateway.ts` does not import `cli.ts` (the mirror of the import-list test plan 031 added).

## STOP conditions

- **Do not** raise the ceiling above the gateway's `INGRESS_REQUEST_MAX_BYTES` to accommodate a large real event. A real Sentry event is a few KB; plan 023's 96 KB draft cap already sits well below the request ceiling for exactly this reason.
- **Do not** change the depth ceiling to "whatever the engine tolerates". Measured 2026-10-02 on Bun 1.4.2 that is ~80,000 — a number that moves with the engine and with stack size, and therefore not a contract. Pin it at the gateway's 64 and let a real event that deep be a truncation case, not a crash.
- **Do not** retroactively delete the junk drafts this bug already wrote, and do not add a sweep. They are indistinguishable from real drafts, which is the point of the finding; a sweep keyed on `"unknown: unknown error"` would take real drafts with it.
- **Do not** treat this as closing plan 025's residual on its own. Update that plan's status row to point here so the residual is not filed twice.

## Acceptance

- `harness issues ingest` accepts an object and refuses everything else, with a named reason and no draft written.
- Oversize and too-deep payloads are refused before the parse, with a named reason.
- A real error event ingests byte-identically to before.
- 202+ tests green; `bun run typecheck` exit 0.
