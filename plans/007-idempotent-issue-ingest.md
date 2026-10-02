# Plan 007: Make issue ingest idempotent and publish deduplicated

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or real GitHub calls without separate authorization.
>
> **Drift check (first):** `git diff --stat b96a1ec..HEAD -- src/issues.ts src/gateway.ts src/cli.ts tests/issues-github.test.ts`
> Compare changed code against the excerpts below. Plan 002's `storageKeyFor` containment work is expected in `src/issues.ts` and must not be reverted. STOP on unexplained drift.

## Status

- **Priority:** P1
- **Effort:** S
- **Risk:** MED — the published-draft state transition changes on re-ingest; existing mock-draft filenames and `gh` argv must stay byte-identical
- **Depends on:** `plans/001-isolated-test-baseline.md`
- **Category:** bug / data integrity
- **Confidence:** HIGH (reproduced 2026-10-02 against `b96a1ec` with a recording `gh` fixture; transcript in "Evidence")
- **Planned at:** commit `b96a1ec`, 2026-10-02

## Why this matters

Error-tracking upstreams replay events constantly (Sentry retries, Bugsink backfills, a re-run of the same ingest command). A replay should be a no-op. Today it is not: the second delivery of the same event both files a **second GitHub issue** for one bug and silently rewinds the stored draft from `github-created` back to `mock-draft`, dropping the issue URL and number. The published issue then reappears as pickable work in `harness pick`, and the record of what was filed where is gone. Plans 001-006 all assume drafts are write-once state; this makes that assumption true.

## Current state

`src/issues.ts:120-122` is the single ingest entry point behind both the CLI and the two gateway ingress routes:

```ts
export function ingestErrorEvent(source: "sentry" | "bugsink", raw: Record<string, unknown>): IssueDraft {
  return writeIssueDraft(normalizeErrorEvent(source, raw));
}
```

`normalizeErrorEvent` → `buildDraft` always constructs a fresh draft with `status: "mock-draft"` (`src/issues.ts:76`). `writeIssueDraft` (`src/issues.ts:106-118`) resolves the path from the fingerprint and overwrites the file unconditionally — it never reads what is already there. `fingerprintFor` (`src/issues.ts:27-33`) returns `event_id`/`eventId`/`id` verbatim when present, so a replay of the same event resolves to the **same** `sentry-<fingerprint>.json` path and overwrites the published record.

`publishIssueDraft` (`src/issues.ts:168-196`) runs `gh issue create`, then rewrites the draft as published:

```ts
const url = stdout.match(/https:\/\/github\.com\/\S+\/issues\/(\d+)/)?.[0];
const issueNumber = url ? Number(url.split("/").pop()) : undefined;
const stored = writeIssueDraft({
  ...draft,
  status: "github-created",
  ...
});
```

It has no way to know an issue was already filed for this fingerprint, because by the time it runs, `src/cli.ts:887` has already overwritten the published record with a fresh mock draft:

```ts
const draft = ingestErrorEvent(source, raw);   // rewrites the file first
if (!execute) { ...dry-run... return; }
const result = publishIssueDraft(draft);        // then unconditionally creates
```

The same ingest path backs `POST /ingress/sentry` and `POST /ingress/bugsink` (`src/gateway.ts:329-340`), so an upstream replay over HTTP resets the state identically. No existing test (`tests/issues-github.test.ts`, `tests/pick-delivery.test.ts`) ingests the same fingerprint twice.

## Evidence

Reproduced 2026-10-02 at `b96a1ec` with a recording `gh` on `PATH` and an isolated `HOME`:

```
# 1. publish the same event twice through the CLI
$ harness issues ingest --source sentry --file payload.json --execute   # event_id "probe-1"
  draft.status = "github-created", githubIssueNumber = 42
$ harness issues ingest --source sentry --file payload.json --execute   # identical payload
  gh call log lines: 2            <-- two `gh issue create` runs, one event

# 2. replay the same event over the gateway ingest path
$ harness issues list --json        -> status "github-created"
$ POST /ingress/sentry {event_id:"probe-1", ...}   (identical body)
  ingested status: mock-draft  url: (none)
$ harness issues list --json        -> status "mock-draft", githubIssueUrl/Number gone
$ harness pick --json               -> {"id":"issue:probe-1","kind":"issue","severity":"error"}
```

Step 1 is a real duplicate GitHub issue. Step 2 is a published issue resurrected as work.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `bun --version` | supported Bun (audit: 1.4.2) |
| Prerequisite | `bun test` | all 72 existing cases pass |
| New regression gate | `bun test tests/issues-idempotent.test.ts` | all cases pass |
| Full gate | `bun test && git diff --check` | exit 0 |

No install or build. These tests are proposed, not already run. Test fixtures live only in `dist/.test-tmp/`.

## Scope

**Only modify:** `src/issues.ts`, `tests/issues-idempotent.test.ts` (new), `tests/fixtures/issues-idempotent-runner.ts` (new), and this plan's row in `plans/README.md`.

**Out of scope:** changing `gh` argv, labels, title/body formatting or the playbook; adding a `--force`/`--republish` flag; retries, backoff or a real GitHub API client; `pick` ordering; gateway routing; manager code; dependencies; release-please; other repos; tokens, crons and remotes.

## Git workflow

No branch/worktree creation, commit, push or PR. Preserve unrelated work. Any later implementation or publication needs separate authorization.

## Steps

### Step 1: Read the existing draft before writing

In `writeIssueDraft`, read the target path when it exists and merge, so a replay cannot erase published state. Preserve existing filename resolution and the `path` field exactly; `tests/issues-paths.test.ts` (plan 002) asserts ordinary IDs keep the legacy filename and unsafe ones get the `~<sha256>` form. When the stored draft already has `status: "github-created"` with a `githubIssueUrl`, keep `status`, `githubIssueUrl` and `githubIssueNumber` from the stored copy while refreshing volatile fields; keep the original `createdAt` too, since that is when the issue was first seen and `pick` tie-breaks on it.

Return the merged draft from `writeIssueDraft` so callers observe the effective state rather than the raw inbound one.

**Verify:** `bun test tests/issues-paths.test.ts tests/issues-github.test.ts tests/pick-delivery.test.ts` → all pass, unchanged.

### Step 2: Deduplicate publication

Add a pre-flight guard in `publishIssueDraft`: if the effective draft already has `status: "github-created"` and a `githubIssueUrl`, do not spawn `gh`. Return the existing `GhCreateOutcome` shape with `ok: true`, the recorded `url`/`issueNumber`, `status: null`, and one new optional field such as `skipped: "already-published"`. Do not change fields consumed by `src/cli.ts:888-901`; `github.url` and `github.issueNumber` keep working because they read `result.url`/`result.issueNumber`.

The dry-run path stays as-is: `harness issues ingest` without `--execute` keeps showing the intended `gh` argv for a first-time event. Showing the recorded URL instead of a create command for an already-published draft is preferable, but do not change the dry-run envelope's required fields.

**Verify:** `bun test tests/issues-idempotent.test.ts` → publish-twice records exactly one `gh` call.

### Step 3: Add regression coverage

Create `tests/issues-idempotent.test.ts` on plan 001's `tests/helpers.ts` (`createFixture`, `runCli`, `assertIsolation`) with a fixture `gh` that appends each argv to a capture file, following the recording pattern in `tests/fixtures/issues-gh-runner.ts`. Cover at least:

1. Characterize current naming: one ingest writes exactly `sentry-<event_id>.json` with `status: "mock-draft"`.
2. Ingest → `--execute` → ingest the identical payload again: the `gh` capture holds exactly one call; the stored draft still reports `github-created` with its recorded number and URL.
3. Direct `ingestErrorEvent` replay (the gateway path) on a published draft: status and URL survive, and `harness issues list --json` agrees.
4. Replay through `handleGatewayRequest` (`POST /ingress/sentry`, as `tests/fixtures/gateway-chat-runner.ts` does) leaves the stored draft published.
5. After that replay, `harness pick --json` does not offer the published issue as `kind: "issue"`.
6. A genuine second event with a different `event_id` still ingests, still publishes, and both drafts coexist.

Assert CLI exit codes as well as stdout JSON. No network, no real `gh`, no real GitHub.

**Verify:** `bun test tests/issues-idempotent.test.ts` → all cases pass.

### Step 4: Full regression and boundary check

Run the complete suite and read the production diff.

**Verify:** `bun test && git diff --check` → exit 0 (72 existing cases plus the new file). `git diff -- src/issues.ts` → changes confined to draft merging and the publish guard. `git status --short` → scoped changes only.

## Test plan

Add `tests/issues-idempotent.test.ts` with the six cases above and `tests/fixtures/issues-idempotent-runner.ts` reusing the recording-`gh` pattern. Every test runs in an isolated `HOME` under `dist/.test-tmp/`, asserts stdout JSON plus exit status, and inspects the on-disk draft directly. `PATH` is restricted to the fixture bin. No live socket, network, worktree or GitHub call.

## Done criteria

- [x] Focused and full Bun suites exit 0.
- [x] A replayed event never issues a second `gh issue create`.
- [x] A replayed event never resets `github-created` back to `mock-draft`; recorded URL/number survive.
- [x] A published draft never reappears as `kind: "issue"` in `harness pick`.
- [x] First-time drafts keep their exact filenames, labels, `gh` argv and dry-run envelope (plan 002 and plan 004 regressions hold).
- [x] `git diff --check` passes; file scope respected; index row updated.

## STOP conditions

Stop if plan 002's filename behavior has changed, if deduplication would require changing the `gh` argv, if preventing duplicates requires a network call or a store outside the existing issues directory, if draft merging breaks `tests/issues-paths.test.ts`, if out-of-scope changes appear necessary, or after two failed gate attempts.

## Maintenance notes

Fingerprint stability is the whole mechanism: any change to `fingerprintFor` re-opens this class of bug. If event identity ever gains an occurrence counter, the storage key must stay keyed on stable event identity, not on count. Deferred: dedupe windows, cross-repo duplicate search via `gh issue list`, and a `--republish` escape hatch.
