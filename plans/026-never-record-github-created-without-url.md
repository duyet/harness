# Plan 026: Never record `github-created` without a URL, or plan 007's once-only guard silently misses (residual of plan 007)

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat cba1548..HEAD -- src/issues.ts tests/issues-github.test.ts tests/issues-idempotent.test.ts`
> If `publishIssueDraft` already refuses to persist `github-created` without a resolved URL, STOP and report.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** LOW–MED — the change makes a previously "successful" publish report a different outcome, which is the correct outcome but is a visible behaviour change
- **Depends on:** `plans/007-idempotent-issue-ingest.md` (shipped)
- **Category:** bug / data integrity
- **Confidence:** HIGH (reproduced end to end 2026-10-02 against `cba1548`; transcript in "Evidence")
- **Planned at:** commit `cba1548`, 2026-10-02 (Run 5)

## Why this matters

Plan 007 was filed for one harm, stated in its own title: *"Make issue ingest idempotent and publish deduplicated."* Its guard is `status === "github-created" && githubIssueUrl` — it treats a URL as the proof that publication happened.

But the writer can produce that state **without** a URL. `gh` is not required to print a `github.com` URL, and the value it prints is truncated before the regex ever sees it:

```ts
const stdout = (r.stdout || "").trim().slice(0, 500);                 // src/issues.ts:388
...
const url = stdout.match(/https:\/\/github\.com\/\S+\/issues\/(\d+)/)?.[0];   // :437 — host is hardcoded
...
const stored = writeIssueDraft({
  ...draft,
  status: "github-created",                     // <-- written unconditionally on exit 0
  ...(url ? { githubIssueUrl: url } : {}),      // <-- and may simply be absent
});
```

Two independent triggers:

1. **A non-`github.com` host.** The regex hardcodes `github\.com`. `gh` prints `https://ghe.example.com/owner/repo/issues/42` for GitHub Enterprise Server (`GH_HOST`, or `gh auth login --hostname`). Exit 0, issue filed, URL not matched.
2. **A wrapper or newer `gh` that writes >500 characters to stdout** before the URL. The URL is sliced away and cannot match.

When that happens, **both** once-only guards miss, and the second one is actively destructive:

- `publishIssueDraft` (`src/issues.ts:361`) — `draft.githubIssueUrl` is falsy, so the guard does not fire and **`gh issue create` spawns again**.
- `writeIssueDraft` (`src/issues.ts:240-243`) — requires `typeof previous.githubIssueUrl === "string"`, so it treats the file as unpublished and **overwrites `github-created` back to `mock-draft`**, destroying the only record that the event was published.

The operator sees `ok: true` with `url: null`. The natural response — re-run — files a second issue for the same event. That is precisely the harm plan 007 exists to prevent, reintroduced through a path plan 007 did not consider.

## Current state

The two guards, both requiring a URL:

```ts
// src/issues.ts:361 — publish path
if (draft.status === "github-created" && draft.githubIssueUrl) { /* skip */ }

// src/issues.ts:240-243 — ingest path
const effective =
  previous && previous.status === "github-created" && typeof previous.githubIssueUrl === "string"
    ? mergePublishedState(draft, previous as unknown as IssueDraft)
    : draft;
```

and the writer that breaks their precondition, `src/issues.ts:437-444`:

```ts
const url = stdout.match(/https:\/\/github\.com\/\S+\/issues\/(\d+)/)?.[0];
const issueNumber = url ? Number(url.split("/").pop()) : undefined;
const stored = writeIssueDraft({
  ...draft,
  status: "github-created",
  ...(url ? { githubIssueUrl: url } : {}),
  ...(issueNumber != null ? { githubIssueNumber: issueNumber } : {}),
});
```

Note this is *not* a regex-accuracy nit: `issueNumber` is derived correctly whenever a URL is found (the regex ends in `(\d+)` and `?.[0]` is group 0, so `pop()` is the captured digits), and non-`github.com` URLs are still perfectly good proof of publication. The defect is that **"we did not parse the URL" is being recorded as "there is no URL"**, and the guards read the second as the first.

No test covers it: `tests/fixtures/issues-bounds-runner.ts` uses a fake `gh` that always prints `https://github.com/duyet/harness/issues/100`, and there is no GH-host or enterprise fixture anywhere in the tree.

## Evidence

Reproduced 2026-10-02 at `cba1548`, isolated `HOME`, scratch repo, fake `gh` on a restricted `PATH` that prints a GitHub Enterprise URL and appends to a call log.

**One event, published once:**

```
=== RUN 1: ingest --execute against a GHES-style host ===
ok: True | url: None | status on disk: github-created | githubIssueUrl: None
```

`gh` exited 0 and filed the issue; the harness reports success and stores no URL.

**The identical event, re-ingested:**

```
run 1 -> cumulative gh invocations: 1
run 2 -> cumulative gh invocations: 2
```

**Two `gh issue create` calls for one event — a duplicate GitHub issue.**

**And the published record is destroyed by a plain re-ingest:**

```
=== plain re-ingest (no --execute) after the publish ===
status on disk : mock-draft  <- the github-created marker was erased
```

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Prerequisite | `bun test` | 169 green |
| New gate | `bun test tests/issues-idempotent.test.ts tests/issues-github.test.ts` | pass |
| Full gate | `bun test && git diff --check` | exit 0 |

## Scope

**Only modify:**
- `src/issues.ts` — `publishIssueDraft` (and, if needed, `writeIssueDraft`'s guard)
- `tests/issues-idempotent.test.ts` / `tests/issues-github.test.ts` + fixture runners
- `plans/README.md` status row

**Out of scope:**
- Making the URL regex host-aware as the *primary* fix (Step 2 offers it as defence in depth, not as the fix)
- The draft body size limits — that is plan 023
- The `gh` timeout / E2BIG handling (plan 009 / plan 023)
- Auth on ingress, release-please, herdr-desk, other repos

## Steps

### Step 1: Do not persist a published state you cannot identify

The core fix: if `gh` exited 0 but no URL was parsed, we do know an issue was filed, and we must not write a state that the once-only guards read as "not published". Return the ambiguous outcome to the caller and leave the draft as it was:

```ts
if (!url) {
  // gh exited 0, so the issue was filed — but we could not identify it.
  // Do NOT persist `github-created`: both once-only guards key on a URL, so
  // that state would be read as "never published" and the next ingest would
  // file a duplicate. Leave the draft a mock-draft and say so plainly.
  return {
    ok: false,
    command, status: r.status, stdout, stderr,
    error: `gh exited 0 but printed no recognisable issue URL, so the issue may ` +
           `have been filed and cannot be linked to this draft. Re-running risks a ` +
           `duplicate; check the repository's issues before retrying.`,
    draft,
  };
}
```

This mirrors the reasoning the timeout branch already uses at `src/issues.ts:390-403`, which correctly declines to persist when it "does not know whether GitHub filed the issue". The URL-miss case belongs to that same family and should get the same treatment.

**Do not** simply widen the two guards to key on `status` alone. That would make them fire for drafts written by an older version with a stale or absent URL, and it would paper over the real problem — the harness has an unidentifiable published outcome it is currently mis-recording.

### Step 2: Widen the recogniser (defence in depth, optional)

Make the host flexible so GHES output is *identified* rather than merely tolerated:

```ts
const url = stdout.match(/https:\/\/[^\s/]+\/[^\s]*\/issues\/(\d+)/)?.[0];
```

and read the full stdout for the URL before slicing it to 500 for display. Prefer parsing a separate untruncated copy of `r.stdout` over raising the slice cap — the 500-char slice exists to bound what is *reported*, which is a different concern from what is *matched*.

This is worth doing on its own merits: with Step 1 alone, a GHES operator would get a permanent "may have been filed, do not re-run" on every publish. With Step 2 they get the normal successful path.

### Step 3: Regression

Add fixtures for, at minimum:

- `gh` exits 0 printing a `ghe.example.com` URL → with Step 2, recorded normally with the URL; without it, the ambiguous failure and **the draft still a `mock-draft`**
- `gh` exits 0 printing >500 chars before the URL → same
- in every case where the draft is left un-published, assert a **second** ingest does not file a duplicate, and that the `github-created` marker is not erased
- the ordinary `github.com` path stays byte-identical

## Done criteria

- [ ] No input causes `status: "github-created"` to be written without a URL
- [ ] An unidentifiable publish never leads to a second `gh issue create` for the same event
- [ ] A plain re-ingest never erases a `github-created` marker
- [ ] GHES output is recorded with its URL (if Step 2 lands)
- [ ] Ordinary `github.com` publishes are byte-identical to before
- [ ] `bun test` exit 0; `plans/README.md` row → DONE when executed

## STOP conditions

- Leaving the draft as `mock-draft` on an ambiguous publish turns out to make a common workflow unusable — surface it. The right answer is then Step 2 plus a clearer signal, **not** persisting an unidentifiable published state.
- The maintainer decides an unidentifiable publish should be recorded as published anyway — that is a defensible product call, but it must be a deliberate change to *both* guards together, and it must be recorded in this plan's status row.