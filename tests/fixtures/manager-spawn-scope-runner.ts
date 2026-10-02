import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spyOn } from "bun:test";

// Plan 028: the operator's repository and the repository a spawn record belongs
// to are two different directories, so the runner takes both. `cwd` is where the
// CLI runs; `repoA` is the checkout whose tab and worktree the fake herdr keeps
// reporting no matter who asks.
const [mode, home, cwd, repoA] = process.argv.slice(2);
const TASK = "scope-task";
const LABEL = `harness:${TASK}`;
// Repo B's worktree. Deliberately not under repoA, so the two listings can never
// match each other's rows.
const WT_B = join(dirname(home), "wt-b");

const MODES: Record<string, { record: "foreign" | "stale" | "in-repo" | "none"; args: string[] }> = {
  // Step 1: a live record owned by repo A, reached from repo B.
  "foreign-already-spawned": { record: "foreign", args: ["manager", "spawn", TASK, "--execute"] },
  "foreign-replace": { record: "foreign", args: ["manager", "spawn", TASK, "--execute", "--replace"] },
  "foreign-cleanup": { record: "foreign", args: ["manager", "cleanup", TASK, "--execute"] },
  // Step 2: no record, and a stale in-repo record. Neither may reach the label
  // arm, so repo A's tab survives a cleanup run out of repo B.
  "label-collision-no-record": { record: "none", args: ["manager", "spawn", TASK, "--execute", "--replace"] },
  "label-collision-stale": { record: "stale", args: ["manager", "cleanup", TASK, "--execute"] },
  // 018's happy path, now with a same-labelled tab in another workspace on the
  // same global listing.
  "in-repo-replace": { record: "in-repo", args: ["manager", "spawn", TASK, "--execute", "--replace"] },
};
const spec = MODES[mode];
assert(spec, `bad mode: ${mode}`);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);
const root = dirname(home);
const capture = join(root, "scope-calls.json");
const bin = join(root, "bin");
const herdr = join(bin, "fixture-herdr");
const socket = join(root, "fixture.sock");
const stateFile = join(root, "herdr-scope-state.json");
assert.equal(existsSync(capture), false);
mkdirSync(bin);
writeFileSync(capture, "[]");
writeFileSync(socket, "fixture only; not a socket\n");

// A label is unique per task but not per repository, so repo A's tab carries the
// same `harness:scope-task` label as any tab repo B would create. The in-repo
// mode adds repo B's own tab to the same global listing, which is the collision
// the unscoped label match used to resolve in repo A's favour.
const foreignTab = { tab_id: "ws-A:t1", workspace_id: "ws-A", number: 1, label: LABEL, focused: false, pane_count: 1, agent_status: "working" };
const ownTab = { tab_id: "ws-B:t1", workspace_id: "ws-B", number: 1, label: LABEL, focused: false, pane_count: 1, agent_status: "working" };
const inRepo = mode === "in-repo-replace";
writeFileSync(
  stateFile,
  JSON.stringify({
    tabs: inRepo ? [foreignTab, ownTab] : [foreignTab],
    // `repo` is fixture-only bookkeeping: `worktree list` is the one herdr call
    // the CLI scopes with --cwd, and the scope is the whole point of the plan.
    worktrees: inRepo
      ? [
          { repo: repoA, path: join(repoA, "worktree"), label: LABEL, open_workspace_id: "ws-A", is_bare: false, is_detached: false, is_prunable: true, is_linked_worktree: true },
          { repo: cwd, path: WT_B, label: LABEL, open_workspace_id: "ws-B", is_bare: false, is_detached: false, is_prunable: true, is_linked_worktree: true },
        ]
      : [
          { repo: repoA, path: join(repoA, "worktree"), label: LABEL, open_workspace_id: "ws-A", is_bare: false, is_detached: false, is_prunable: true, is_linked_worktree: true },
        ],
  }),
);

// Run only this recorder through real spawnSync, never Herdr or a worktree operation.
writeFileSync(herdr, `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const capture = ${JSON.stringify(capture)};
const stateFile = ${JSON.stringify(stateFile)};
const wtB = ${JSON.stringify(WT_B)};
const args = process.argv.slice(2);
const calls = JSON.parse(readFileSync(capture, "utf8"));
calls.push(args);
writeFileSync(capture, JSON.stringify(calls));
const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
const save = (next) => writeFileSync(stateFile, JSON.stringify(next));
const out = (result) => { console.log(JSON.stringify({ id: "fixture", result })); };
if (args.length === 1 && args[0] === "--version") {
  console.log("fixture version");
  process.exit(0);
}
const [a0, a1] = args;
if (a0 === "tab" && a1 === "list") {
  out({ type: "tab_list", tabs: state().tabs });
  process.exit(0);
}
if (a0 === "worktree" && a1 === "list") {
  const repo = args[args.indexOf("--cwd") + 1];
  out({ type: "worktree_list", source: { repo_root: repo }, worktrees: state().worktrees.filter((w) => w.repo === repo) });
  process.exit(0);
}
if (a0 === "tab" && a1 === "close") {
  const tabId = args[2];
  const now = state();
  save({ ...now, tabs: now.tabs.filter((t) => t.tab_id !== tabId) });
  out({ type: "ok" });
  process.exit(0);
}
if (a0 === "worktree" && a1 === "remove") {
  const workspaceId = args[args.indexOf("--workspace") + 1];
  const now = state();
  save({ ...now, worktrees: now.worktrees.filter((w) => w.open_workspace_id !== workspaceId) });
  out({ type: "worktree_removed", forced: args.includes("--force"), path: wtB, workspace_id: workspaceId });
  process.exit(0);
}
if (a0 === "worktree" && a1 === "create") {
  out({
    type: "worktree_created",
    workspace: { workspace_id: "w1", number: 2, label: ${JSON.stringify(LABEL)}, focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" },
    worktree: { path: wtB, label: ${JSON.stringify(LABEL)}, is_bare: false, is_detached: false, is_prunable: true, is_linked_worktree: true },
    tab: { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: ${JSON.stringify(LABEL)}, focused: false, pane_count: 1, agent_status: "idle" },
    root_pane: { pane_id: "w1:t1:p1", terminal_id: "term-1", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "idle", revision: 1 },
  });
  process.exit(0);
}
if (a0 === "tab" && a1 === "create") {
  out({
    type: "tab_created",
    tab: { tab_id: "w1:t2", workspace_id: "w1", number: 2, label: ${JSON.stringify(LABEL)}, focused: false, pane_count: 1, agent_status: "idle" },
    root_pane: { pane_id: "w1:t2:p1", terminal_id: "term-2", workspace_id: "w1", tab_id: "w1:t2", focused: false, agent_status: "idle", revision: 2 },
  });
  process.exit(0);
}
if (a0 === "agent" && a1 === "start") {
  out({ type: "agent_started", agent: { pane_id: "w1:t2:p1", terminal_id: "term-2", workspace_id: "w1", tab_id: "w1:t2", name: args[2], focused: false, agent_status: "working", revision: 2 }, argv: ["fixture-agent"] });
  process.exit(0);
}
if (a0 === "pane" && a1 === "run") {
  out({ type: "ok" });
  process.exit(0);
}
console.error("unexpected fixture-herdr args: " + args.join(" "));
process.exit(2);
`, { mode: 0o755 });
process.env.HERDR_BIN_PATH = herdr;
process.env.HERDR_SOCKET = socket;
// No system executables are reachable through PATH.
process.env.PATH = bin;
function unexpected(name: string): never {
  throw new Error(`Unexpected side effect: ${name}`);
}
spyOn(Bun, "serve").mockImplementation(() => unexpected("Bun.serve"));
spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(() => unexpected("fetch"), { preconnect: () => unexpected("fetch") }),
);
const { STATE_DIR } = await import("../../src/shared.ts");
assert.equal(STATE_DIR, join(home, ".local", "state", "herdr-harness"));
// The record is the whole hazard: one global spawns.json, keyed by a bare task
// id, with nothing about which checkout wrote it except this `cwd`.
const RECORDS: Record<string, Record<string, unknown> | null> = {
  foreign: {
    taskId: TASK,
    adapterId: "fixture-adapter",
    agentName: LABEL,
    worktreePath: join(repoA, "worktree"),
    workspaceId: "ws-A",
    tabId: "ws-A:t1",
    paneId: "ws-A:t1:p1",
    cwd: repoA,
    at: "2026-01-01T00:00:00.000Z",
  },
  // Belongs to this repo but points at a workspace that is long gone — the stale
  // shape from the plan, where the label arm fires on someone else's tab.
  stale: {
    taskId: TASK,
    adapterId: "fixture-adapter",
    agentName: LABEL,
    worktreePath: join(cwd, "wt-OLD"),
    workspaceId: "ws-OLD",
    tabId: "ws-OLD:t9",
    paneId: "ws-OLD:t9:p1",
    cwd,
    at: "2026-01-01T00:00:00.000Z",
  },
  "in-repo": {
    taskId: TASK,
    adapterId: "fixture-adapter",
    agentName: LABEL,
    worktreePath: WT_B,
    workspaceId: "ws-B",
    tabId: "ws-B:t1",
    paneId: "ws-B:t1:p1",
    cwd,
    at: "2026-01-01T00:00:00.000Z",
  },
  none: null,
};
const record = RECORDS[spec.record];
if (record) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, "spawns.json"), `${JSON.stringify({ spawns: { [TASK]: record } }, null, 2)}\n`);
}
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
process.argv = [process.execPath, cli, ...spec.args];
await import(cli);
