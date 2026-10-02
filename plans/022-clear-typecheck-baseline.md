# Plan 022: Clear the typecheck baseline, then make `typecheck` a CI gate

> **Executor instructions:** this is the follow-up filed by plan 021's STOP condition. Execute only when separately requested.

## Status

**DONE.** `bun run typecheck` exits 0 and `.github/workflows/test.yml`'s `typecheck` job no longer sets `continue-on-error`.

- **Priority:** P2
- **Effort:** S–M
- **Risk:** LOW–MED — mostly annotation/test-fixture work; the `src/` half touches three gateway sites
- **Depends on:** [021](021-typecheck-and-minimal-ci.md) (shipped partial — `tsconfig.json` + `typecheck` script landed, workflow landed non-blocking)
- **Category:** tests / dx
- **Filed at:** `9c6121c` + plan 021's commit, 2026-10-02
- **Executed:** 2026-10-02, against `a575f26`

> **What landed.** All 23 errors cleared with `strict: true`, `strictNullChecks` and the DOM lib untouched; `tsconfig.json` is byte-identical to the 021 commit.
>
> - **`src/` (3, both real fixes).** `gateway.ts:292` — `capFlags` typed both key families as one `boolean | number` union, so a byte count could pass as a truncation flag; the flag is always `true` and the count always lands under `<field>Bytes`, and the tests plus the `/status` projection already assumed that, so the return type is now a mapped type that picks the two apart from `IngressEvent`. The single `as` left in the helper was already there and now states a narrower, true shape. `gateway.ts:396`/`437` — `handleIngress` re-derived `adapterId`/`routeObj` after the fact with `"adapterId" in route` guards, which TypeScript cannot narrow to a value; both are now read on the branch that establishes there is no error, with the fallbacks `resolveTask` itself applies. No behaviour change: the old guards were true exactly when the new assignments run.
> - **B1 (8).** Kept the DOM lib; the `fetch` stubs now carry Bun's non-standard `preconnect` alongside the call signature, so they are real `typeof fetch` values rather than casts.
> - **B2 (6).** Declaration merge in `tests/bun-test.d.ts`; `node_modules` untouched. Verified load-bearing — removing the file brings all six errors back.
> - **B3 (6).** Genuine findings: a typed `readJson<T>()` accessor, `server.port ?? 0` behind the existing assertion, and a narrowing cast on the deliberately hostile `pick` cursor that keeps the hostile input.
>
> **No STOP was hit.** `gateway.ts:292` was confirmed against the on-disk shape before changing either side — `capString` returns a count that has always gone to `<field>Bytes`, never into the boolean — so this is a type-only fix, not a behaviour fix. `@types/bun` was not patched.
>
> **Follow-up filed** (not done here, out of scope): `resolveTask` in `src/shared.ts` infers one merged return type rather than a discriminated pair, which is the root cause of the `396`/`437` pair. Annotated properly it cascades to 11 type-only sites in `src/cli.ts`. Recorded under "Filed by 022" in `plans/README.md`.
>
> Step 6 (tightening toward canonical `noUncheckedIndexedAccess` / `noImplicitOverride` / `noFallthroughCasesInSwitch`) was not attempted — it is a separate, deliberate tightening, not part of clearing the baseline.

## Why this matters

Plan 021 added `tsconfig.json` and `bun run typecheck` but hit its STOP condition: tip does **not** typecheck green, and getting it green requires editing `src/` and `tests/`, which 021's scope forbade. The workflow's `typecheck` job therefore ships with `continue-on-error: true`. This plan clears the baseline so the gate can be enforced.

## Current state

`bun run typecheck` at the 021 commit: **23 errors, 3 of them in `src/`.** Baseline is measured with:

- `tsconfig.json`: `strict: true`, `lib: ["ES2023", "DOM"]`, `types: ["bun"]`, `noEmit`, `module: "Preserve"`, `moduleResolution: "bundler"`.
- `typescript@7.0.2`, `@types/bun@1.4.2` (devDependencies added by 021).

**Do not try to reach zero by weakening `strict`.** It was measured and makes things *worse*:

| config | errors | `src/` |
|---|---|---|
| shipped `strict: true` + DOM lib | **23** | 3 |
| `strict: false` | 25 | 1 |
| `strict: true`, `strictNullChecks: false` | 28 | 1 |
| canonical `@tsconfig/bun` as shipped | 189 | 11 |
| + `noUncheckedIndexedAccess` | 189+ | — |

`strict: true` is already the tightest setting that gets closest. The 23 errors are real findings, not noise.

## The 23 errors

### A. `src/` — 3 errors, the only ones that touch runtime

| site | code | finding |
|---|---|---|
| `src/gateway.ts:292` | TS2322 | `IngressEvent` assignability. `capText()` returns `number \| boolean \| undefined` for the `*Truncated` fields; `IngressEvent` declares `boolean \| undefined`. The truncation *count* is leaking into a boolean slot. |
| `src/gateway.ts:396` | TS2345 | `string \| undefined` passed where `string` is required (`chatAdapterKind(result.task.adapterId, …)`). |
| `src/gateway.ts:437` | TS2345 | same shape, `chatAdapterArgv(adapterId, …)`. |

All three are **type-shape** findings, not behaviour changes — 021's caller was told not to force `src/` edits in the same PR, so they stayed. 292 is the one worth a real look: if `capText` genuinely returns a count, the persisted event shape may be wrong (or the type is), and that is a data-integrity question in the same family as plan 019/020.

### B. `tests/` — 20 errors

**B1. `fetch` stub missing `preconnect` — 8 errors (TS2741), all in `tests/fixtures/*-runner.ts`.**
`spyOn(globalThis, "fetch").mockImplementation(() => unexpected("fetch"))` fails because the DOM lib's `typeof fetch` requires `preconnect`. This is a **type-library artifact**, not a bug: the stub is correct at runtime. Fix by widening the mock (`as typeof fetch` / `as never`) or by dropping the DOM lib and typing the JSON helpers explicitly — see step 1.

**B2. `describe`/`test` options overload — 6 errors (TS2554 ×5, TS2353 ×1).**
`describe("…", { timeout: 60000 }, () => …)` and `test("…", { timeout: 30_000 }, () => …)` are valid `bun:test` APIs, but `@types/bun@1.4.2` does not type the options argument. The tests are correct; the types lag. Fix by a local declaration merge, or wait for `@types/bun`.

**B3. Genuine strict findings in fixture helpers — 6 errors.**
- `tests/fixtures/atomic-state-writes-runner.ts:73,102,109` (TS2571) — `readJson(...).sessionId` on an `unknown` return; needs a typed accessor.
- `tests/fixtures/gateway-ingress-caps-runner.ts:327` (TS18048) — `'port' is possibly 'undefined'`.
- `tests/fixtures/gateway-ingress-caps-runner.ts:333` (TS2769) — no overload matches.
- `tests/fixtures/pick-rotation-runner.ts:34` (TS2345) — `saveState({...loadState(), ...planted})` where `planted.lastPicked` is deliberately `unknown` (the fixture plants a hostile cursor). Needs a narrowing cast that keeps the hostile input.

## Steps

1. Resolve B1 properly rather than blanket-disabling it: the 8 `preconnect` errors and the 116 `unknown` errors the DOM lib suppresses are the same trade — the DOM lib re-declares `Body.json()` as `Promise<any>` where Bun types it (correctly) as `Promise<unknown>`. Pick one:
   - keep the DOM lib and widen the 8 fetch mocks (smallest diff, keeps `json(): any`), **or**
   - drop the DOM lib and type the JSON helpers in `tests/fixtures/*` and `src/gateway.ts` (better types, much larger diff).
   Recommend the first for this plan; revisit under B2's note below.
2. Fix the 3 `src/gateway.ts` errors. Confirm 292 against the on-disk state shape before changing either side — if the count really is being persisted as a truncation flag, that is a behaviour fix and needs its own plan, not a silent type assertion.
3. Fix the 6 genuine fixture findings (B3).
4. Work around B2 — declaration merge in a `tests/bun-test.d.ts`, or an explicit note if `@types/bun` lands the overload first.
5. Re-run `bun run typecheck` until 0. Then **remove `continue-on-error: true`** from `.github/workflows/test.yml` so the job is a real gate.
6. Once green, optionally tighten toward canonical (`noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`) one flag at a time.

## Done criteria

- [x] `bun run typecheck` exits 0
- [x] `.github/workflows/test.yml` no longer sets `continue-on-error` on the typecheck job
- [x] Any `src/` change is a real fix, not a cast added to silence the checker
- [x] `bun test` still green (169 tests / 22 files at the 021 commit)

## STOP conditions

- Fixing `src/gateway.ts:292` turns out to be a **behaviour** change (the persisted truncation flag is wrong): stop, file it as its own plan, and land the type-only portion.
- The B2 workaround requires patching `@types/bun` in place: stop and wait for upstream instead.
