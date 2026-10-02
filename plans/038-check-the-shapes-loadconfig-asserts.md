# Plan 038: Check the shapes `loadConfig` asserts (residual of plan 031)

> **Executor instructions:** This is an advisory handoff, not authorization to implement. Execute only when separately requested. Follow every step, run every gate, honor STOP conditions, then update this plan's row in `plans/README.md`. No commits, pushes, issues, remotes or PRs without separate authorization.
>
> **Drift check (first):** `git diff --stat 63937ed..HEAD -- src/shared.ts tests/shared-state-readers.test.ts`
> If `loadConfig` already validates the shapes it returns — `tasks` an array, `adapters.routes` a record, `route.flags` an array of strings — STOP and report.

## Status

- **Priority:** P2
- **Effort:** S–M
- **Risk:** LOW
- **Depends on:** `plans/031-guard-the-shared-state-readers.md` (shipped)
- **Category:** bug / robustness
- **Confidence:** HIGH (both vectors reproduced 2026-10-02 against `63937ed`; surfaced by a Run 7 audit agent and independently re-verified)
- **Planned at:** commit `63937ed`, 2026-10-02 (Run 7)

## Why this matters

Plan 031 closed the reader family in `src/shared.ts` — `loadState`, `loadSpawns` and `lastDelivery` each gained a shape check beside their own parse. It left the fourth reader alone, and this one is the only file in the repo that ships a JSON Schema that **nothing validates**:

```ts
// src/shared.ts:285
return { path, config: JSON.parse(readFileSync(path, "utf8")) as HarnessConfig };
```

That cast is the same pattern 025 removed from `readJsonFile` and 031 removed from the three state readers. `findConfigPath` walks from the cwd up to `/`, so a stray `.herdr-harness.json` in **any** ancestor directory — including `$HOME` — is trusted. Two consequences, both reproduced:

**Vector A — a wrong-shaped config crashes commands with a raw stack trace.** Every command that calls `loadConfig` inherits the failure, and none of them reaches its own `printJson` error path because the throw happens inside `resolveTask` or `cmdPick`:

```
$ cat .herdr-harness.json   # {"tasks":"not-an-array"}
$ harness manager route t1
299 |   const task = tasks.find((t) => t.id === taskId);
                           ^
TypeError: tasks.find is not a function.
      at resolveTask (src/shared.ts:299:22)
      at cmdManagerRoute (src/cli.ts:344:20)
EXIT=1
```

`harness pick` and `harness manager spawn` fail identically. A JSON-speaking CLI answering a stack trace is the same contract break plan 025 was filed for on the HTTP side.

**Vector B — a string where the schema says array silently corrupts the argv.** `agentSpec` and `chatAdapterArgv` spread `route.flags` into a command line. When `flags` is a string rather than an array of strings, a spread iterates its *characters*:

```
$ cat .herdr-harness.json
{ "adapters": { "default": "claude",
    "routes": { "claude": { "kind": "claude",
                            "flags": "--verbose --dangerously-skip-permissions" } } },
  "tasks": [ { "id": "t1" } ] }

intended agent-start argv:
["herdr","agent","start","harness:t1","--kind","claude","--pane","<pane-id>",
 "--","-","-","v","e","r","b","o","s","e"," ","-","-","d","a","n","g", … ]
```

`herdr-harness.schema.json` declares `flags` as an array of strings, and the operator's editor will flag it red — but nothing in the harness does, so the mistake survives to `--execute`, where those 32 single-character arguments are what actually reach `herdr agent start`. The same spread shape is in `chatAdapterArgv` (`src/chat.ts:90`), one hop from a subprocess spawn.

**This is the same "applied to N of M" pattern Runs 4–6 kept finding, at its last site.** 010→017, 015→023, 024→030, 025→031, and now 031→`loadConfig`. Each plan closed the readers it happened to touch.

**Reachability, stated honestly:** the config is operator-written and trusted — this is not an unauthenticated surface, and nothing here is a vulnerability. It ranks where it does because the blast radius is *every* command rather than one route, and because Vector B fails silently in the one mode (`--execute`) where the operator has asked for something to actually happen.

## Current state

```ts
// src/shared.ts:281
export function loadConfig(): { path: string | null; config: HarnessConfig | null } {
  const path = findConfigPath();
  if (!path) return { path: null, config: null };
  try {
    return { path, config: JSON.parse(readFileSync(path, "utf8")) as HarnessConfig };
  } catch { return { path, config: null }; }
}
```

The `catch` is already the right shape — it just guards the *parse*, not the *result*, which is the same sentence `readJsonFile`'s own comment makes ("Parsing is not checking"). `shared.ts` already has the `isRecord` predicate 031 added; it is a few lines above.

## Evidence

```
=== Vector A: tasks is a string, not an array ===
$ harness manager route t1
TypeError: tasks.find is not a function.
      at resolveTask (src/shared.ts:299:22)
      at cmdManagerRoute (src/cli.ts:344:20)
EXIT=1

--- the same config through pick / manager spawn ---
  (cmdPick: 1351  |  resolveTask: 295)   <- same throw, three commands

=== Vector B: route.flags is a STRING, not an array ===
intended agent-start argv:
["herdr","agent","start","harness:t1","--kind","claude","--pane","<pane-id>","--","-","-","v","e","r","b","o","s","e"," ","-","-","d","a","n","g","e","r","o","u","s","l","y","-","s","k","i","p","-","p","e","r","m","i","s","s","i","o","n","s"]
```

The config was placed in `$HOME` while running from `$HOME/sub/deep`, confirming `findConfigPath`'s upward walk makes it reachable from a directory that is not the repository at all.

**The schema that would have caught both, which nothing reads:**

```
routes.additionalProperties: { "$ref": "#/$defs/adapterRoute" }
adapters.additionalProperties: false
chat key declared?: false
$ grep -rn "schema" src/ tests/ .github/
(nothing)
```

Note the third line: the same schema run already found in Runs 5–6 — `adapters.chat.executeKinds`, the key plan 008's execute gate reads, is not declared under an `additionalProperties: false` block. This plan does not fix that; it is the docs/schema drift item still on the books.

## Steps

1. Check the top-level shape first. `loadConfig` should require a record before it returns one, reusing the `isRecord` already in `shared.ts`. A `null` / `[]` / `"x"` config is a refusal, not a `HarnessConfig`.
2. Check the fields the code actually calls methods on. `tasks` must be an array; `adapters.routes` must be a record; `playbooks` must be an array. This is the same "check the shape beside the parse" pattern 031 applied, one file over.
3. Decide what a wrong-shaped config means: refuse with a **named** error naming the field and the path — the same operator-facing shape `readJsonPayload`'s "empty payload" refusal uses — rather than degrading to `{ config: null }`, which silently runs the harness against defaults and is worse than either a crash or a refusal. Whatever is chosen, one wrong field must not take the other, valid fields down with it.
4. Guard `route.flags` where it is spread, not only in the config reader. `agentSpec` (`src/cli.ts:371`) and `chatAdapterArgv` (`src/chat.ts:90`) both need `Array.isArray` — a spread over a non-iterable throws, and a spread over a string iterates characters, and a reader-side check alone is the second thing that would have to remember the same rule.
5. Leave `findConfigPath` alone. Walking up to `/` is the documented discovery behaviour and the fallback to the bundled example is what makes a fresh install work.
6. Do **not** add runtime schema validation as part of this plan. Reading `herdr-harness.schema.json` at runtime would be a new dependency and a new failure mode; the shape checks above are the fix, and the schema stays an editor-time aid.

## Tests

- A wrong-shape table over the config: `null`, `[]`, `"x"`, `42`, `{"tasks":"str"}`, `{"tasks":{}}`, `{"adapters":{"routes":[]}}`, `{"adapters":"str"}`, `{"playbooks":{}}` — each must produce a named refusal, and **no command may emit a raw stack trace**. Assert the absence of `TypeError` in the output, not just the exit code.
- Placement: the same config reached from a subdirectory of the repo, and from `$HOME` with the cwd several levels below it, confirming the upward walk is covered.
- **Vector B both directions:** a string `flags` must be refused or ignored-with-a-named-reason, and must **never** produce single-character argv elements. Assert on the rendered `intendedCommands` array — the exact vector above is the regression.
- A valid config with `flags: ["--a", "--b"]` still renders `["--a","--b"]` unchanged; assert the ordinary case as a literal so a fix that drops flags entirely cannot pass.
- `chatAdapterArgv` gets the same `flags` treatment, since it is a separate spread site with its own caller.
- One partial case: a config whose `tasks` is wrong but whose `adapters` is valid — decide and assert whether the whole config is refused or the bad field is reported in isolation. Whichever is chosen, state it in the plan's acceptance notes; silent whole-config degradation is the outcome to rule out.
- One mutation-check: restore the bare cast and confirm the `tasks`-as-string case fails.

## Gates

- `bun test` green; `bun run typecheck` exit 0.
- `herdr-harness.schema.json` untouched — see STOP conditions.

## STOP conditions

- **Do not** start validating configs against the shipped JSON Schema at runtime. That is a new dependency, a new source of startup failure, and a separate decision; the `$schema` target is the editor, as the Run 5 note already established.
- **Do not** fix the `adapters.chat.executeKinds` schema omission here. It is real — the execute gate reads a key the schema rejects under `additionalProperties: false` — but it is the docs/schema drift item already on the books, and bundling it makes a green test ambiguous.
- **Do not** change `findConfigPath`'s upward walk or its bundled-example fallback.
- **Do not** let a wrong-shaped config degrade to defaults silently. A harness that starts up against default adapters because the operator's config is malformed is the failure this plan exists to remove.
- **Do not** add an `Adapters["chat"]`-style type widening "while you're here". Type-only changes to the config surface belong with the still-deferred `resolveTask` discriminant item.

## Acceptance

- No command emits a raw stack trace for any wrong-shaped `.herdr-harness.json`.
- A string `flags` never reaches a command line as individual characters.
- A valid config renders byte-identical `intendedCommands` and argv to before.
- 202+ tests green; `bun run typecheck` exit 0.
