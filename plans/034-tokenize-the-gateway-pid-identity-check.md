# Plan 034: Tokenize the `looksLikeGateway` PID-identity check (residual of plan 012)

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 63937ed..HEAD -- src/cli.ts tests/gateway-pid.test.ts`
> If `looksLikeGateway` already matches `gateway.ts` as a **token** (whole path element) rather than a raw substring, STOP and report.

## Status

- **Priority:** P0
- **Effort:** S
- **Risk:** LOW
- **Depends on:** `plans/012-verify-gateway-pid-identity.md` (shipped)
- **Category:** bug / safety
- **Confidence:** HIGH (reproduced 2026-10-02 against `63937ed` — an unrelated process was destroyed end to end)
- **Planned at:** commit `63937ed`, 2026-10-02 (Run 7)

## Why this matters

Plan 012 exists so that `gateway stop` cannot SIGKILL a recycled PID and destroy an unrelated process. Its acceptance is stated as a safety property, and `pidIdentity` is built around it — *"Cannot verify" always resolves to `recycled` — a false refusal is recoverable, a false match destroys an unrelated process.*

The first branch of that decision is a raw substring test:

```ts
// src/cli.ts:1013
function looksLikeGateway(command: string): boolean {
  if (command.includes("gateway.ts")) return true;
  const word = (w: string) => new RegExp(`(^|\\s)${w}(\\s|$)`).test(command);
  return command.includes("cli.ts") && word("gateway") && word("start");
}
```

The second branch of the **same function** is token-aware. So any process whose command line merely *mentions* the string `gateway.ts` — `vim src/gateway.ts`, `grep -rn gateway.ts src/`, `less README.md gateway.ts`, `claude -p "fix gateway.ts"`, a test runner, a `tail -f` — is classified `{ kind: "gateway" }`, and `gateway stop` kills it with **no `--force` and no warning**.

**Reachability, stated honestly.** `pidIdentity` consults `gateway.json` first and a *mismatched* recorded pid is caught one step earlier. The gap is that this second check is reached whenever `gateway.json` is **absent, unparseable, or not an object** — `readGatewayMeta` returns `null` for all three and the function falls through rather than counting it as proof.

Runs 5 and 6 both called that precondition "narrow — `gateway.json` outlives a stop and is compared first." **That reasoning is wrong about the common case, and this is the correction that promotes the item.** `src/gateway.ts:950` is the *only* writer of `gateway.json`, and it is reached only after `Bun.serve` has already succeeded. A gateway that crashed, was killed, or never bound leaves `gateway.pid` on disk with **no `gateway.json` at all** — not as an edge case, but as the ordinary residue of any start that did not complete. `cmdGatewayStop` unlinks the pid file on a clean stop but never the meta, so the meta is *stale*, not *missing*, only for a gateway that ran and stopped; every failed or interrupted start is the missing case, and a pid file with no meta is exactly the state in which a recycled pid gets killed.

Three other routes to the same state: a cleared or fresh `~/.local/state/herdr-harness/`; a corrupt or truncated meta, which `readGatewayMeta` turns into the same `null`; and **[036](../036-stop-waithealth-accepting-any-2xx-as-a-healthy-gateway.md)**, where a squatted port produces precisely this on *every* attempt — the child dies at `Bun.serve` before writing the meta, and the pid file was already written.

## Current state

```ts
// src/cli.ts:1013-1017  — branch one is a substring, branch two is token-aware
function looksLikeGateway(command: string): boolean {
  if (command.includes("gateway.ts")) return true;      // <-- matches "vim src/gateway.ts"
  const word = (w: string) => new RegExp(`(^|\\s)${w}(\\s|$)`).test(command);
  return command.includes("cli.ts") && word("gateway") && word("start");
}
```

The real gateway is spawned as `bun <ROOT>/src/gateway.ts` (`src/cli.ts:1092`) and the `--foreground` path is the CLI itself running `gateway start` — so the second, token-aware branch is what actually recognises both, and the substring branch is what recognises nothing legitimate that the second misses.

## Evidence

Isolated `HOME`, a real `harness` CLI, and a harmless unrelated process whose command line merely mentions `gateway.ts` — the same shape as `vim src/gateway.ts`:

```
victim pid=3232736
victim cmdline: /bin/bash /tmp/run7/fake/src/gateway.ts

--- harness gateway status ---
{ "ok": true, "listening": true, "pid": 3232736,
  "identity": { "kind": "gateway" } }

--- harness gateway stop (NO --force) ---
{ "ok": true, "stopped": true, "pid": 3232736 }

--- is the unrelated process still alive? ---
*** KILLED — an unrelated process was destroyed ***
```

`gateway status` asserted the identity positively and `gateway stop` destroyed the process. The operator had no refusal, no `--force` and no hint. Once killed, the CLI also unlinks `gateway.pid`, so the evidence is gone.

A second audit reproduced this independently with a different victim shape — `cp /bin/sleep /tmp/ha/gateway.ts` run as a long-lived process, which is the same class as `vim src/gateway.ts` — and additionally swept the near-misses that must be refused: `claude -p "fix gateway.ts"`, `less src/gateway.ts`, `my-editor gateway.ts.notes` and `tail -f gateway.ts.log` all return `true` from the current function.

## Steps

1. Make the `gateway.ts` branch token-aware, matching the branch already below it. The real argv is `bun <ROOT>/src/gateway.ts`, so the discriminating property is that `gateway.ts` is the **final path element of an argument** — an editor or a `grep` mentions it as a prefix or a mid-string, not as a whole trailing element.
2. Reuse the same `word`-style helper the second branch already defines rather than adding a second idiom; one predicate for "this argv mentions X as a token", used by both branches.
3. Keep the `cli.ts` + `gateway` + `start` branch exactly as it is — it is the `--foreground` shape and it is already correct.
4. Leave `pidIdentity`'s layering alone. "Cannot verify → recycled" is right and must stay right; this plan only makes the *positive* match harder to reach falsely.

## Tests

- The real spawn shape still passes: `bun <ROOT>/src/gateway.ts` classifies as `{kind:"gateway"}`, and the `--foreground` shape `bun <ROOT>/src/cli.ts gateway start` does too. **Assert the positive cases explicitly** — a fix that only adds rejections is a fix that breaks `gateway stop`.
- A table of near-miss command lines that must classify as `recycled`, each of which a substring test would accept: `vim src/gateway.ts`, `grep -rn gateway.ts src/`, `less README.md gateway.ts`, `claude -p "fix gateway.ts"`, `tail -f /var/log/gateway.ts.log`, `node gateway.tsx`, `gateway.ts.bak`, and a path that merely *contains* the token mid-element (`/opt/gateway.ts.backup/run`).
- At least one end-to-end case against the real `cmdGatewayStop` with a live unrelated process holding the token: assert it survives and the envelope is `ok:false, refused:true` with `removedPidFile:true` — the same refusal shape the recycled-pid path already produces.
- One case with `gateway.json` **absent** and one with it **corrupt**, both of which must still refuse rather than fall through to a match.
- One mutation-check: restore `command.includes("gateway.ts")` and confirm the table fails.

## Gates

- `bun test` green; `bun run typecheck` exit 0.
- `src/gateway.ts` untouched.

## STOP conditions

- **Do not** tighten this into "refuse unless `gateway.json` agrees". That would change `gateway stop` behaviour for a legitimately running gateway whose meta is missing, which is a different finding and a different decision.
- **Do not** add a `ps`-based or `/proc`-based second evidence source. One positive matcher, correctly tokenized, is the fix; layering more heuristics raises the false-match surface rather than lowering it.
- **Do not** fold in 036's health-probe fix. They are independent functions with independent tests; doing them together makes a red test ambiguous about which change caused it.

## Acceptance

- `vim src/gateway.ts`, `grep -rn gateway.ts src/` and every other token-*mentioning* command line classify as `recycled`.
- A real harness gateway — both the detached spawn and the `--foreground` form — still classifies as `gateway` and is still stoppable.
- 202+ tests green; `bun run typecheck` exit 0.
