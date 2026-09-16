# Plan 002: Keep issue-draft writes inside the issues directory

> **Executor instructions:** Execute only after separate implementation authorization. Follow the steps and STOP conditions. Update this plan's row in `plans/README.md`; do not commit, push or publish anything.
>
> **Drift check:** `git diff --stat b17bb04..HEAD -- src/issues.ts tests/issues-paths.test.ts`
> Compare changed code against the excerpts; unexplained mismatches require a STOP. Plan 001 introduces a test helper but does not change these production excerpts.

## Status

- **Priority:** P1
- **Effort:** S (hours, including tests)
- **Risk:** MED — filename compatibility must be preserved for ordinary IDs
- **Depends on:** `plans/001-isolated-test-baseline.md`
- **Category:** security
- **Confidence:** HIGH (static source verification; no misuse probe run)
- **Planned at:** commit `b17bb04`, 2026-09-16

## Why this matters

Incoming event identifiers become filesystem path components without validation. Separators and parent components can influence the resolved destination; existing intermediate directories affect whether a particular write succeeds. Treating these identifiers as data rather than paths prevents unintended writes and also avoids errors from ordinary IDs containing filesystem-special characters. This is a local/mock ingress boundary fix, not a new authentication or storage system.

## Current state

`src/issues.ts:24–29` returns a supplied event ID verbatim:

```ts
const id = str(raw.event_id) || str(raw.eventId) || str(raw.id);
if (id) return id;
const msg = str(raw.message) || str(raw.title) || JSON.stringify(raw).slice(0, 200);
const culprit = str(raw.culprit) || str(raw.transaction) || "";
return createHash("sha256").update(`${msg}|${culprit}`).digest("hex").slice(0, 16);
```

`src/issues.ts:69–74` then uses that identifier for storage:

```ts
mkdirSync(ISSUES_DIR, { recursive: true });
const path = join(ISSUES_DIR, `${draft.source}-${draft.fingerprint}.json`);
const stored = { ...draft, path };
writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`);
return stored;
```

`src/issues.ts:81–93` lists all JSON files in that directory, independent of filename format. The logical `id` and `fingerprint` are also used by picking and display, so preserve them. `src/gateway.ts:213–221` and `src/cli.ts:504–506` both reach `ingestErrorEvent`; correcting the common write boundary protects both without changing their callers.

Conventions: match the existing `createHash("sha256")` Node API, named helpers, `.ts` imports, double quotes, semicolons and two-space indentation. Reuse JSON formatting above. README explicitly says ingestion creates mock drafts and never calls GitHub (`README.md:69–84`); retain that behavior.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `bun --version` | supported Bun; audit used 1.4.2 |
| Prerequisite tests | `bun run test` | all baseline cases pass |
| Focused tests (new) | `bun test tests/issues-paths.test.ts` | all cases pass |
| Full verification | `bun run test && git diff --check` | exit 0 |

No install or build is needed. There are no lint/typecheck commands at the audited revision. Bun tests are not a typecheck. These new test gates have not yet been executed by the advisor.

## Scope

**Only modify:** `src/issues.ts`, `tests/issues-paths.test.ts` (new), and this plan's status row in `plans/README.md`.

**Out of scope:** changing fingerprints or logical IDs, migration/deletion of existing drafts, draft schema changes, gateway/CLI code, symlink attack defenses against a hostile local filesystem owner, dependency changes, release-please, versions, real user state, other repos, integrations, tokens, crons, remotes and issues.

Test artifacts must remain in owned fixture directories under `dist/.test-tmp/` using the prerequisite helper.

## Git workflow

No branch, worktree, commit, push or PR is required or authorized here. Preserve the user's working tree outside the scoped files. The repository's observed history uses imperative subjects; any future commit requires a separate request.

## Steps

### Step 1: Characterize safe compatibility

Create `tests/issues-paths.test.ts`. Use `tests/helpers.ts` from Plan 001: isolated HOME/cwd set before the child imports application modules, explicit subprocess timeout, cleanup of only owned fixture directories. Check that ordinary event IDs using ASCII letters, numbers, underscore or hyphen retain the current basename and that storing the same source and ID twice still produces one draft. Also assert the returned `path` names the stored JSON file and listing reads it.

**Verify:** `bun test tests/issues-paths.test.ts` → safe compatibility cases pass before changing production code.

### Step 2: Derive a filesystem-only key at the write boundary

In `writeIssueDraft`, validate that source is exactly `sentry` or `bugsink` at runtime (exported TypeScript functions can be called by untyped consumers). Require a string fingerprint. For fingerprints matching `/^[A-Za-z0-9_-]{1,128}$/`, preserve the existing filename. For every other string, generate a deterministic safe key consisting of `~` followed by the full SHA-256 hex digest of the fingerprint. The `~` namespace is deliberately excluded from the direct-ID allowlist so a valid direct ID cannot alias a hashed filename.

Construct `<source>-<storageKey>.json` and assert the resolved candidate's parent equals the resolved issues directory before any write. Keep the original `id`, `fingerprint`, raw event and returned draft shape unchanged. Do not create directories named by event data, silently strip unsafe characters, or migrate prior files. Invalid source/non-string fingerprint must throw before directory creation/writes.

Add defensive tests for IDs containing separators, parent components, long strings, whitespace and Unicode without embedding runnable misuse examples in documentation. Test input classes inside isolated fixtures only. Assert every destination is an immediate child of the fixture issues directory, safe filenames are deterministic and distinct, the outside-fixture-parent sentinel remains unchanged, and original fingerprint values remain intact.

**Verify:** `bun test tests/issues-paths.test.ts` → all safe compatibility and boundary cases pass; invalid source/type creates no draft.

### Step 3: Verify interoperability and scope

Add cases proving both `sentry` and `bugsink` persist/list successfully with encoded IDs, source distinguishes equal fingerprints, and direct safe IDs cannot collide with the encoded namespace. Repeat ingestion and assert no duplicate file for the same source/fingerprint. Re-run the baseline suite.

**Verify:** `bun run test && git diff --check` → exit 0. `git status --short` → only scoped changes plus pre-existing plan/baseline work.

## Test plan

Follow `tests/baseline.test.ts` and its helper's child-process isolation. Add at least eight table-driven cases spanning ordinary IDs, separator/parent-component classes, Unicode/long IDs, deterministic retries, source separation, invalid source/type rejection and namespace separation. Do not send these cases to a live gateway or write outside the test sandbox.

## Done criteria

- [ ] `bun test tests/issues-paths.test.ts` and `bun run test` exit 0.
- [ ] Tests assert contained paths, unchanged logical fingerprints, safe-name compatibility and deterministic retries.
- [ ] Invalid source/type fails before persistence.
- [ ] `git diff --check` exits 0; only scoped files changed.
- [ ] The index row is updated and no existing draft was migrated/deleted.

## STOP conditions

Stop on unexplained drift, failing isolation, missing baseline helper, evidence that external consumers require unsafe legacy filenames, a proposed fingerprint/schema change, required out-of-scope changes, or a verification gate failing twice. Existing symlinks or concurrent hostile filesystem mutation need a separately scoped threat model; do not claim this patch solves them.

## Maintenance notes

Keep logical identity separate from storage encoding. Future event sources must be explicitly allowed and remain filename-safe. Review the disjoint encoded-name namespace before changing allowlists. Existing malformed legacy files remain untouched; any migration needs separate approval and backups.
