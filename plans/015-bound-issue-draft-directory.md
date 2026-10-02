# Plan 015: Bound the Sentry/Bugsink draft path — payload size and issues-directory growth

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat cbc0592..HEAD -- src/issues.ts src/gateway.ts tests/issues-paths.test.ts tests/issues-idempotent.test.ts`
> This plan builds on `plans/002-contain-issue-draft-paths.md` (filename containment) and `plans/007-idempotent-issue-ingest.md` (published-once guard). If `buildDraft`, `writeIssueDraft`, `fingerprintFor` or `mergePublishedState` have changed shape, re-read "Current state" before proceeding. Any change that weakens the published-once guard is a STOP condition — plan 007's idempotency is load-bearing and must survive this work.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED — a cap that is too low silently truncates genuine error reports, and the draft's serialized shape is consumed by idempotency logic
- **Depends on:** `plans/002-contain-issue-draft-paths.md`, `plans/007-idempotent-issue-ingest.md` (both shipped)
- **Category:** security
- **Confidence:** HIGH (reproduced 2026-10-02 against `cbc0592`; transcripts in "Evidence")
- **Planned at:** commit `cbc0592`, 2026-10-02

## Why this matters

`POST /ingress/sentry` and `POST /ingress/bugsink` are unauthenticated, and plan 010's bounds do not reach them. Those two routes bypass `handleIngress` entirely — they call `ingestErrorEvent` directly (`src/gateway.ts:526, 532`) — so they never touch `capBody`, `capText`, or the queue's byte budget. The draft they write is unbounded in both size and count.

Three concrete consequences, all reproduced:

1. **Unbounded disk growth.** Five unauthenticated POSTs of 2 MB each wrote 21 MB into the state directory, one 4.2 MB draft per request.
2. **`gh issue create` cannot be invoked at all** for a large event: the whole body becomes one argv element, `posix_spawn` returns `E2BIG`, and the operator is told the misleading `"gh not usable (gh)"` — implying their CLI is broken when the real cause is payload size.
3. **The failure envelope re-amplifies.** On that failure the CLI prints the entire `command` array, including the full multi-megabyte body, to stdout.

The route is also how real Sentry/Bugsink alerts arrive, so this path must keep working for genuine reports — a fix that silently drops the interesting part of a stack trace is worse than the bug.

## Current state

The route wiring has no bounds, `src/gateway.ts:523-534`:

```ts
if (req.method === "POST" && url.pathname === "/ingress/sentry") {
  const parsed = await parseJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const draft = ingestErrorEvent("sentry", parsed.body);
  return Response.json({ ok: true, source: "sentry", queued: true, draft }, { status: 202 });
}
if (req.method === "POST" && url.pathname === "/ingress/bugsink") {
  const parsed = await parseJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const draft = ingestErrorEvent("bugsink", parsed.body);
  return Response.json({ ok: true, source: "bugsink", queued: true, draft }, { status: 202 });
}
```

Compare the bounded matrix route, which returns only `result` — never the stored event — at `src/gateway.ts:509-515`. The error routes return the **entire draft**, which is where the per-request response amplification comes from.

`buildDraft` embeds the raw payload verbatim in the body *and* stores it again, `src/issues.ts:52-78`:

```ts
const body = [
  `Playbook: ${PLAYBOOK_SENTRY}`,
  `Source: ${source} (${sourceNote})`,
  `Project: ${project}`,
  `Level: ${level}`,
  culprit ? `Culprit: ${culprit}` : null,
  `Fingerprint: ${fingerprint}`,
  "",
  "```json",
  JSON.stringify(raw, null, 2),
  "```",
]
  .filter(Boolean)
  .join("\n");
...
return {
  id: fingerprint, title, body, labels, source,
  playbook: PLAYBOOK_SENTRY, fingerprint, createdAt,
  status: "mock-draft",
  raw,
};
```

That is the 2× amplification: a payload of N bytes produces roughly 2N on disk.

The body becomes a single argv element, `src/issues.ts:170-181`:

```ts
export function ghIssueCreateArgv(draft: IssueDraft): string[] {
  const spec = githubIssueSpec(draft);
  return [
    "issue", "create",
    "--title", spec.title,
    "--body", spec.body,
    ...spec.labels.flatMap((label) => ["--label", label]),
  ];
}
```

and `publishIssueDraft` passes it straight to `spawnSync` (`src/issues.ts:240-249`), whose bounded options from plan 009 cover *time* but say nothing about argument size.

The fingerprint is caller-supplied, so distinct ids create distinct files, `src/issues.ts:27-33`:

```ts
export function fingerprintFor(raw: Record<string, unknown>): string {
  const id = str(raw.event_id) || str(raw.eventId) || str(raw.id);
  if (id) return id;
  ...
}
```

Filename safety (plan 002) is already handled by `storageKeyFor` and `draftPathFor` (`src/issues.ts:89-104`) and is **not** in question here — only the file's *contents* and the directory's *cardinality* are.

`listIssueDrafts` (`src/issues.ts:291-304`) reads every draft in the directory, whole, into memory — and it is called by `harness issues list` (`src/cli.ts:886`), `harness pick` (`src/cli.ts:969`) and `harness summary` (`src/cli.ts:1076`), so growth here is paid on every operator command, not just at ingest.

## Evidence

All reproduced 2026-10-02 at `cbc0592` with an isolated `HOME`.

**(a) Unauthenticated write amplification, via HTTP:**

```
=== 5 unauthenticated POSTs of 2MB each to /ingress/sentry ===
  POST 0..4 -> 202
state dir size: 21M
-rw-r--r-- 4194987  sentry-amp-0.json
-rw-r--r-- 4194987  sentry-amp-4.json
```

2 MB in, 4.2 MB on disk — the 2× amplification, with no cap on either the payload or the file count.

**(b) CLI path, 3 MB payload:**

```
input bytes: 3145773
--- issues ingest 3MB payload (no --execute) ---
  ok: true, mode: "dry-run"
-rw-r--r-- 6292144  sentry-big-1.json
```

**(c) `gh` cannot be invoked; error message is misleading:**

```
payload bytes: 4194349
"error": "gh not usable (gh): E2BIG: argument list too long, posix_spawn 'gh'"
-rw-r--r-- 8389298  sentry-huge-1.json
```

4.2 MB payload → 8.4 MB draft → `E2BIG` at spawn. `gh` is present and working; the message blames it anyway. The same run printed the entire multi-megabyte body inside the `command` array on stdout.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `bun --version` | supported Bun (audit: 1.4.2) |
| Prerequisite | `bun test` | all 104 existing cases pass |
| Prerequisite suites | `bun test tests/issues-paths.test.ts tests/issues-idempotent.test.ts` | pass unchanged |
| New regression gate | `bun test tests/issues-bounds.test.ts` | all cases pass |
| Full gate | `bun test && git diff --check` | exit 0 |

No install or build. Fixtures live only under `dist/.test-tmp/`. No real `gh` and no network — use a fixture `gh` on a restricted `PATH`, following `tests/fixtures/issues-gh-runner.ts`.

## Suggested executor toolkit

- `tests/issues-gh-timeout.test.ts` and `tests/fixtures/issues-gh-timeout-runner.ts` are the structural pattern for a fixture-`gh` test with a restricted `PATH` and a bounded wall-clock assertion.
- `src/gateway.ts:87-110` holds `capBody` and `capText` — the exact "cap a value, mark the truncation, record the original size" shape this plan should reuse for draft payloads, even though that code is out of scope to edit.
- `tests/fixtures/issues-gh-runner.ts` is the shortest existing example of driving the publish path end to end.

## Scope

**Only modify:**
- `src/issues.ts` — a payload cap with truncation flags, a directory bound, and the `E2BIG` error classification in `publishIssueDraft`
- `src/gateway.ts` — the `/ingress/sentry` and `/ingress/bugsink` response shape only (return a projection, not the whole draft)
- `tests/issues-bounds.test.ts` (new)
- `tests/fixtures/issues-bounds-runner.ts` (new)
- The `issues ingest` section of the README
- This plan's row in `plans/README.md`

**Out of scope (do NOT touch, even though they look related):**
- `storageKeyFor` and `draftPathFor` (`src/issues.ts:89-104`) — plan 002's containment logic; do not weaken or refactor it
- `mergePublishedState` and the published-once guard at `src/issues.ts:141-144` and `:224-236` — plan 007's idempotency; your truncation must not change what it compares
- `src/gateway.ts`'s ingress caps — that is plan 014
- `ghTimeoutMs`, the timeout options and the `ETIMEDOUT`/`SIGKILL` detection at `src/issues.ts:191-203, 240-249` — plan 009's shipped work
- Changing the `gh` argv shape, the labels, or adding a GitHub API client
- Any real `gh` invocation, network call, or issue creation
- Matrix/Telegram/chat ingress, `/chat execute`, and everything in `src/chat.ts`

## Git workflow

No branch/worktree creation, commit, push or PR. Preserve unrelated work. Any later implementation needs separate authorization.

## Steps

### Step 1: Cap the draft payload and mark the truncation

Add a bound in `src/issues.ts` for the serialized raw payload embedded at `src/issues.ts:61` and stored at `:77`. Reuse the `capBody` shape: above the cap, store a prefix of the serialized payload and set explicit `bodyTruncated` / `bodyBytes` fields on `IssueDraft`, so a truncated draft is visibly truncated rather than quietly short. Apply the same cap to both the embedded `body` string and the stored `raw` — they are the same bytes written twice, and capping only one leaves the amplification in place.

Choose the threshold against real envelopes: Sentry and Bugsink events are typically a few KB, but stack traces and breadcrumb lists run larger. A ceiling in the low hundreds of KB is generous for a real alert while keeping a draft well inside what `gh` and `listIssueDrafts` can handle. **Justify the number in a comment** and record what a real event looks like when you pick it.

(For reference when choosing: `raw` is the `raw,` line at `src/issues.ts:77`, and the embedded copy is the `JSON.stringify(raw, null, 2)` at `src/issues.ts:61`.)

Store the cap alongside the module's other constants so it is discoverable next to `GH_TIMEOUT_ENV` (`src/issues.ts:186-189`).

**Verify:** a draft built from an oversized payload has `bodyTruncated: true`, a `bodyBytes` above the cap, and a stored `raw` within the bound.

### Step 2: Bound the issues directory

Cap the directory by count and total bytes, the way `trimQueue` bounds the ingress queue at `src/gateway.ts:116-128`. Two requirements that make this more than a copy-paste:

- **Eviction must be safe.** A draft is the record of what was filed. Never evict a draft whose `status` is `github-created` — that record is what prevents a duplicate issue. Evict oldest-first among `mock-draft` entries only, and only when the count or byte budget is actually exceeded.
- **A single draft may exceed the budget.** Prefer refusing or trimming over evicting everything; make the steady state reachable.

Report what happened in the return value so the operator can see eviction rather than discovering missing drafts later.

**Verify:** after ingesting past the cap, the directory stays within budget, and every `github-created` draft survives.

### Step 3: Classify `E2BIG` separately from "gh not usable"

`publishIssueDraft` currently reports every spawn failure as `gh not usable (${ghBin})` (`src/issues.ts:274-277`), which is wrong for an argument-list failure — the binary is present and working. Add a distinct branch for `error.code === "E2BIG"` that says the issue body exceeded the OS argument limit and names the payload size, pointing at the `--body` truncation rather than at the operator's `gh` setup.

Keep the existing message for a genuinely missing or unusable binary so plan 009's tests and operators are unaffected.

**Verify:** with a fixture `gh` and an oversized draft, the error names the argument limit and does not say `gh not usable`.

### Step 4: Shrink the sentry/bugsink response

`src/gateway.ts:526, 532` return the entire draft — including `raw` and the full `body` string — in the 202 response. Return a projection instead, mirroring what `projectEvent` does for `/status` and what the matrix route already returns. Keep the fields a caller needs to correlate the ingest (fingerprint, path, status, truncation flags).

**Verify:** the 202 response for a 2 MB payload is bounded in size and still carries the fingerprint and path.

### Step 5: Regression coverage

Create `tests/issues-bounds.test.ts` and `tests/fixtures/issues-bounds-runner.ts` following `tests/fixtures/issues-gh-runner.ts` and `tests/fixtures/issues-gh-timeout-runner.ts`. Cases:

1. Characterization: an ordinary Sentry event produces the same draft shape as today, with no truncation flags — the anti-regression case.
2. Characterization: plan 007's published-once guard still holds after truncation — replaying the same oversized `event_id` does not file twice, and `mergePublishedState` still carries `githubIssueUrl`/number across the rewrite.
3. Oversized payload → truncated draft with `bodyTruncated`/`bodyBytes` set, and `raw` within the cap.
4. Directory bound: ingesting past the count and byte caps evicts oldest `mock-draft` drafts only; a `github-created` draft is never evicted.
5. A `github-created` draft survives every eviction round.
6. `E2BIG` is reported as an argument-limit failure, not as `gh not usable`; a genuinely missing `gh` still reports `gh not usable (gh)`.
7. Gateway 202 for `/ingress/sentry` with an oversized payload is bounded and carries fingerprint + path.

**Verify:** `bun test tests/issues-bounds.test.ts` → all cases pass.

### Step 6: Full regression and boundary check

**Verify:** `bun test && git diff --check` → exit 0. `bun test tests/issues-paths.test.ts tests/issues-idempotent.test.ts tests/issues-gh-timeout.test.ts` → pass **unmodified**. `git status --short` → scoped changes only.

## Test plan

Add `tests/issues-bounds.test.ts` and `tests/fixtures/issues-bounds-runner.ts` in the established isolated-fixture style: temporary `HOME` under `dist/.test-tmp/`, `PATH` limited to a fixture bin, no real `gh`, no network, no GitHub. Assert on-disk directory size, draft field values, exit status and JSON envelopes.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun test` exits 0; `tests/issues-paths.test.ts`, `tests/issues-idempotent.test.ts` and `tests/issues-gh-timeout.test.ts` pass **unmodified**
- [ ] `bun test tests/issues-bounds.test.ts` passes
- [ ] The issues directory stays within its count and byte budget under sustained ingest
- [ ] No single ingest writes an unbounded file
- [ ] A `github-created` draft is never evicted by the directory bound
- [ ] `E2BIG` is reported distinctly from `gh not usable`
- [ ] The `/ingress/sentry` and `/ingress/bugsink` 202 responses are bounded in size
- [ ] Truncated drafts carry a visible `bodyTruncated` flag and original `bodyBytes`
- [ ] An ordinary event's draft is byte-identical to today's
- [ ] `git diff --check` passes; file scope respected; `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Truncating the stored `raw` would change what `fingerprintFor` or plan 007's published-once guard compares — in that case the fingerprint must be computed **before** truncation, and if that is not already true, report it rather than reordering the guard.
- The directory bound cannot be made to preserve `github-created` drafts without changing their on-disk format.
- A cap that is required to keep `gh issue create` working is lower than a real Sentry envelope — report the tension rather than silently shipping data loss.
- The fix appears to require changing the `gh` argv shape, plan 002's path containment, or plan 009's timeout semantics.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **What a reviewer should scrutinize:** that `fingerprintFor` still runs on the *full* payload. If truncation were applied before fingerprinting, two different large events could collapse onto one fingerprint and lose a real report — the opposite of the intent. Verify the ordering, do not assume it.
- Eviction deletes operator-visible data. The `github-created` exclusion is the safety boundary; treat any change to it as a data-loss review.
- `IssueDraft` gains optional fields. `listIssueDrafts` casts parsed JSON to `IssueDraft` without validation (`src/issues.ts:297`), so a draft written by an older version simply lacks the flags — read them as possibly-absent.
- **Paired plan:** plan 014 bounds the matrix/telegram/chat ingress fields in `src/gateway.ts`; this plan bounds the error-ingress draft path in `src/issues.ts`. Both are the same threat class (unauthenticated POST → unbounded disk) and both are needed.
- **Deferred, explicitly not in this plan:** `writeIssueDraft` uses a bare `writeFileSync` (`src/issues.ts:146`) while `src/gateway.ts:78-82` has an atomic temp+rename helper — a truncated draft makes `readStoredDraft` return `null`, which would bypass plan 007's guard. Promoting that helper into `src/shared.ts` and routing all five state writers through it is a separate, worthwhile change; it is listed in `plans/README.md` under considered-and-deferred for a later run.
