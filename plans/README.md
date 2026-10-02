# Harness improvement plans

Seven advisory runs. Plans 001-006 are from commit `b17bb04` (2026-09-16 / Asia/Saigon 2026-09-17) via **anyr claude --model stealth/union-alpha** + `/improve` (non-interactive default: top 5 by leverage). Plans 007-011 are a focused re-review at commit `b96a1ec` (2026-10-02), targeting the manager/gateway/issues/chat surface and the features added after 006. Plans 012-016 are a fresh post-011 review at commit `cbc0592` (2026-10-02), run against the surfaces that changed in 007-011 (chat execute gating, idempotent ingest, `gh` timeouts, ingress bounds, manager spawn visibility). Plans 017-021 are Run 4 at commit `5fd3cf0` (2026-10-02 / Asia/Saigon), a post-016 advisory `/improve` + focused review via **Herdr + anyr claude --model stealth/space-bunny-alpha** (advisor-only; 148 green tests). Plans 023-027 are Run 5 at commit `cba1548` (2026-10-02), a fresh post-022 review of the manager/gateway/issues/chat/CLI/shared surfaces plus the residuals of shipped plans 010-022 (advisor-only; 169 green tests, typecheck green). Plans 028-032 are Run 6 at commit `23f7471` (2026-10-02 / Asia/Saigon), a post-027 advisory `/improve` + focused review via **Herdr pane `harness-improve-run6` + anyr claude --model stealth/space-bunny-alpha** (advisor-only; 185 green tests, typecheck green). Plans 033-039 are Run 7 at commit `63937ed` (2026-10-02), a post-032 advisory `/improve` + focused review via **Herdr pane `chore-harness-improve-run7` + anyr claude --model stealth/space-bunny-alpha** (advisor-only; 202 green tests, typecheck 0). Selection promoted residuals that still reproduce over inventing new surface; Run 7 filed **seven** findings (non-interactive top-by-leverage; 039 landed mid-run after a chat-surface auditor showed the deferred grandchild-kill note is a request hang).

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


### Run 6 — commit `23f7471`, 2026-10-02

Fresh post-027 review (Herdr pane `harness-improve-run6` + `/improve` orientation via **anyr claude --yes --yolo --model stealth/space-bunny-alpha**; 2 parallel audit agents + direct manual verification). Scoped to the manager/gateway/issues/chat/CLI/shared surfaces, the residuals of shipped plans 010-027, and the deferred list from Runs 3–5. **185 green tests**, typecheck 0. Selection was non-interactive: top by leverage; **five findings**.

| # | Finding | Category | Impact | Effort | Risk | Confidence | Plan |
|---|---------|----------|--------|--------|------|------------|------|
| 28 | `spawns.json` is one **global** file keyed by bare `taskId`, and the cleanup tab match is a **global label** match — so `manager spawn <id> --replace` in repo B silently closes repo A's tab and removes repo A's worktree, reporting `ok: true` | bug / safety | High | S–M | LOW–MED | HIGH | [028](028-scope-spawn-records-to-a-repo.md) |
| 29 | The unauthenticated issue-draft 202 still returns the **absolute draft path**, embedding the OS username — plan 017 removed exactly these paths from `projectDelivery` and never applied the rule to `projectIssueDraft` | security | Med-High | S | LOW | HIGH | [029](029-project-issue-draft-path.md) |
| 30 | Plan 024's response contract was applied to **3 of 5** POST routes: the two issue routes echo an uncapped 200 KB `fingerprint`/`id` (a 200 KB POST returns 400 KB), and on *every* route only `text` is re-flagged, so `taskId`/`sender`/`channel` are cut **silently** | bug / defense-in-depth | Med | S | LOW | HIGH | [030](030-carry-the-response-contract-to-every-route.md) |
| 31 | Plan 025's reader hardening skipped `src/shared.ts` — all three readers there are still unguarded; an array-shaped `spawns.json` makes `saveSpawn` **silently lose the record it just wrote**, defeating the "already spawned" guard | bug / data integrity | Med | S | LOW | HIGH | [031](031-guard-the-shared-state-readers.md) |
| 32 | The **413 envelope `README.md:159` documents is never emitted** for ordinary oversize POSTs — `Bun.serve`'s `maxRequestBodySize` returns a bodiless 413 first, making `payloadTooLarge()` unreachable on the Content-Length path; `chat.html` then fails `r.json()` and shows no error | bug / contract | Med | S | LOW | HIGH | [032](032-honour-or-correct-the-413-envelope.md) |

**Run 6 theme:** four of the five are residuals of shipped plans (029 of 017's projection rule, 030 of 024's incomplete route coverage + flag list, 031 of 025's reader pattern that skipped `shared.ts`, 032 of 014's documented 413 envelope / the 025 envelope family); 028 is a deferred item from Runs 3–5 **promoted** after reproduction showed it is materially worse than written — not limited to the no-record case, and rooted in the global `spawns.json` key so two repos with the same task id collide even with a live record. The "applied to N of M" shape that Runs 4–5 kept finding (010→017, 015→023, 024 itself) appears again one level up: 024 closed 3 of 5 routes and left the same incomplete-projection pattern on the issue-draft 202. 032 is the same "documented envelope vs what the wire carries" shape as 025, one status code over.

Every finding was reproduced against `23f7471` before write-up, with isolated `HOME` fixtures, scratch repos, a fake `herdr` on a restricted `PATH`, and a real gateway on a high port; transcripts are in each plan's "Evidence" section (and in the Run 6 working notes under `.tmp-run6/FINDINGS.md`, not committed).

**Explicitly checked and not planned:** the bare `writeFileSync` on `gateway.pid` looks like a plan-019 leftover but 019's acceptance criterion exempts it; plan 023's "draft inside the cap is always publishable" invariant still holds under astral-header worst case; plan 026's once-only guards are intact; plan 027's pickup gate has no second stored-state channel; no new hang class.

### Run 7 — commit `63937ed`, 2026-10-02

Fresh post-032 review (Herdr pane `chore-harness-improve-run7` + `/improve` orientation via **anyr claude --yes --yolo --model stealth/space-bunny-alpha**; 4 parallel audit agents + direct manual verification). Scoped to the manager/gateway/issues/chat/CLI/shared surfaces, the residuals of shipped plans 010-032, and the deferred list from Runs 3-6. **202 green tests**, typecheck 0. Selection was non-interactive: top by leverage; **seven findings** (039 promoted mid-run when reproduction showed the deferred chat-adapter grandchild note is a documented hang).

| # | Finding | Category | Impact | Effort | Risk | Confidence | Plan |
|---|---------|----------|--------|--------|------|------------|------|
| 33 | `fingerprintFor` cuts to `JSON.stringify(raw).slice(0, 200)` when an event has no id **and** no `message`/`title`, so two distinct incidents sharing a 200-char prefix hash identically and share one draft path — the second overwrites the first, and if the first was published the second is stamped `github-created` and **never filed**, with the unauthenticated `202` reporting the lie | bug / data integrity | High | S | LOW–MED | HIGH | [033](033-stop-fingerprintfor-collapsing-distinct-events.md) |
| 34 | `looksLikeGateway`'s first branch is a raw substring (`command.includes("gateway.ts")`) while the second is token-aware, so `vim src/gateway.ts` classifies as `{kind:"gateway"}` and `gateway stop` destroys it — no `--force`, no refusal, in exactly the state a crashed or never-bound gateway leaves behind | bug / safety | High | S | LOW | HIGH | [034](034-tokenize-the-gateway-pid-identity-check.md) |
| 35 | `writeFileAtomic` does no `fsync` (a machine crash can leave a correctly-named empty file that every reader reads as "no state" — the exact failure it exists to prevent) and creates the temp at `0666 & ~umask`, so a `chmod 600` is reset to `644` on the next write under a `0755` state dir | bug / data integrity + security | Med | S | LOW | HIGH | [035](035-make-writefileatomic-durable-and-mode-preserving.md) |
| 36 | `waitHealth` accepts **any** 2xx as a healthy gateway, so a squatter on the port makes `gateway start` print `ok:true, listening:true` and exit 0 over a child that already died of `EADDRINUSE` — and the pid file it wrote names a corpse, with no `gateway.json` beside it | bug / contract | Med-High | S | LOW | HIGH | [036](036-stop-waithealth-accepting-any-2xx-as-a-healthy-gateway.md) |
| 37 | `readJsonPayload` is the last unguarded JSON reader in the harness: `JSON.parse(text) as Record<string, unknown>` accepts `"x"` and `[1,2,3]` and writes permanent content-derived drafts at exit 0, returns a raw `TypeError` string for `null`, and has no byte or depth ceiling (a 480 KB payload surfaces `RangeError`) | bug / robustness | Med | S | LOW | HIGH | [037](037-gate-the-cli-issues-ingest-payload.md) |
| 38 | `loadConfig` asserts `HarnessConfig` without checking it, so `{"tasks":"not-an-array"}` crashes `manager route`/`spawn`/`pick` with a raw `TypeError`; and a string `route.flags` is spread **character by character** into the `herdr agent start` argv — a config the shipped schema forbids and nothing validates | bug / robustness | Med | S–M | LOW | HIGH | [038](038-check-the-shapes-loadconfig-asserts.md) |
| 39 | `invokeAdapter`'s timeout SIGKILLs only the direct child while the promise settles solely on `close`; grandchildren holding stdout/stderr keep the pipe open, so `/chat` hangs past the documented timeout until the grandchild exits — contradicting `README.md:157`'s "never hangs" claim | bug / hang | High | S–M | MED | HIGH | [039](039-settle-invokeadapter-on-the-timer-not-on-stdio-eof.md) |

**Run 7 theme:** six of the seven are residuals of shipped plans (033 of 007's once-only guard, 034 of 012's PID identity, 035 of 019's atomic-write guarantee, 036 of 012's health probe, 037 of 025's JSON contract, 038 of 031's reader pattern, 039 of 008/009/013's timeout family) — 036 counted in both 012's health and 034's precondition story. This is the **fourth consecutive run** whose findings are residuals, and the "applied to N of M" shape Runs 4-6 kept naming has now recurred at every level of the reader family: 010→017, 015→023, 024→030, 025→031, and now 031→`loadConfig`. Five of the seven had already been deferred by name; **033, 034, 035, 036 and the chat-adapter grandchild note (→039) are promoted** because reproduction contradicted the reason they were deferred or ranked informational.

**Two deferred items were promoted because the stated reason for deferring them was wrong.** 033 had sat at MED confidence across Runs 5 and 6 on the grounds that it "needs an id-less, message-less, title-less shape" — that shape is an ordinary Sentry payload with a `stack` and no `event_id`, and it reproduces end to end through the unauthenticated route in three commands. 034 was deferred twice as having "a narrow reachability precondition, since `gateway.json` outlives a stop and is compared first"; `src/gateway.ts:950` is the only writer of that file and it runs **after** `Bun.serve` succeeds, so a crashed or never-bound gateway leaves a pid file with no meta at all — the ordinary case, not the narrow one. 036 then manufactures that same state on every squatted-port start.

**A fourth documented-invariant failure, in the shape Runs 5 and 6 named.** 033 is the third finding of the form *"the code and the documentation assert a property that the code does not hold"*, after plan 015's publishability invariant and plan 007's URL guard. Here both `src/issues.ts:80-82` and `README.md:100` state that fingerprinting the full payload prevents two large events from collapsing; the full payload *is* passed in, and `fingerprintFor` cuts it. The protection is in the right order and the wrong layer. As in the two before it, the plan verified a property over the input space its own fixture wrote rather than the input space the endpoint accepts.

Every finding was reproduced against `63937ed` before write-up, with isolated `HOME`/`PATH` fixtures, scratch repos, a real gateway on a high port, and a fake `gh`; transcripts are in each plan's "Evidence" section. Two of them (033 and 034) were reproduced **independently by two different audit agents** before the advisor's own reproduction, and 034's second victim shape and 036's `--foreground` twin came from those agent passes.

## Recommended execution order (Run 7 — `63937ed`)

```
033 (stop fingerprintFor collapsing distinct events) — silent, permanent data loss; unauthenticated; do first
039 (settle invokeAdapter on the timer, not stdio EOF) — documented hang on /chat; do second
034 (tokenize the gateway PID identity check)        — destroys unrelated processes; ahead of 036
036 (stop waitHealth accepting any 2xx)              — start lies + raw crash + stale pid; independent
038 (check the shapes loadConfig asserts)            — every command; raw stack traces + silent argv corruption
037 (gate the CLI issues ingest payload)             — closes 025's written-down residual; junk drafts
035 (make writeFileAtomic durable and mode-preserving) — integrity + confidentiality; can be dropped
```

**033 first.** It is the only finding whose failure is silent, permanent and unrecoverable by re-running, on a route with no authentication, and it is the only one where the harness's own `202` actively misreports the outcome. It is also a contained fix in one function.

**039 second.** It is the other documented-invariant failure in this run: `README.md:157` promises `/chat` never hangs on adapters, and a 1 s timeout leaving the promise unsettled at 5 s is the counterexample. Ranked immediately after 033 because it is a live hang on an unauthenticated loopback path once execute is enabled, and because it absorbs the deferred "grandchild survives SIGKILL" note (the surviving grandchild is *why* the request hangs).

**034 third, and ahead of 036 deliberately.** 036 *increases* the reachability of 034's precondition — a squatted port leaves a pid file with no `gateway.json` on every attempt — so closing 034 first means the state 036 creates is safe by the time 036 ships. 034 is also the one remaining finding that destroys work outside the harness, which is the class Run 3 ranked above everything else and the only failure mode plan 012 was filed to prevent.

**036, 038 and 037 are independent** of each other and of the first two; any order. 036 is the highest-leverage of the three because its fix closes three symptoms of one root and removes a way of manufacturing 034's precondition. 037 is the smallest and closes a residual the status table has already written down, so it is the easiest to justify and the easiest to drop.

**035 is last and is the one that can be dropped** without leaving anything dangerous behind. It is real and measured, but for a single-user `~/.local/state` the durability half is modest and the mode half is a tightening the operator can apply by hand today.

## Recommended execution order (Run 6 — `23f7471`)

```
028 (scope spawn records + tab matching to a repo)  — destroys unrelated work; do first
030 (carry 024's response contract to all 5 routes) — residual amp; pairs with 029
029 (drop path from the unauthenticated draft 202)  — security; one line; same function as 030
031 (guard the three shared.ts readers)             — independent; one file; S effort
032 (honour or correct the 413 envelope)            — independent; pick (a) or (b) + chat.html
```

**028 first.** It is the only finding whose failure mode silently destroys another repository's work while reporting `ok: true`, and it combines a false refusal (an operator blocked from a task they never started) with data loss. Run 3 ranked plan 012 above everything else for exactly this reason; 028 is the same class in a path 012 did not cover.

**030 next, with 029.** Same `projectIssueDraft` / response surface; 030's Vector A is the 400 KB echo and 029 is the last absolute path on that 202. Doing them together is efficient.

**031 and 032 are independent** and can run in any order. 032's default if no preference is option (b) (correct the docs) plus the `chat.html` harden; option (a) is only needed if the maintainer wants the JSON envelope on the wire.


## Recommended execution order (Run 5 — `cba1548`, shipped)

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
| 024 | Project the unauthenticated ingress POST responses | DONE — `projectTask` reuses `capText`, so the response and the stored event now share one bound and one truncation contract: a 200 KB POST went 204,971 → 412 bytes (`/ingress/matrix`), 204,975 → 416 (`/ingress/telegram`), 409,844 → 686 (`/chat`), each carrying `textTruncated` + the real `textBytes`. `stubReply` reads its task *through* the projection, which is what actually stops `/chat` carrying the payload twice — capping the task alone would have left the `reply` half uncapped. Ordinary responses are byte-identical, verified by diffing real response bytes with and without the change across 7 ordinary shapes; that required spreading the cap **over** the task rather than beside it, since `{...rest, ...capText(text)}` moves `text` to the end of the key order and `text` is not last. Two deviations from the plan: its `{ ok: true, ...result }` snippet does not typecheck (`TS2783` — `handleIngress` has one return and it already carries `ok`), and the plan's `IngressResult` type does not exist (it is `ReturnType<typeof handleIngress>`). `/chat`'s `stubReply` also runs in the *execute* path, where a capped prompt would have changed what the adapter is actually asked — it reads the projected task for the human-readable string only, and the prompt still gets the caller's full text | 014, 015 |
| 025 | Answer hostile input with the JSON envelope, not a 500 | DONE — `parseJsonObject` bounds nesting at 64 levels with an *iterative* walk, so the ceiling is a stated contract rather than a V8-version accident, and all five POST routes answer the documented 400 envelope instead of Bun's HTML 500 page; the plan's own 40,000-level reproducer (80,006 bytes, well under the 256 KB ceiling) is in the suite as a regression. Half B: `readJsonFile` now takes the caller's guard, `loadIngressQueue` checks `Array.isArray` and `listIssueDrafts` reads through `readStoredDraft`, so a state file that *parses* but is not usable reads as absent rather than reaching `.push` / `.filter` / the draft list. Each guard is separately load-bearing — mutation-checked, one failing test apiece. Step 3's optional last-resort handler wrapper was **deliberately not taken**: it breaks the existing "storage failures are not relabeled" contract in `tests/gateway-input.test.ts`, and once Steps 1–2 land the only throws left inside a handler are internal, so it would mask real faults for no input-shaped gain. Residual, not a crash: `harness issues ingest --file` on a deeply nested payload still reports a raw `RangeError` string in its (already graceful) `ok: false` envelope, since no depth gate covers that surface | 004, 019 |
| 026 | Never record `github-created` without a URL | DONE — exit 0 with no parseable URL is now `ok: false` and persists nothing (the timeout branch's conservative shape), the recogniser is host-flexible and reads the untruncated stdout, and `writeIssueDraft` refuses a URL-less `github-created`. Both named triggers (GHES host, >500-char preamble) now take the ordinary successful path, so neither duplicates on replay nor is erased by a re-ingest | 007 |
| 027 | Hold `/chat` summary pickup to the same bind check as execute | DONE — the pickup branch now reuses 008's loopback condition verbatim, including the `HARNESS_CHAT_ALLOW_REMOTE=1` opt-in, so the request the gate refuses with "must not be exposed to an untrusted network" is no longer handed the same response's stored excerpt. Stub replies stay ungated as documented at `README.md:163`, and deliberately **no** Origin check was added: an absent Origin has to keep working for curl and for the chat page, which `chatOriginAllowed` cannot distinguish from a browser. A refused pickup is a *silent* omit — no `lastSummary` key at all, rather than `null`, so the field's presence keeps meaning "pickup ran". Covered on loopback (all three triggers: `"pickup"`, `?pickup=`, and the literal `/summary`), non-loopback, the remote opt-in, the combined execute-refused-plus-pickup case, and the chat page on both binds; the gate was mutation-checked — the new test fails with `pickupAllowed` forced true | 008, 017 |
| 028 | Scope spawn records and tab matching to a repository | DONE — Steps 1–2 landed, Step 3 deliberately not. A `record.cwd` outside this checkout's tree now refuses `--replace` and `manager cleanup` **before the herdr probe**, so a foreign record runs no herdr subprocess at all (the tests assert an empty call list, not just the absence of `tab close`); the envelope names both `recordCwd` and `cwd` so the operator knows which tree to re-run in. Ownership is *mutual* containment rather than the plan's one-way "record under cwd", because a record written from the repo root and a CLI run from a subdirectory of it are the same tree and the literal reading would refuse the ordinary case; a missing/relative `cwd` is foreign, since an unplaceable record must not be destroyed on someone else's behalf. The `label` arm of `taskTabIds` now requires `t.workspace_id === (wtMatch?.open_workspace_id ?? record?.workspaceId)`, so `harness:<taskId>` — unique per task, not per repository — can no longer match across workspaces; the `tab_id` arm stays ungated (tab ids are workspace-scoped, so a stale one matches nothing rather than a neighbour). `executeCleanup` resolves the workspace *before* the tab match and reuses that same value for the re-list, since recomputing it after `worktree remove` would change the question the re-list asks. Six new cases in `tests/manager-spawn-scope.test.ts` over a two-repo fake herdr cover all three refusal shapes, both label-collision shapes, and 018's happy path now running against a listing that also contains a same-labelled tab in a *different* workspace — only ours is closed. Both halves are mutation-checked: the gate disabled fails the two foreign cases (exit 0, repo A's tab closed), the label arm unscoped fails the three label cases. **Step 3 (keying `spawns.json` by repo root) was not taken** — it needs a migration story or a documented "older records are ignored" rule, and a silent key change would orphan every live spawn's cleanup path | 018, 012 |
| 029 | Drop the absolute path from the unauthenticated issue-draft 202 | DONE — `projectIssueDraft` no longer carries `path`, so the last unprojected absolute path on an unauthenticated route is gone (the OS username and the state directory's layout with it). 017's rule is now stated where it applies — the projection keeps what identifies a delivery and its size and drops the filesystem layout — and the plan's out-of-scope holds were respected: no Origin or auth check was added, since `README.md:163` decides stub replies stay ungated, and `harness issues list --json` (`src/cli.ts:1205`) still returns the full stored drafts with `path`, because that reader is local and already needs disk access. Nothing is lost for correlation: the filename is derived from the fingerprint, which the answer still carries. The three existing tests that read the path off the wire now find the draft by that fingerprint and assert containment on the *stored* copy, which does record where it was written — so the property they were written for is still checked, one layer down | 017 |
| 030 | Carry plan 024's response contract to every POST route | DONE — both vectors, in `src/gateway.ts` only. **A:** `projectIssueDraft` caps `id`/`fingerprint` through `capString` at `ISSUE_DRAFT_ID_MAX_CHARS` (500, the same bound 023 applies where the fingerprint enters the *body*) and emits `idTruncated`/`idBytes` and `fingerprintTruncated`/`fingerprintBytes`, so a 200 KB `event_id` answers under 4 KB instead of ~400 KB. The cap is on the **reflection**: `fingerprintFor` is untouched, `draft.fingerprint` on disk is still the whole id, and the storage key is still derived from it — so two long ids sharing a 500-char prefix still cannot collapse onto one draft. `src/issues.ts` needed no change and got none. **B:** the per-field `capFlags(capped, field)` helper is gone; `CAPPED_FIELDS` is the one list, `CapField` is derived from it, and `capFieldFlags` walks it once to produce the flags that the stored event, `/status` *and* the POST response all spread — so `taskId`/`sender`/`channel` are no longer cut silently beside a flagged `text`. `handleIngress` returns those flags beside the task and `ingressResponse` consumes them, so nothing new appears at the top level of a 202. `text` keeps the task's uncapped value deliberately (the adapter prompt and the `/summary` pickup key both read it); the projection re-derives the capped value and takes the flag from the list. `Capped` became a discriminated pair, which is what lets the byte count be typed `number` and the flag `boolean` at every site — and removed the one `as` assertion the old helper carried. Uncut answers are byte-identical: pinned as literals across all five routes in `tests/gateway-response-projection.test.ts`, not as a key-set comparison. Both mutations are load-bearing — the id cap forced off fails `draft-id`, dropping `channel` from the list fails both `task-flags` and the structural `one-list` check. The existing "202 is bounded" fixture was tightened as the plan suggested: every shape it used oversizes a field the payload cap already bounds, so it could never have caught an echoed 200 KB `event_id` | 024, 023 |
| 031 | Guard the three `shared.ts` state readers | DONE — all three now check the shape beside their own parse, duplicating the three lines 025's `readJsonFile` already does rather than importing it: `gateway.ts` imports all of `shared.ts`, so reusing the helper would invert the dependency (a test asserts the import list stays clean). `loadSpawns` requires a record-of-records, which is the destructive one — an array-shaped `spawns.json` absorbed the record `manager spawn --execute` had just written and dropped it, because `saveSpawn` assigns a *named key* onto an array and `JSON.stringify` drops named properties, leaving the "task already spawned" guard reading the same empty map and a second worktree for a live task. `loadState` requires a record, so the next writer's spread cannot persist `{ "0": …, "1": …, lastPicked }` and lose `started`/`sessionId` to a fresh session id. `lastDelivery` is deliberately **stricter** than the plan's "exclude arrays at minimum": `/chat` pickup interpolates `at` and `excerpt` verbatim, so `[]` rendered `last summary (function at() { [native code] })` and a partial record rendered `undefined` — it now requires a record that *is* a delivery (`kind: "summary"` plus all seven declared fields). `writeSummaryDelivery` is the only writer and writes all seven, so no real record is refused, and a file that is not a delivery reads as no delivery. 34 wrong shapes across the three readers, each checked twice — the reader must not adopt the shape, and the write that follows the read must still be on disk (checked from the bytes, not through the reader). The mutation is textual and lands in a copy of `shared.ts`: putting each pre-031 body back and re-running the plan's own three reproducers shows the record lost, the array's indices persisted as state keys, and `at` back to `Array.prototype.at`. `loadState` has no `{}` row, because an empty object is a legal state and 016 made `lastPicked` optional. PID writes untouched, per 019 | 025, 019 |
| 032 | Honour or correct the documented 413 envelope | DONE — option **(b)**, correct the docs: measured against Bun 1.4.2 rather than assumed, and the documentation was what was wrong. A declared oversize is refused at the socket before the handler is entered; an undeclared one has its stream cut mid-read; at 1.02x, 1.5x and 3x the ceiling every combination answers a bare `413` with **no body at all** and the handler's own response is *discarded*. So `payloadTooLarge()` never reaches the wire and `README.md:159`'s promise of the `{ "ok": false, "error": "request body exceeds 262144 bytes" }` envelope was false for the path every `fetch`/`curl` takes. `README.md` now says the server answers, that the body must not be parsed, and that the envelope covers only the shapes the handler sees. `maxRequestBodySize` is untouched and both handler-side refusals stay — the plan's "keep them for the `readBoundedText` path" branch — because they are the honest answer for a direct `handleGatewayRequest` call (what the fixtures make) and for any future where the server ceiling is raised above this one; the comment above `payloadTooLarge` says so instead of implying it answers. The `chat.html` harden was needed under either option: `r.json()` is guarded like `refresh()`, and a bodiless 413, a 400 envelope, a non-JSON 200 and a dead socket each render a visible `.err` bubble naming the status. It is verified by running the shipped page's own `<script>` against a minimal DOM — the file, not a copy of its logic — and by mutation: reverting the guard fails the test with `Unexpected end of JSON input`, the plan's own symptom. A stale comment in `gateway-ingress-caps-runner.ts` claimed a modest chunked oversize still gets the JSON envelope; this measurement disproved it, and the comment now states what the assertion actually checks (the status line, and that nothing was written) | 014, 025 |
| 033 | Stop `fingerprintFor` collapsing two distinct error events onto one draft | DONE — one character range, in the function rather than around it. `fingerprintFor`'s fallback hashed `JSON.stringify(raw).slice(0, 200)`; it now hashes the **whole** serialized payload, and the `.slice(0, 16)` on the hex digest — where a bound belongs — is the only cut left. Nothing else moved: the `event_id`/`eventId`/`id` branch still returns the caller's id verbatim (asserted for all three keys plus a 1003-char id reaching storage whole, so 023's body cap and 030's reflection cap are untouched), `storageKeyFor` is unchanged and still receives a 16-char token inside `SAFE_KEY_RE`, and there is no timestamp or nonce anywhere in the storage key. `buildDraft`'s "fingerprint the full payload" comment and `README.md:100` were both false before this — the ordering was always right, the function then cut its own input — and both describe the code now, with `README.md` stating the fallback's guarantee explicitly rather than implying it. Six tests assert the property over the input space the endpoint accepts: a table of three id-less / message-less / title-less pairs that agree through exactly 200 characters and differ after (long stacks, differing key order, one byte apart at the end), an astral-plane pair whose surrogate pair straddles character 200, fingerprint *stability* — plan 007's guard must still fire, so the fix narrows the key and never widens it — and both end-to-end arms through `ingestErrorEvent` and `publishIssueDraft` against a fixture `gh`, checking the draft **bytes** rather than `listIssueDrafts`. Every fixture asserts its own precondition (shares the cut, differs past it, leaves a lone high surrogate at the cut) so the table cannot pass vacuously. Mutation: restoring `.slice(0, 200)` fails four of the six with the plan's own symptoms — *"the two incidents share a fingerprint"* and *"the second incident inherited the first's publication"*; the id-branch and stability tests correctly do not move. **One-time consequence, accepted:** drafts written before this commit keep the fingerprint they were stored under, so two incidents that were already collapsed under the old function stay collapsed and the overwritten body is not recoverable — a migration would orphan the publication record that makes a draft idempotent, which is exactly what plan 007 forbids | 007, 023, 026 |
| 034 | Tokenize the `looksLikeGateway` PID-identity check | OPEN | 012 |
| 035 | Make `writeFileAtomic` durable and mode-preserving | OPEN | 019 |
| 036 | Stop `waitHealth` accepting any 2xx as a healthy gateway | OPEN | 012 |
| 037 | Gate the `harness issues ingest` payload on shape, depth and size | OPEN | 020, 023, 025 |
| 038 | Check the shapes `loadConfig` asserts | OPEN | 031 |
| 039 | Settle `invokeAdapter` on the timer, not on stdio EOF | OPEN | 008, 009, 013 |

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

- **`resolveTask` returns a merged type, not a discriminated pair** — `src/shared.ts:245` returns two object literals (a bare error, and the task + `adapterId` + `route` together) that inference collapses into one type whose `task` / `adapterId` / `route` come out *independently optional*. Every caller that has already checked `error` still reads its adapter id as possibly undefined; 022 absorbed that in `src/gateway.ts` with `?? defaultAdapter` / `?? null`, which is correct but treats the symptom. Annotating the return as `{error: string, ...} | {error: null, task, adapterId, route, ...}` is the real fix and was measured: it cascades to 11 sites in `src/cli.ts` (lines ~369, 393, 574, 738, 776, 848, 862), all of them `?.` / `??` / `!` guards that a discriminant would make unnecessary. S effort, type-only, no runtime change. Deferred out of 022 for scope, not difficulty. **Run 5–7 re-check:** still open and unchanged — the merged return type is still at `src/shared.ts:245`, and the defensive fallbacks are visible at `src/cli.ts:369`, `src/cli.ts:380`, `src/cli.ts:738` and `src/gateway.ts:350-351`. Still the lowest-leverage item on the books; kept visible rather than promoted.

### Run 3/4 vetted, still deferred (ranked below the five)

- **`spawn --replace` with no record closes unscoped tabs** → **[028](028-scope-spawn-records-to-a-repo.md)** (promoted in Run 6). Reproduction showed it is materially worse than written: not limited to the no-record case, and the root cause is the global `spawns.json` key, so two repos with the same task id collide even with a live record. `--replace` in repo B closes repo A's tab and removes repo A's worktree while reporting `ok: true`.
- **Chat adapter timeouts kill only the direct child** → **[039](039-settle-invokeadapter-on-the-timer-not-on-stdio-eof.md)** (promoted in Run 7). Earlier scored LOW/informational because the adapter is trusted; Run 7 showed the surviving grandchild keeps stdout/stderr open, so the promise never settles on the timer and `/chat` hangs past the documented timeout — contradicting `README.md:157`.
- **`harness summary | jq` emits markdown** — `cmdStatus`/`cmdPick` use `--json || !process.stdout.isTTY`; `cmdSummary` (`src/cli.ts:1439`) checks only `--json`. S effort, dx-only. **Run 5: still reproduces** (verified: piping `harness summary` yields `# harness daily summary`). Ranked below every Run 5 plan.
- **`waitHealth` treats any 2xx from the port as success** → **[036](036-stop-waithealth-accepting-any-2xx-as-a-healthy-gateway.md)** (promoted in Run 7). Reproduction: a squatter answering any 2xx makes `gateway start` print `ok:true, listening:true` over a child already dead of `EADDRINUSE`, and leaves a pid file with no `gateway.json`.
- **README/schema drift** — `README.md` still runs `harness upgrade` before extending `PATH`; `herdr-harness.schema.json` omits `adapters.chat.executeKinds` under `additionalProperties: false`; `HERDR_BIN_PATH`/`HERDR_SOCKET` undocumented. All S-effort docs; fold into a docs-only follow-up. **Partly done in 021:** the Verification section now names the current 22 test files / 169 tests and documents the typecheck baseline. **Run 5 sharpened this:** `adapters` is `additionalProperties: false` with only `default`/`routes`, so the `adapters.chat.executeKinds` shape that plan 008's gate reads is **rejected by the shipped schema outright** — not merely undocumented. Confirmed by reading `herdr-harness.schema.json`. **Run 6:** still deferred — nothing in the repo validates against the schema at runtime (the `$id` targets editors), so the blast radius is "your editor flags the config red", not "the harness refuses to run".

### Run 5 items promoted in Run 6

- `spawn --replace` unscoped tab match (deferred since Run 3/4) → **[028](028-scope-spawn-records-to-a-repo.md)**

### Filed by Run 5, vetted and deferred (did not make the top five)

- **`looksLikeGateway` matches any command line merely *mentioning* `gateway.ts`** → **[034](034-tokenize-the-gateway-pid-identity-check.md)** (promoted in Run 7). The "narrow reachability" rationale was wrong: `gateway.json` is written only *after* `Bun.serve` succeeds, so a crashed or never-bound gateway leaves a bare pid file — the ordinary case. Reproduced: `vim src/gateway.ts` classified as `{kind:"gateway"}` and `gateway stop` destroyed it with no `--force`.
- **`fingerprintFor`'s 200-char prefix cut collapses distinct events onto one fingerprint** → **[033](033-stop-fingerprintfor-collapsing-distinct-events.md)** (promoted in Run 7). The "needs an id-less, message-less, title-less shape" caveat was wrong — that is an ordinary Sentry payload with a `stack` and no `event_id`, and it reproduces end to end through the unauthenticated `/ingress/sentry` route. Documented invariant at `README.md:100` / `src/issues.ts:80-82` does not hold.
- **`writeFileAtomic` is atomic for readers but not durable, and resets the target's mode** → **[035](035-make-writefileatomic-durable-and-mode-preserving.md)** (promoted in Run 7; last in exec order and droppable). Both halves measured at tip; still LOW blast radius for single-user state, kept as the optional closing item.
- **The issue-draft directory bound is soft by construction** — `trimIssueDrafts` `continue`s past `github-created` entries and unparseable files forever, so a directory that fills with published drafts grows without limit. This is deliberate (`src/issues.ts:173-178` — a `github-created` draft is what stops a replay filing a duplicate) and the per-POST bound still holds. Recorded so `ISSUES_DIR_MAX_DRAFTS`/`MAX_BYTES` are read as best-effort, not invariants.

### Run 5/3 items promoted in Run 7

- `fingerprintFor` 200-char collapse → **[033](033-stop-fingerprintfor-collapsing-distinct-events.md)**
- `looksLikeGateway` substring → **[034](034-tokenize-the-gateway-pid-identity-check.md)**
- `writeFileAtomic` durability/mode → **[035](035-make-writefileatomic-durable-and-mode-preserving.md)**
- `waitHealth` any-2xx → **[036](036-stop-waithealth-accepting-any-2xx-as-a-healthy-gateway.md)**
- Chat adapter grandchild / timeout hang → **[039](039-settle-invokeadapter-on-the-timer-not-on-stdio-eof.md)**

### Filed by Run 7, vetted and deferred (did not make the top set)

- **`harness summary | jq` emits markdown** — still reproduces; dx-only; ranked below every Run 7 plan. **Run 7 re-check:** `cmdSummary` still checks only `--json`.
- **README/schema drift** (`adapters.chat.executeKinds` rejected by schema; upgrade-before-PATH; undocumented `HERDR_*`) — still deferred; editor-only blast radius. Overlaps 038's config-shape story but 038 is the runtime check; schema/docs stay a docs follow-up.
- **Soft issue-draft directory bound** (`github-created` forever) — still deliberate; not promoted.
- **`resolveTask` merged return type** — still lowest-leverage type-only item; **Run 7 re-check:** unchanged at `src/shared.ts:245`.

### Filed by Run 6, vetted and deferred (did not make the top four)

- Nothing new deferred from Run 6's candidate pool that was not already on the books. The five findings above were the full promoted set; several candidates were **checked and dropped** (PID `writeFileSync` exempted by 019; 023/026/027 invariants hold; no new hang class). The deferred list above was re-checked item-by-item at `23f7471` — see each item's Run 6 note.

### Direction options (grounded, not defects — for the maintainer to weigh)

- **The harness is not a closed loop.** `pick` names work but cannot start it (`resolveTask` resolves only config task ids, so `manager spawn "$(harness pick --json | .id)"` fails for the issue and freeform tiers by construction), and Matrix/Telegram ingress is write-only — events are resolved, acknowledged `202`, and dropped, because the freeform tier sits behind `else if (tasks.length)`. Every spawn today is a manual transcription of a `pick` output. **Run 4:** still true after plan 016's rotation. **Run 5–7:** still true; nothing in 023-039 moves it. **Run 6 note:** finding 028 made a naive `pick`-driven spawn more dangerous; **Run 7:** 028 shipped, so the closed-loop gap is no longer amplified by cross-repo teardown, but pick still cannot spawn.
- **Three declared config keys are inert.** `soul` is echoed into `manager status` only; `playbooks` is echoed into the summary and dispatched nowhere (dispatch hardcoded to `PLAYBOOK_SENTRY`); `enabled` is in the schema, absent from the type, and read by nothing. **Run 5–7:** re-confirmed by reading both `src/shared.ts` and the schema.
- **Retiring a picked draft needs a command.** Still the top direction item after plan 016: a `harness issues done|rm` subcommand plus a third `status` in the `IssueDraft` union. Must survive a replayed upstream event (plan 007). **Run 5–7 note:** this interacts with plan 026 — a `done` status must be handled by *both* once-only guards alongside `github-created`, or a retired draft becomes a re-fileable one. Runs 6–7 did not promote it (direction, not defect).

## Not audited in depth

- Herdr host integration beyond CLI dry-run/status surfaces (a real `herdr` binary exists on the review machine; no live worktree/tab/agent operation was performed, and plan 013's test fixtures use a fake `herdr`)
- Chat UI static assets polish
- Cross-repo plugin packaging / release-please (intentionally untouched)
- `templates/soul.md` beyond reading it
