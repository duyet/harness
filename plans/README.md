# Harness improvement plans

Five advisory runs. Plans 001-006 are from commit `b17bb04` (2026-09-16 / Asia/Saigon 2026-09-17) via **anyr claude --model stealth/union-alpha** + `/improve` (non-interactive default: top 5 by leverage). Plans 007-011 are a focused re-review at commit `b96a1ec` (2026-10-02), targeting the manager/gateway/issues/chat surface and the features added after 006. Plans 012-016 are a fresh post-011 review at commit `cbc0592` (2026-10-02), run against the surfaces that changed in 007-011 (chat execute gating, idempotent ingest, `gh` timeouts, ingress bounds, manager spawn visibility). Plans 017-021 are Run 4 at commit `5fd3cf0` (2026-10-02 / Asia/Saigon), a post-016 advisory `/improve` + focused review via **Herdr + anyr claude --model stealth/space-bunny-alpha** (advisor-only; 148 green tests). Plans 023-027 are Run 5 at commit `cba1548` (2026-10-02), a fresh post-022 review of the manager/gateway/issues/chat/CLI/shared surfaces plus the residuals of shipped plans 010-022 (advisor-only; 169 green tests, typecheck green). Selection promoted residuals that still reproduce over inventing new surface.

**Hard rules for executors:** these plans are not authorization to implement. Execute only when separately requested. Source was not modified by the advisory run. Leave release-please alone. Do not touch herdr-desk.

## Leverage table (vetted findings → plans)

### Run 1 — commit `b17bb04`, 2026-09-16

| # | Finding | Category | Impact | Effort | Risk | Confidence | Plan |
|---|---------|----------|--------|--------|------|------------|------|
| 1 | No automated test baseline; subsequent fixes lack a hermetic regression gate | tests / dx | High | M | LOW | HIGH | [001](001-isolated-test-baseline.md) |
| 2 | Issue-draft paths incorporate unvalidated event IDs (path separators / `..`) | security | High | S | MED | HIGH | [002](002-contain-issue-draft-paths.md) |
| 3 | Background gateway `chdir`s to plugin checkout; loses caller repo config context | bug | High | S | LOW | HIGH | [003](003-preserve-gateway-repo-context.md) |
| 4 | Gateway POST routes: malformed JSON → HTTP 500; non-object JSON poorly handled | bug / tests | Med-High | S | LOW | HIGH | [004](004-validate-gateway-json.md) |
| 5 | `manager spawn --execute` prints `ok:false` but exits 0 on child failure | bug / dx | Med | S | LOW | HIGH | [005](005-propagate-manager-exit-status.md) |

Non-interactive selection: all five above (top leverage cluster). No additional plans written.

### Run 2 — commit `b96a1ec`, 2026-10-02

| # | Finding | Category | Impact | Effort | Risk | Confidence | Plan |
|---|---------|----------|--------|--------|------|------------|------|
| 7 | Replayed error events file a second GitHub issue and rewind `github-created` → `mock-draft` | bug / data integrity | High | S | MED | HIGH | [007](007-idempotent-issue-ingest.md) |
| 8 | `/chat execute` is unauthenticated, spawns a config-named binary, and is cross-origin reachable | security | High | M | MED | HIGH | [008](008-gate-chat-execute.md) |
| 9 | `gh issue create` runs via `spawnSync` with no timeout: `issues ingest --execute` can hang forever | bug / dx | Med-High | S | LOW | HIGH | [009](009-bound-gh-timeout.md) |
| 10 | Ingress stores raw bodies unbounded; `/status` echoes them back (20 MB queue from 60 POSTs) | security / dx | Med | S | LOW | HIGH | [010](010-bound-ingress-state.md) |
| 11 | `manager status` omits spawns; mid-sequence spawn failures give no recovery hint | dx | Med | S | LOW | HIGH | [011](011-manager-spawn-visibility.md) |

All five findings were reproduced against `b96a1ec` with isolated `HOME`/`PATH` fixtures before being written up; transcripts are in each plan's "Evidence" section.

### Run 3 — commit `cbc0592`, 2026-10-02

Fresh post-011 review (`/improve`, standard effort, 4 parallel audit agents + direct manual verification). Scoped to the manager/gateway/issues/chat/CLI surfaces. **104 green tests** at the tip. Selection was non-interactive: top 5 by leverage, all reproduced locally first.

| # | Finding | Category | Impact | Effort | Risk | Confidence | Plan |
|---|---------|----------|--------|--------|------|------------|------|
| 12 | `gateway stop` SIGKILLs whatever PID is in `gateway.pid` — a recycled PID destroys an unrelated process; `gateway start` is then wedged `alreadyRunning` | bug / safety | High | S | LOW | HIGH | [012](012-verify-gateway-pid-identity.md) |
| 13 | `herdr` `spawnSync` has no timeout, and `herdrUsable()` runs *before* the dry-run gate — even `manager spawn` without `--execute` hangs forever on a wedged Herdr | bug / dx | High | S | LOW | HIGH | [013](013-bound-herdr-subprocesses.md) |
| 14 | Plan 010 capped `body` and `text` but left `sender`, `channel` and `taskId` unbounded — one unauthenticated POST wrote 41 MB and `/status` echoed it all back | security | High | S | LOW | HIGH | [014](014-cap-unbounded-ingress-fields.md) |
| 15 | `/ingress/sentry`+`bugsink` bypass plan 010 entirely: unbounded draft files (5 POSTs → 21 MB), `gh` fails `E2BIG` with a misleading "gh not usable", failure envelope re-prints the whole body | security | High | M | MED | HIGH | [015](015-bound-issue-draft-directory.md) |
| 16 | `pick` writes `lastPicked` but reads it only for tasks — the issue and freeform tiers return the same item forever, starving out every config task | bug | High | M | MED | HIGH | [016](016-rotate-pick-across-tiers.md) |

**Run 3 theme:** 14, 15 and 012 are all *residual* gaps in shipped plans (010's bounds, and 007/008's assumptions), not new surface. 12, 13 and 16 are the first findings in the manager/PID and pick paths, both of which had no prior coverage.

Every Run 3 finding was reproduced before being written up, with isolated `HOME`/`PATH` fixtures and a fake gateway or Herdr binary — transcripts are in each plan's "Evidence" section.


### Run 4 — commit `5fd3cf0`, 2026-10-02

Fresh post-016 review (Herdr pane `harness-improve-run4` + `/improve` orientation; findings vetted with isolated `HOME`/`PATH` fixtures against tip). **148 green tests**. Scoped to residuals of 010/006/009 and the deferred list from Run 3. Selection was non-interactive: top 5 by leverage.

| # | Finding | Category | Impact | Effort | Risk | Confidence | Plan |
|---|---------|----------|--------|--------|------|------------|------|
| 17 | Plan 010 projected `lastEvent` but left `lastDelivery()` raw on unauthenticated `GET /status` — absolute paths embed the OS username + 600-char report excerpt | security | High | S | LOW | HIGH | [017](017-project-status-last-delivery.md) |
| 18 | `executeCleanup` shares one `results.every(status===0)` across discovery and mutation — a failed `tab close` for an already-closed tab skips `deleteSpawn` and wedges `--replace` | bug / dx | High | S | LOW–MED | HIGH | [018](018-idempotent-execute-cleanup.md) |
| 19 | `writeJsonAtomic` exists but only ingress uses it; `saveState` / `saveSpawns` / `writeIssueDraft` / `writeSummaryDelivery` use bare `writeFileSync` while readers silent-fallback to empty | bug / data integrity | High | S | LOW | HIGH | [019](019-atomic-state-file-writes.md) |
| 20 | `harness issues ingest` without `--file`/pipe awaits `Bun.stdin.text()` forever on a TTY — same hang class as plan 009, one step upstream | bug / dx | Med-High | S | LOW | HIGH | [020](020-bound-issues-ingest-stdin.md) |
| 21 | No `typecheck` script and no CI workflow after 001 proved value (now 148 tests / ~20 plan-driven refactors) | tests / dx | Med | S | LOW | HIGH | [021](021-typecheck-and-minimal-ci.md) |

**Run 4 theme:** 17 and 19 are residuals of shipped plan 010's incomplete projection/atomic story; 18 is the cleanup idempotency deferred from Run 3; 20 mirrors plan 009's hang class; 21 is the scaffolding item Runs 1–3 explicitly parked for Run 4.

017–018 were reproduced with fixtures before write-up (transcripts in each plan's Evidence). 019–021 are HIGH-confidence from tip code inventory + prior deferred notes; 020's hang is the same `stdin.text()` pattern plan 009 already treated as proven.

### Run 5 — commit `cba1548`, 2026-10-02

Fresh post-022 review (`/improve`, standard effort, 2 parallel audit agents + direct manual verification). Scoped to the manager/gateway/issues/chat/CLI/shared surfaces and the residuals of shipped plans 010-022. **169 green tests**, typecheck 0. Selection was non-interactive: top 5 by leverage.

| # | Finding | Category | Impact | Effort | Risk | Confidence | Plan |
|---|---------|----------|--------|--------|------|------------|------|
| 26 | `publishIssueDraft` persists `status: "github-created"` **without** a URL when `gh`'s output isn't a `github.com` URL (GHES, or >500 chars before the URL) — both once-only guards then miss, so a replay files a **duplicate GitHub issue**, and a plain re-ingest erases the published record | bug / data integrity | High | S | LOW–MED | HIGH | [026](026-never-record-github-created-without-url.md) |
| 23 | Two independent holes break plan 015's "a draft inside the cap is always publishable" invariant: (A) `fingerprintFor` returns a caller-controlled `event_id`/`id` uncapped into the body header; (B) the cap is measured on the **compact** serialization but the body embeds the **pretty** one, so a 52 KB event yields a 170 KB body with *no* truncation flag | security / data integrity | High | S | LOW | HIGH | [023](023-keep-issue-draft-body-publishable.md) |
| 25 | Hostile input answers with a 500 instead of the documented JSON envelope: a 160 KB deeply-nested POST on all four ingress routes (`RangeError` in `capBody`/`buildDraft`), and wrong-shaped state files crashing `/chat`, `pick` and `issues list` | bug / robustness | High | S | LOW | HIGH | [025](025-answer-hostile-input-with-json-envelope.md) |
| 24 | Ingress POST responses return the **uncapped** `task.text` — plan 014 caps what is persisted (203 bytes) but nothing bounds what is returned (200,000); `/chat` doubles it | dx / defense-in-depth | Med | S | LOW–MED | HIGH | [024](024-project-ingress-post-responses.md) |
| 27 | `/chat` summary pickup returns stored operator state on a non-loopback bind — including on the very request the execute gate refuses with "must not be exposed to an untrusted network" | security / consistency | Med | S | LOW–MED | HIGH | [027](027-gate-chat-pickup-on-bind.md) |

**Run 5 theme:** every one of the five is a *residual of a shipped plan*, not new surface — 026 of 007's once-only guard, 023 of 015's payload cap, 025 of 004's JSON-error contract and 019's reader contract, 024 of 015's projection fix (applied to 2 of 4 routes), 027 of 008's bind gate. This is the third consecutive run whose top findings are residuals, which is the signal that the bounds are sound in outline and leaky at the edges: each plan closes the case its own fixture happened to cover.

The two HIGH data-integrity findings share a shape worth naming — **a shipped invariant that its own test could not reach**. 015's test asserts `bodyBytes < 128 KiB` but oversizes with a field that *is* capped; 007's guards require a URL but the writer can produce the state without one. In both, the plan verified a property over the input space its fixture wrote rather than over the input space the endpoint accepts.

Every finding was reproduced against `cba1548` before write-up, with isolated `HOME` fixtures, a scratch repo holding `.herdr-harness.json`, a fake `gh` on a restricted `PATH`, and a real gateway on a high port; transcripts are in each plan's "Evidence".

**Two findings were re-scoped during the run, both by parallel audit agents, and both corrections stand.** 024 was drafted as a security finding; an agent correctly established that the response is a reflection of the caller's *own* bytes at ~1-2x with no third-party data, so it is filed as **dx / defense-in-depth** and says so in its own first paragraph rather than in a footnote. The same agent supplied 025's `RangeError` half, which was independently reproduced before being written up; the second agent supplied finding 026 and 023's Vector B, both independently reproduced end to end. A candidate finding that gated ingress on loopback was **dropped** after an agent showed it re-litigates a decision the README states explicitly (`README.md:163`); the narrow, defensible version of it — pickup alone, because pickup returns stored state rather than an echo — became 027.

## Recommended execution order (Run 5 — `cba1548`)

```
026 (never publish without a URL)  — data integrity; reintroduces the exact harm 007 closed; do first
023 (keep the draft body publishable) — security/data integrity; two E2BIG vectors; pairs with 026's tests
025 (JSON envelope, not a 500)      — robustness; independent; touches parseJsonObject + 3 readers
024 (project ingress POST bodies)   — independent; reuses the projection pattern 015 wrote
027 (gate chat pickup on bind)      — independent; one line reusing 008's existing check
```

**026 first.** It is the only finding whose failure mode silently files a **duplicate issue on GitHub** and destroys the record that would have prevented it — user-visible, external, and not recoverable by re-running. It is also a contained fix in one function.

**023 next.** Both vectors are unauthenticated and end in an unpublishable draft; Vector B is the sharper one because the draft carries no truncation flag at all. Doing 023 and 026 together is efficient — both are `src/issues.ts` publish-path tests.

**025 is independent** and can run whenever; it is the one that most improves the surface's honesty (documented 400s vs actual 500s).

**024 and 027 are last** and can be dropped without leaving anything dangerous behind.

## Recommended execution order (Run 4 — `5fd3cf0`)

```
017 (project /status lastDelivery)  — security residual of 010; gateway.ts only; do first
018 (idempotent cleanup)            — independent; unblocks manager replace loops
019 (atomic state writes)           — independent; pairs with 010's writeJsonAtomic
020 (ingest stdin guard)            — independent; mirrors 009
021 (typecheck + CI)                — independent; no src behaviour change
```

**017 first** — unauthenticated HTTP leak, S effort, residual of the plan that already taught the projection pattern.

**018 next** — the only finding that permanently wedges operator recovery (`spawns.json` + `--replace`).

**019 and 020** may follow in any order; 019 is the higher integrity leverage.

**021 last** (or whenever) — additive only; do not let a red typecheck force `src/` edits in the same PR (see its STOP conditions).

> **021 executed** at `9c6121c`+ and hit its STOP exactly as written. `tsconfig.json` and the `typecheck` script landed in `1f4df11`; `.github/workflows/test.yml` landed separately in `fe4f640` (the first push was rejected — the OAuth token lacked the `workflow` scope — and was re-pushed with a scoped token). `src/` was not touched to force green. The typecheck job shipped `continue-on-error: true` against a 23-error baseline (3 in `src/gateway.ts`). That baseline was cleared by **[022](022-clear-typecheck-baseline.md)**, which also dropped `continue-on-error`; 021 is closed.

## Recommended execution order

```
001 (test baseline)
 ├── 002 (path containment)     — needs test harness from 001
 ├── 003 (gateway cwd/context)  — needs test harness from 001
 ├── 004 (gateway JSON 400s)    — needs test harness from 001
 └── 005 (manager exit status)  — needs test harness from 001
```

Run **001 first**. 002–005 are independent of each other after 001 and may be parallelized.


## Recommended execution order (Run 2 — `b96a1ec`)

```
007 (idempotent ingest)     — independent; highest data-integrity leverage
008 (gate chat execute)     — security; independent of 007
009 (gh timeout)            — independent; pairs naturally with 007
010 (bound ingress state)   — independent; pairs with 004 patterns
011 (manager status/hints)  — independent; builds on 006 UX
```

Prefer **007** and **008** first (integrity + security). 009–011 may follow in any order.

## Recommended execution order (Run 3 — `cbc0592`)

```
012 (verify gateway PID)     — safety; independent, do first
013 (bound herdr calls)      — independent; mirrors 009 exactly
014 (cap ingress fields)     — security residual of 010; gateway.ts only
015 (bound issue drafts)     — security residual of 010; issues.ts; pairs with 014
016 (rotate pick tiers)      — product; independent of all of the above
```

**012 first** — it is the only finding whose failure mode destroys unrelated user work, and it also adds the first test coverage the gateway lifecycle has ever had (`gateway start|stop|status` currently have zero tests).

**013 next** — it is the same shape as the shipped plan 009, so the executor has a working in-repo template, and it fixes a hang on the *default* (dry-run) path.

**014 and 015 together** — one threat (unauthenticated POST → unbounded disk) split across two modules, two risk profiles, two test files. Doing either alone leaves the larger hole open; 014 is the cheaper and lower-risk of the pair.

**016 is independent** and can run whenever. It is the highest product-impact fix but also the riskiest (it touches a documented output contract), so it is a reasonable place to stop after 012–015.

## Status

| Plan | Title | Status | Depends on |
|------|-------|--------|------------|
| 001 | Establish an isolated Bun test baseline | DONE | none |
| 002 | Keep issue-draft writes inside the issues directory | DONE | 001 |
| 003 | Preserve the caller's repository context in the background gateway | DONE | 001 |
| 004 | Return predictable JSON errors for invalid gateway requests | DONE | 001 |
| 005 | Make executed manager failures return a nonzero CLI status | DONE | 001 |
| 006 | Wire manager spawn child tab/agent and cleanup UX | DONE | 001, 005 |
| 007 | Make issue ingest idempotent and publish deduplicated | DONE | 001, 002 |
| 008 | Gate `/chat execute` behind bind/origin/kind checks | DONE | 001, 004 |
| 009 | Bound `gh issue create` with timeout and closed stdin | DONE | 001 |
| 010 | Bound gateway ingress state growth; stop raw `/status` echo | DONE | 001, 004 |
| 011 | Surface live spawns in `manager status` + recovery hints | DONE | 001, 006 |
| 012 | Verify the gateway PID still belongs to a harness gateway | DONE | none |
| 013 | Bound every Herdr subprocess with a timeout; stop shelling out on dry-run | DONE | none |
| 014 | Cap the ingress event fields that plan 010 left unbounded | DONE | 010 |
| 015 | Bound the Sentry/Bugsink draft path — payload size and directory growth | DONE | 002, 007 |
| 016 | Rotate `harness pick` across the issue and freeform tiers | DONE | none |
| 017 | Project `lastDelivery` on unauthenticated `GET /status` | DONE | 010 |
| 018 | Make `executeCleanup` idempotent (failed tab-close must not wedge spawns) | DONE | 006, 013 |
| 019 | Write all harness state files atomically (temp + rename) | DONE | none |
| 020 | Refuse interactive stdin for `harness issues ingest` | DONE | none |
| 021 | Add a `typecheck` script and a one-file CI workflow | DONE — landed partial at `1f4df11` (script + tsconfig) and `fe4f640` (CI workflow), completed by 022: typecheck is 0 and the job is a blocking gate | 001 |
| 022 | Clear the 23-error typecheck baseline, then enforce the gate | DONE — 23 → 0 with no knob weakened; `continue-on-error` removed from the CI typecheck job. One follow-up filed (see below) | 021 |
| 023 | Keep every issue draft inside the OS single-argument limit | DONE — the fingerprint is capped with `capHeader` where it enters the *body* (identity still derives from the whole id, so `storageKeyFor` and 007's replay guard are untouched), and the cap is now measured against the serialization actually embedded, with `bodyTruncated`/`bodyBytes` derived from the cut rather than from the guess that chose the form. Vector A: a 200 KB `event_id` went 303 KB → 98.9 KB; Vector B: a 52 KB wide payload went 170 KB *silently* → 98.4 KB with the cut visible. Asserted as a property over a table of shapes, so the next header field cannot reopen it | 015 |
| 024 | Project the unauthenticated ingress POST responses | OPEN | 014, 015 |
| 025 | Answer hostile input with the JSON envelope, not a 500 | OPEN | 004, 019 |
| 026 | Never record `github-created` without a URL | DONE — exit 0 with no parseable URL is now `ok: false` and persists nothing (the timeout branch's conservative shape), the recogniser is host-flexible and reads the untruncated stdout, and `writeIssueDraft` refuses a URL-less `github-created`. Both named triggers (GHES host, >500-char preamble) now take the ordinary successful path, so neither duplicates on replay nor is erased by a re-ingest | 007 |
| 027 | Hold `/chat` summary pickup to the same bind check as execute | OPEN | 008, 017 |

Status values: OPEN | IN PROGRESS | DONE | BLOCKED (with one-line reason) | REJECTED (with one-line rationale).

## Considered and rejected / deferred

### Carried forward from earlier runs

- Large product scope (Matrix real tokens, new crons, GitHub create, release-please changes): explicitly out of scope for this burn-test.
- Expanding gateway into multi-tenant / auth: direction-only; not planned. **Re-confirmed in Runs 3–4:** plan 008 landed the execute gate; Run 4 did not re-raise general auth. Origin on *ingress* remains the same deferred decision.
- Full lint/eslint beyond typecheck: still deferred. **Run 4 note:** plan 021 covers the typecheck + one-file CI slice that Runs 1–3 parked; broader lint stays out. **Post-022:** `tsc` exits 0 and CI gates on it; broader lint still deferred (no lint stack).
- Splitting `src/cli.ts` (~1460 lines vs a ~238-line repo median): rejected for now. Still no god-object symptoms — the cost remains untested surface, not size. **Run 4:** line count grew with 012–016; still not planned.

### Run 3 items promoted in Run 4

- `/status` leaks `lastDelivery` raw → **[017](017-project-status-last-delivery.md)**
- `executeCleanup` is not idempotent → **[018](018-idempotent-execute-cleanup.md)**
- State files written non-atomically → **[019](019-atomic-state-file-writes.md)**
- `harness issues ingest` stdin hang → **[020](020-bound-issues-ingest-stdin.md)**
- typecheck + CI scaffolding → **[021](021-typecheck-and-minimal-ci.md)** (landed partial — see below)

### Filed by 021's STOP condition

- Typecheck baseline: 23 errors, 3 in `src/gateway.ts`; weakening `strict` makes it worse, not better → **[022](022-clear-typecheck-baseline.md)** — shipped; baseline is 0 and the job gates.

### Filed by 022

- **`resolveTask` returns a merged type, not a discriminated pair** — `src/shared.ts:245` returns two object literals (a bare error, and the task + `adapterId` + `route` together) that inference collapses into one type whose `task` / `adapterId` / `route` come out *independently optional*. Every caller that has already checked `error` still reads its adapter id as possibly undefined; 022 absorbed that in `src/gateway.ts` with `?? defaultAdapter` / `?? null`, which is correct but treats the symptom. Annotating the return as `{error: string, ...} | {error: null, task, adapterId, route, ...}` is the real fix and was measured: it cascades to 11 sites in `src/cli.ts` (lines ~369, 393, 574, 738, 776, 848, 862), all of them `?.` / `??` / `!` guards that a discriminant would make unnecessary. S effort, type-only, no runtime change. Deferred out of 022 for scope, not difficulty. **Run 5 re-check:** still open and unchanged — the merged return type is still at `src/shared.ts:245`, and the defensive fallbacks are visible at `src/cli.ts:369`, `src/cli.ts:380`, `src/cli.ts:738` and `src/gateway.ts:314-315`. Still the lowest-leverage item on the books; kept visible rather than promoted.

### Run 3/4 vetted, still deferred (ranked below the five)

- **`spawn --replace` with no record closes unscoped tabs** — `src/cli.ts` gates the "already spawned" refusal on `record && !replace`, so `--replace` with no record falls through to cleanup, which matches tabs by label across *all* repositories (`herdr tab list` is not cwd-scoped). MED confidence — severity depends on label collision. Pair with 018 if an executor finishes early. **Run 5:** still reproduces; the label match is `t?.tab_id === record?.tabId || t?.label === label`, so it is not limited to the no-record case.
- **Chat adapter timeouts kill only the direct child** — `src/chat.ts` SIGKILLs `child` without `detached`/process-group kill, so grandchildren from real agent CLIs can survive. MED confidence. **Run 5:** re-confirmed; the adapter binary is config-chosen and trusted, so an audit agent scored it LOW/informational rather than a hole.
- **`harness summary | jq` emits markdown** — `cmdStatus`/`cmdPick` use `--json || !process.stdout.isTTY`; `cmdSummary` (`src/cli.ts:1439`) checks only `--json`. S effort, dx-only. **Run 5: still reproduces** (verified: piping `harness summary` yields `# harness daily summary`). Ranked below every Run 5 plan.
- **`waitHealth` treats any 2xx from the port as success** with no body identity check — partly subsumed by plan 012's PID identity; a squatter on 8787 can still make `gateway start` report `listening: true` briefly. Leave until 012's tests want a follow-up.
- **README/schema drift** — `README.md` still runs `harness upgrade` before extending `PATH`; `herdr-harness.schema.json` omits `adapters.chat.executeKinds` under `additionalProperties: false`; `HERDR_BIN_PATH`/`HERDR_SOCKET` undocumented. All S-effort docs; fold into a docs-only follow-up. **Partly done in 021:** the Verification section now names the current 22 test files / 169 tests and documents the typecheck baseline. **Run 5 sharpened this:** `adapters` is `additionalProperties: false` with only `default`/`routes`, so the `adapters.chat.executeKinds` shape that plan 008's gate reads is **rejected by the shipped schema outright** — not merely undocumented. Confirmed by reading `herdr-harness.schema.json`.

### Filed by Run 5, vetted and deferred (did not make the top five)

- **`looksLikeGateway` matches any command line merely *mentioning* `gateway.ts`** — the first branch is `command.includes("gateway.ts")`, a raw substring test, while the second branch of the same function is token-aware (`(^|\s)word(\s|$)`). Verified against the real function: `vim src/gateway.ts`, `grep -rn gateway.ts src/`, `less README.md gateway.ts` and `claude -p "fix gateway.ts"` all pass; `bun …/src/gateway.ts` must keep passing. **Why deferred rather than planned:** it was drafted as plan 026, then displaced by the higher-leverage `github-created`-without-URL finding. The reachability precondition is also narrow — `gateway.json` outlives a stop and is compared first, so a recycled pid is normally caught one step earlier; the gap needs that metadata absent or unparseable. Cheap S-effort hardening of plan 012's own gate, worth doing if an executor finishes early.
- **`fingerprintFor`'s 200-char prefix cut collapses distinct events onto one fingerprint** — `src/issues.ts:38` cuts `JSON.stringify(raw).slice(0, 200)` when an event has no `event_id`/`eventId`/`id` *and* no `message`/`title`. Two events agreeing through character 200 hash identically, share one `sentry-<key>.json` path, and the second silently overwrites the first — and if the first was published, plan 007's guard then records the second as *already published*, so a genuine alert is never filed at all. The comment at `src/issues.ts:76-80` asserts this is prevented ("two large events that share a prefix must not collapse onto one fingerprint"); the protection is in the wrong layer, since `fingerprintFor` itself cuts. Also cuts UTF-16 code units, so a surrogate pair can be split. MED confidence — needs an id-less, message-less, title-less shape. Distinct from plan 023, which caps the fingerprint rather than hashing it.
- **`writeFileAtomic` is atomic for readers but not durable, and resets the target's mode** — `src/shared.ts:130-146` writes a temp file and renames, with no `fsync`, so a *machine* crash (as opposed to a process crash) can leave a correctly-named empty file, which every reader treats as "no state" — the exact failure the function exists to prevent. It also creates the temp at `0o666 & ~umask` (typically 0644) and renames over the target unconditionally, silently discarding any tightened mode; `STATE_DIR` is `0755`, so `spawns.json` (worktree paths, tab/pane/workspace ids) and draft bodies are world-readable by default. A SIGKILL between the two syscalls leaves a `.pid.tmp` behind (harmless — `trimIssueDrafts` filters on `.json`). LOW: real but modest for a single-user `~/.local/state`.
- **The issue-draft directory bound is soft by construction** — `trimIssueDrafts` `continue`s past `github-created` entries and unparseable files forever, so a directory that fills with published drafts grows without limit. This is deliberate (`src/issues.ts:173-178` — a `github-created` draft is what stops a replay filing a duplicate) and the per-POST bound still holds. Recorded so `ISSUES_DIR_MAX_DRAFTS`/`MAX_BYTES` are read as best-effort, not invariants.

### Direction options (grounded, not defects — for the maintainer to weigh)

- **The harness is not a closed loop.** `pick` names work but cannot start it (`resolveTask` resolves only config task ids, so `manager spawn "$(harness pick --json | .id)"` fails for the issue and freeform tiers by construction), and Matrix/Telegram ingress is write-only — events are resolved, acknowledged `202`, and dropped, because the freeform tier sits behind `else if (tasks.length)`. Every spawn today is a manual transcription of a `pick` output. **Run 4:** still true after plan 016's rotation. **Run 5:** still true; nothing in 023-027 moves it, and none of them pretends to.
- **Three declared config keys are inert.** `soul` is echoed into `manager status` only; `playbooks` is echoed into the summary and dispatched nowhere (dispatch hardcoded to `PLAYBOOK_SENTRY`); `enabled` is in the schema, absent from the type, and read by nothing. **Run 5:** re-confirmed by reading both `src/shared.ts` and the schema.
- **Retiring a picked draft needs a command.** Still the top direction item after plan 016: a `harness issues done|rm` subcommand plus a third `status` in the `IssueDraft` union. Must survive a replayed upstream event (plan 007). **Run 5 note:** this interacts with plan 026 — a `done` status must be handled by *both* once-only guards alongside `github-created`, or a retired draft becomes a re-fileable one.

## Not audited in depth

- Herdr host integration beyond CLI dry-run/status surfaces (a real `herdr` binary exists on the review machine; no live worktree/tab/agent operation was performed, and plan 013's test fixtures use a fake `herdr`)
- Chat UI static assets polish
- Cross-repo plugin packaging / release-please (intentionally untouched)
- `templates/soul.md` beyond reading it
