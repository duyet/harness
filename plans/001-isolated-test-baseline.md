# Plan 001: Establish an isolated Bun test baseline

> **Executor instructions:** This is a handoff, not authorization to implement during the read-only advisory run. After separate implementation authorization, follow each step and verify its result. Update this plan's row in `plans/README.md`; never commit, push, contact remotes, create issues, or install dependencies without authorization.
>
> **Drift check (first):** `git diff --stat b17bb04..HEAD -- package.json README.md tests`
> Compare any changed source/context against the excerpts below. STOP on unexplained drift. Newly added files named below must not overwrite existing work.

## Status

- **Priority:** P1
- **Effort:** M (about one day including test isolation)
- **Risk:** LOW — no production behavior changes
- **Depends on:** none
- **Category:** tests / dx
- **Confidence:** HIGH
- **Planned at:** commit `b17bb04`, 2026-09-16

## Why this matters

There are no automated tests, test scripts, CI workflows, lint configuration, or typecheck configuration in the tracked repository. The recent gateway and issue-ingestion changes have only manual MVP evidence. A small, hermetic test baseline gives subsequent fixes a regression gate without touching a real home directory, Herdr installation, or external service.

## Current state

- `package.json:10–16` defines only runtime scripts and a Bun engine:
  ```json
  "scripts": {
    "start": "bun src/cli.ts start",
    "status": "bun src/cli.ts status"
  },
  "engines": { "bun": ">=1.1.0" }
  ```
- `src/shared.ts:7–9` computes state paths when imported:
  ```ts
  export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  export const STATE_DIR = join(homedir(), ".local", "state", "herdr-harness");
  export const STATE_FILE = join(STATE_DIR, "state.json");
  ```
  Changing HOME after importing application modules is therefore not reliable isolation. Use child processes with their environment set before application imports.
- `src/cli.ts:187–194` supplies an existing failure convention:
  ```ts
  if (!state.sessionId) {
    console.error("nothing to resume: no session id in state");
    console.error(`state file: ${STATE_FILE}`);
    console.error("run: harness start");
    process.exit(1);
  }
  ```
- `src/shared.ts:119–142` resolves task IDs and returns errors as data. `src/issues.ts:24–67` provides pure fingerprint/normalization functions.
- `README.md:84`: “Pick order: mock issue drafts, then config tasks in list order (rotates after last pick), then freeform ingress.” Preserve this; do not invent completion semantics.
- `README.md:88`: local stub; no live Matrix/Telegram APIs. `README.md:151–153` excludes full child-agent spawn, GitHub issue creation and cron.
- `.gitignore:1–3` ignores `node_modules/`, `dist/`, and logs. Use an owned temporary directory beneath `dist/.test-tmp/` for all test state and fixtures.

Conventions: dependency-free TypeScript, `.ts` import extensions, double quotes, semicolons, two-space indentation, named helpers and Node built-ins. No existing test exists to copy; use Bun's built-in `describe`, `test`, and `expect` with explicit assertions, not snapshots.

## Commands you will need

Run from repository root.

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `bun --version` | Supported Bun; recon had 1.4.2 |
| Existing safe CLI entry | `bun src/cli.ts --help` | exit 0 and usage; no state write |
| Shell syntax | `bash -n bin/harness` | exit 0 |
| Baseline suite (new) | `bun test tests/baseline.test.ts` | exit 0, at least 10 passing cases |
| Full suite (new) | `bun run test` | executes `bun test`, all pass |
| Diff gate | `git diff --check` | exit 0 |

No install/build step is needed for this source-run CLI. There is no existing lint or typecheck command. Do not describe `bun test` or bundling as typechecking. Test commands above are proposed gates, not tests already passed in the audit.

## Scope

**Only modify:** `package.json` (add test script only), `README.md` (verification section only), `tests/helpers.ts` (new), `tests/baseline.test.ts` (new), and this plan's status row in `plans/README.md`.

**Runtime test artifacts:** exclusively owned directories beneath `dist/.test-tmp/`; clean only the directories each test created.

**Out of scope:** all production TypeScript, shell launcher, schema, plugin manifest, MVP evidence, release/version changes, dependencies, CI, agent config, other repositories, live gateways, real home/state directories, actual Herdr processes, integrations, cron, remotes and tokens.

## Git workflow

Remain uncommitted unless explicitly authorized otherwise. No branch/worktree creation, commit, push, PR, or remote access is needed for this handoff. Existing history uses concise imperative subjects such as “Ship local chat UI stub and persistent install docs v0.0.6”; no history changes are part of the plan.

## Steps

### Step 1: Create isolated subprocess helpers

Create `tests/helpers.ts` exporting a fixture factory with `home`, `cwd`, `env`, a `runCli(args)` method, and `cleanup()` method. Each factory call creates a unique directory below `dist/.test-tmp/` containing separate `home`, `repo`, and temporary-file directories. Build a minimal environment explicitly rather than forwarding `process.env`: HOME, PATH needed for Bun/git, TMPDIR inside the fixture, and `HERDR_BIN_PATH`/`HERDR_SOCKET` pointing to nonexistent fixture paths. Launch the CLI with `process.execPath` and the absolute `src/cli.ts` path; capture stdout, stderr and exit status with a finite timeout. Supply EOF as stdin unless a test explicitly supplies input.

Use isolated subprocesses for application imports that depend on HOME or cwd. Add a smoke assertion in `tests/baseline.test.ts` that a child importing `STATE_DIR` reports a path under its fixture home, and that `--help` exits 0. Fail before invoking mutating commands if the isolation assertion fails. Clean in `finally`/`afterEach` and never recursively delete a path not returned by the factory.

**Verify:** `bun test tests/baseline.test.ts` → both smoke assertions pass; no real user state is accessed.

### Step 2: Add public-contract characterization cases

Add independent cases for: fresh status is idle; resume without state exits 1; start persists a session; start --resume preserves it; ordinary second start changes it; manager route resolves a fixture task; unknown task exits 1 with `ok:false`; issue normalization produces the expected source/labels without writing; repeated ordinary event IDs have stable fingerprints; named-task picks rotate using two fixture tasks. Do not lock in known bad behaviors such as HTTP 500 for bad input, direct event IDs as file paths, or successful exit after a failed executed command.

Use a small `.herdr-harness.json` fixture with `name`, two task IDs, an adapter default and routes. Assert parsed JSON fields, not timestamps or UUID literals. State-mutating CLI commands run only through the isolated helper.

**Verify:** `bun test tests/baseline.test.ts` → at least 10 total cases pass; repeat once with the same result and no test order dependency.

### Step 3: Expose and document the gate

Add `"test": "bun test"` without changing package metadata or existing scripts. Add a README verification section describing Bun, `bun run test`, isolated fixtures, no required Herdr server, and the absence of lint/typecheck gates. Do not rewrite historical MVP evidence as automated coverage.

**Verify:** `bun run test` → all pass; `bash -n bin/harness` and `git diff --check` → exit 0. `git status --short` → only allowed files (plus pre-existing plans) appear.

## Test plan

`tests/baseline.test.ts` is the first test exemplar. Use deterministic field assertions and per-test subprocess fixtures. At least 10 cases cover session persistence, routing, issue normalization and task rotation. No network server, mock shell execution, or real Herdr invocation is required. Later plans can reuse `tests/helpers.ts` without requiring this conversation.

## Done criteria

- [ ] `bun run test` exits 0 twice and reports at least 10 passing cases.
- [ ] The fixture isolation assertion passes before state-mutating cases run.
- [ ] `bash -n bin/harness` and `git diff --check` exit 0.
- [ ] No application source or package version changed.
- [ ] README accurately distinguishes tests from absent lint/typecheck gates.
- [ ] `git status --short` matches scope and the plan index row is updated.

## STOP conditions

Stop if application state resolves outside the owned fixture, Bun cannot run the built-in test runner, dependencies seem necessary, tests invoke real Herdr/network services, existing tests conflict with these new filenames, excerpts have unexplained drift, scope must expand, or a gate fails twice after a reasonable correction. Do not run upgrade or a background gateway against the operator's environment.

## Maintenance notes

Keep the isolation assertion when changing state path discovery. New tests that import shared constants should run in an already-isolated child rather than mutate HOME in the runner. Preserve meaningful exit-status and JSON assertions. CI and static typechecking are intentionally deferred, not silently claimed as covered.
