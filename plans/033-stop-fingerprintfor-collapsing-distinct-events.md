# Plan 033: Stop `fingerprintFor` collapsing two distinct error events onto one draft

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 63937ed..HEAD -- src/issues.ts tests/issues-idempotent.test.ts tests/issues-bounds.test.ts README.md`
> If `fingerprintFor` no longer cuts to 200 characters — i.e. the fallback is a hash of the **full** serialized payload — STOP and report.

## Status

- **Priority:** P0
- **Effort:** S
- **Risk:** LOW–MED
- **Depends on:** `plans/007-idempotent-issue-ingest.md` (shipped), `plans/023-keep-issue-draft-body-publishable.md` (shipped), `plans/026-never-record-github-created-without-url.md` (shipped)
- **Category:** bug / data integrity
- **Confidence:** HIGH (reproduced 2026-10-02 against `63937ed`, both via the CLI and end to end through the unauthenticated `/ingress/sentry` route)
- **Planned at:** commit `63937ed`, 2026-10-02 (Run 7)

## Why this matters

`fingerprintFor` is the draft's identity: it keys the storage path, it is what plan 007's replay guard matches on, and it is what a caller correlates an ingest with. When an event carries no `event_id` / `eventId` / `id` **and** no `message` / `title`, it falls back to a **200-character prefix** of the serialized payload:

```ts
// src/issues.ts:38
export function fingerprintFor(raw: Record<string, unknown>): string {
  const id = str(raw.event_id) || str(raw.eventId) || str(raw.id);
  if (id) return id;
  const msg = str(raw.message) || str(raw.title) || JSON.stringify(raw).slice(0, 200);
  const culprit = str(raw.culprit) || str(raw.transaction) || "";
  return createHash("sha256").update(`${msg}|${culprit}`).digest("hex").slice(0, 16);
}
```

Two distinct incidents that agree through character 200 therefore hash identically, share one `sentry-<key>.json` path, and the second **silently overwrites the first**. If the first was already published, `mergePublishedState` then stamps the second with the first's `githubIssueUrl` and `status: "github-created"` — so plan 007's once-only guard reads it as *already published* and a genuine second alert is **never filed, permanently**, with `ok: true` reported to the caller.

That second half reaches further than the CLI: `mergePublishedState` is inside `writeIssueDraft`, so the **unauthenticated `202` itself** answers `status: "github-created"` for an incident that was never filed and never will be. A caller polling the route sees its own fresh alert come back marked as already-published against someone else's issue number.

Two places in the repo state the opposite:

- `src/issues.ts:80-82` — *"Fingerprint the **full** payload, before anything below is cut: two large events that share a prefix must not collapse onto one fingerprint and lose a real report."*
- `README.md:100` — *"the fingerprint is still computed from the full event, so truncation never merges two distinct errors into one."*

The protection is in the wrong layer. `buildDraft` correctly fingerprints before it cuts, and the *body* is bounded by plan 023 — but `fingerprintFor` itself is where the collapse happens, so neither the comment nor the README is true. This is the exact shape Runs 5 and 6 each named: **a shipped invariant that its own test could not reach.** Runs 5 and 6 both deferred it at MED confidence because the trigger "needs an id-less, message-less, title-less shape"; that shape is ordinary for a Sentry or Bugsink event carrying a stack trace.

**Reachability:** `/ingress/sentry` and `/ingress/bugsink` are unauthenticated. A payload of `{"stack": "<shared prefix>...", "culprit": "..."}` is a valid POST body and needs no id, message or title. The `stack` key is not read by any other code path, so nothing else normalizes it into shape first.

## Current state

```ts
// src/issues.ts:41 — the only place a caller-supplied id-less payload is cut
const msg = str(raw.message) || str(raw.title) || JSON.stringify(raw).slice(0, 200);

// src/issues.ts:272-274 — why the second event then inherits the first's publication
const previous = readStoredDraft(path);
const effective =
  previous && previous.status === "github-created" && typeof previous.githubIssueUrl === "string"
    ? mergePublishedState(draft, previous as unknown as IssueDraft)
    : draft;
```

`slice(0, 200)` also cuts **UTF-16 code units**, so a surrogate pair can be split mid-character; that is a correctness detail of the same line, not a separate finding.

## Evidence

Reproduced against `63937ed` with an isolated `HOME` and the real `src/issues.ts`. Two events, no id / message / title, agreeing through character 200 and differing after it:

```
A !== B as objects:       true
A and B differ after 200: true
fingerprintFor(A) = ce179fc1d217d61d
fingerprintFor(B) = ce179fc1d217d61d
COLLIDE:                  true
```

**Vector A — the second event overwrites the first, and the report is gone from disk:**

```
-- after ingesting BOTH distinct incidents --
draft files on disk: 1 [ "sentry-ce179fc1d217d61d.json" ]
stored body still contains ALPHA frame:  false
stored body contains BETA  frame:        true
```

**Vector B — if the first was already published, the second is permanently suppressed:**

```
-- after publishing A, then replaying B --
B's stored status:      github-created
B inherits A's URL:     https://github.com/example/repo/issues/101
publish B -> { ok: true, skipped: "already-published", command: [] }
```

**End to end, through the unauthenticated HTTP route** (real gateway on `127.0.0.1:18791`, isolated `HOME`, two `curl` POSTs to `/ingress/sentry` with distinct bodies sharing a 300-byte prefix):

```
POST ALPHA -> fingerprint=66d6f8beebb0e73f  id=66d6f8beebb0e73f
POST BETA  -> fingerprint=66d6f8beebb0e73f  id=66d6f8beebb0e73f

--- draft files in the fixture HOME ---
sentry-66d6f8beebb0e73f.json
--- which frame survived? ---
   sentry-66d6f8beebb0e73f.json | ALPHA=false BETA=true
```

The caller's own `202` tells it the two events are the same thing, and one of them no longer exists anywhere.

**The published arm, end to end, including the lie in the `202` itself** (real gateway, fake `gh` on a restricted `PATH` that counts its invocations):

```
### STEP 1  unauthenticated POST of incident A   (A.module = billing, B.module = search)
POST /ingress/sentry  A -> 202 28918603207f0b65

### STEP 2  operator: harness issues ingest --file A.json --execute
ok: true | url: https://github.com/acme/harness/issues/1001 | draft.status: github-created

### STEP 3  unauthenticated POST of incident B (a genuinely different alert)
POST /ingress/sentry  B -> 202 fingerprint 28918603207f0b65 status github-created

### STEP 4  operator: harness issues ingest --file B.json --execute
ok: true | url: https://github.com/acme/harness/issues/1001 | draft.status: github-created

### RESULT
gh was actually invoked 1 time(s):
drafts on disk: sentry-28918603207f0b65.json
```

`gh` ran **once**. The second incident is never filed, and both the `202` and the operator's `ok: true` report it against A's issue number.

**Likelihood, stated honestly:** a real Sentry or Bugsink webhook normally carries an `event_id`, which takes the first branch and is unaffected. The vulnerable shape is an id-less payload — a proxy or relay that drops the id, a hand-rolled sender, a second integration posting a bare stack. It is a low-barrier shape, and the failure is silent and unrecoverable, which is what makes it worth closing rather than documenting.

## Steps

1. Fingerprint the **full** serialized payload when falling back — drop the `.slice(0, 200)`. `createHash` accepts a string of any length, so there is no cost reason for the cut; it is not a bound, it is the bug.
2. If a bound is wanted for a different reason, it belongs on a *stable digest*, not on the pre-image: hash the whole thing, then truncate the **hex digest** (`.slice(0, 16)` is already there). Never truncate the input to a hash.
3. Leave the `event_id` / `eventId` / `id` branch alone. It returns the caller's id verbatim by design, and plans 023 and 030 both depend on that — the id is the draft's identity, and it is bounded where it is *displayed*, not where it is *stored*.
4. Leave `storageKeyFor` alone. It already hashes anything that is not a safe filename token, and `fingerprintFor` returning a 16-char hex digest stays inside `SAFE_KEY_RE`.
5. Correct the two false claims: the comment at `src/issues.ts:80-82` and the sentence at `README.md:100`. After the fix both become true; say so in the same commit rather than leaving a claim that no longer describes the code.

## Tests

Assert the **property**, not the fixture — Run 5's own lesson is that both of this run's integrity findings verified a property over the input space their fixture wrote rather than the input space the endpoint accepts.

- A table of id-less / message-less / title-less payload pairs that agree through the first 200 characters and differ after it, asserting `fingerprintFor` returns **different** values for each pair. Cover at least: two long `stack` strings, a payload whose first 200 chars are identical but whose keys are ordered differently, and a pair that differ only in the last byte.
- One astral-plane case (a surrogate pair straddling character 200) asserting the two fingerprints differ — this is what the UTF-16 cut broke independently of the collapse.
- An end-to-end pair through `writeIssueDraft`: ingest A, ingest B, assert **two** files exist and that A's body still contains A's frame on disk (read the bytes, not through `listIssueDrafts`).
- The published arm: publish A with a fake `gh`, then ingest B, then assert B's stored `status` is `mock-draft` and that `publishIssueDraft(B)` does **not** return `skipped: "already-published"`.
- One mutation-check: restore `.slice(0, 200)` and confirm the table above fails.

## Gates

- `bun test` green; `bun run typecheck` exit 0.
- `git diff --stat` shows `src/issues.ts` plus tests and docs only.

## STOP conditions

- **Do not** change what `fingerprintFor` returns for an event that *has* an id. Plans 023 and 030 are built on the whole id reaching storage and on the *reflection* being capped separately; touching this reopens both.
- **Do not** "fix" the collision by making the storage key include a timestamp or a nonce. That trades a lost report for an unbounded duplicate-report stream and breaks plan 007's once-only guard in the other direction.
- **Do not** add a second 200-char cut somewhere downstream to compensate.
- **Existing drafts keep their old fingerprints.** Do not add a migration or a re-key sweep; a draft's fingerprint is its identity, and rewriting it would orphan the publication record that makes it idempotent. Note the one-time consequence in the plan's acceptance notes: two events that were already collapsed under the old function stay collapsed, and there is no way to recover the overwritten one.

## Acceptance

- Two id-less events sharing a 200-character prefix produce two drafts, and both bodies remain on disk.
- A replayed id-less event still collapses onto its own draft (plan 007's guard still fires) — the fix narrows the key, it does not widen it.
- `README.md:100` and `src/issues.ts:80-82` describe what the code does.
- 202+ tests green; `bun run typecheck` exit 0.
