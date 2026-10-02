import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spyOn } from "bun:test";

const [mode, home, cwd, timeoutEnv] = process.argv.slice(2);
const MODES = new Set([
  "success",
  "nonzero",
  "null",
  "dry-run",
  "unavailable",
  "unknown",
  "fail-tab",
  "fail-agent",
  "exists",
  "pre-spawned",
  "replace",
  "cleanup",
  "cleanup-dry",
  "cleanup-force",
  "cleanup-none",
  "spawn-cleanup-flag",
  // Plan 018: cleanup is idempotent, so the fixture's herdr has to be able to
  // disagree with itself — report a tab on `tab list` and then fail `tab close`
  // for it, exactly as a real one does when the user closed it in between.
  "cleanup-closed-tab",
  "cleanup-close-denied",
  "cleanup-relist-unreadable",
  "cleanup-discovery-fail",
  "replace-closed-tab",
  "anyr",
  // Plan 013: wedged-herdr modes. Each records its pid, then never returns, so
  // only the harness timeout can free the CLI.
  "hang-version",
  "hang-worktree",
  "hang-tab",
  "hang-cleanup",
]);
assert(MODES.has(mode), `bad mode: ${mode}`);
// Modes whose herdr starts out owning the seeded `w9` tab and worktree.
const POPULATED_MODES = [
  "cleanup",
  "cleanup-dry",
  "cleanup-force",
  "replace",
  "spawn-cleanup-flag",
  "cleanup-closed-tab",
  "cleanup-close-denied",
  "cleanup-relist-unreadable",
  "cleanup-discovery-fail",
  "replace-closed-tab",
];
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);
const root = dirname(home);
const capture = join(root, "manager-calls.json");
const bin = join(root, "bin");
const herdr = join(bin, "fixture-herdr");
const pidFile = join(root, "herdr-pid.txt");
const socket = join(root, "fixture.sock");
const wtPath = join(root, "worktree");
const label = "harness:fixture-task";
const state = join(root, "herdr-state.json");
assert.equal(existsSync(capture), false);
mkdirSync(bin);
writeFileSync(capture, "[]");
writeFileSync(socket, "fixture only; not a socket\n");
// Plan 018: what the fixture herdr reports is state, not a constant, so a
// mutation can actually change what the next `list` says. Without this the
// cleanup re-list would always still show the tab and the idempotence fix
// would be untestable. Seeded to exactly the rows the static branches below
// used to emit, so every pre-existing mode sees the same listings as before.
writeFileSync(
  state,
  JSON.stringify({
    tabs: POPULATED_MODES.includes(mode)
      ? [{ tab_id: "w9:t9", workspace_id: "w9", number: 1, label, focused: false, pane_count: 1, agent_status: "working" }]
      : [],
    worktrees: POPULATED_MODES.includes(mode)
      ? [{ path: wtPath, label, open_workspace_id: "w9", is_bare: false, is_detached: false, is_prunable: true, is_linked_worktree: true }]
      : [],
  }),
);
// Run only this recorder through real spawnSync, never Herdr or a worktree operation.
writeFileSync(herdr, `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const capture = ${JSON.stringify(capture)};
const pidFile = ${JSON.stringify(pidFile)};
const stateFile = ${JSON.stringify(state)};
const args = process.argv.slice(2);
const calls = JSON.parse(readFileSync(capture, "utf8"));
calls.push(args);
writeFileSync(capture, JSON.stringify(calls));
const mode = ${JSON.stringify(mode)};
const wtPath = ${JSON.stringify(wtPath)};
const label = ${JSON.stringify(label)};
const cwd = ${JSON.stringify(cwd)};
const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
const save = (next) => writeFileSync(stateFile, JSON.stringify(next));
const listed = (a, b) => calls.filter((c) => c[0] === a && c[1] === b).length;
const out = (result) => { console.log(JSON.stringify({ id: "fixture", result })); };
const fail = () => { console.log("fixture stdout"); console.error("fixture stderr"); process.exit(7); };
// Records this pid so the test can assert the timed-out child is really gone,
// then never returns. Only the hang modes below ever call it.
const hang = async () => {
  writeFileSync(pidFile, String(process.pid));
  await new Promise(() => {});
};
if (args.length === 1 && args[0] === "--version") {
  if (mode === "hang-version") await hang();
  console.log("fixture version");
  process.exit(mode === "unavailable" ? 1 : 0);
}
const [a0, a1] = args;
if (a0 === "worktree" && a1 === "create") {
  if (mode === "null") { console.log("fixture stdout"); console.error("fixture stderr"); process.kill(process.pid, "SIGTERM"); }
  if (mode === "nonzero") fail();
  if (mode === "exists") { console.error("error: worktree already exists"); process.exit(3); }
  if (mode === "hang-worktree") await hang();
  out({
    type: "worktree_created",
    workspace: { workspace_id: "w1", number: 2, label, focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" },
    worktree: { path: wtPath, label, is_bare: false, is_detached: false, is_prunable: true, is_linked_worktree: true },
    tab: { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "1", focused: false, pane_count: 1, agent_status: "idle" },
    root_pane: { pane_id: "w1:t1:p1", terminal_id: "term-1", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "idle", revision: 1 },
  });
  process.exit(0);
}
if (a0 === "tab" && a1 === "create") {
  if (mode === "fail-tab") fail();
  if (mode === "hang-tab") await hang();
  out({
    type: "tab_created",
    tab: { tab_id: "w1:t2", workspace_id: "w1", number: 2, label, focused: false, pane_count: 1, agent_status: "idle" },
    root_pane: { pane_id: "w1:t2:p1", terminal_id: "term-2", workspace_id: "w1", tab_id: "w1:t2", focused: false, agent_status: "idle", revision: 1 },
  });
  process.exit(0);
}
if (a0 === "agent" && a1 === "start") {
  if (mode === "fail-agent") fail();
  out({ type: "agent_started", agent: { pane_id: "w1:t2:p1", terminal_id: "term-2", workspace_id: "w1", tab_id: "w1:t2", name: args[2], focused: false, agent_status: "working", revision: 2 }, argv: ["fixture-agent"] });
  process.exit(0);
}
if (a0 === "pane" && a1 === "run") {
  if (mode === "fail-agent") fail();
  out({ type: "ok" });
  process.exit(0);
}
if (a0 === "tab" && a1 === "list") {
  if (mode === "hang-cleanup") await hang();
  if (mode === "cleanup-discovery-fail") fail();
  // Plan 018: the post-mutation re-list exits 0 but prints something that is
  // not the list envelope, so cleanup cannot confirm the tab is gone.
  if (mode === "cleanup-relist-unreadable" && listed("tab", "list") > 1) {
    console.log("herdr: nothing to report");
    process.exit(0);
  }
  out({ type: "tab_list", tabs: state().tabs });
  process.exit(0);
}
if (a0 === "worktree" && a1 === "list") {
  out({
    type: "worktree_list",
    source: { repo_root: cwd },
    worktrees: state().worktrees,
  });
  process.exit(0);
}
if (a0 === "tab" && a1 === "close") {
  const tabId = args[2];
  // A denial leaves the tab exactly where it was: the close failed and the
  // re-list must still see it, which is what keeps the cleanup from reporting
  // success.
  if (mode === "cleanup-close-denied") {
    console.error("herdr: permission denied closing " + tabId);
    process.exit(9);
  }
  // Otherwise the tab is absent from the next listing whether or not the close
  // itself succeeded — the already-closed modes model the user having closed it
  // in between the list and the close.
  const now = state();
  save({ ...now, tabs: now.tabs.filter((t) => t.tab_id !== tabId) });
  if (["cleanup-closed-tab", "replace-closed-tab", "cleanup-relist-unreadable"].includes(mode)) {
    console.error("herdr: no such tab " + tabId);
    process.exit(9);
  }
  out({ type: "ok" });
  process.exit(0);
}
if (a0 === "worktree" && a1 === "remove") {
  const workspaceId = args[args.indexOf("--workspace") + 1];
  const now = state();
  save({ ...now, worktrees: now.worktrees.filter((w) => w.open_workspace_id !== workspaceId) });
  out({ type: "worktree_removed", forced: args.includes("--force"), path: wtPath, workspace_id: workspaceId });
  process.exit(0);
}
console.error("unexpected fixture-herdr args: " + args.join(" "));
process.exit(2);
`, { mode: 0o755 });
process.env.HERDR_BIN_PATH = herdr;
process.env.HERDR_SOCKET = socket;
// Plan 013: seeds HARNESS_HERDR_TIMEOUT_MS; empty means "leave it unset".
if (timeoutEnv) process.env.HARNESS_HERDR_TIMEOUT_MS = timeoutEnv;
// No system executables are reachable through PATH, including a background gateway's bun.
process.env.PATH = bin;
function unexpected(name: string): never {
  throw new Error(`Unexpected side effect: ${name}`);
}
spyOn(Bun, "serve").mockImplementation(() => unexpected("Bun.serve"));
spyOn(globalThis, "fetch").mockImplementation(() => unexpected("fetch"));
const { STATE_DIR } = await import("../../src/shared.ts");
assert.equal(STATE_DIR, join(home, ".local", "state", "herdr-harness"));
const SEEDED = new Set(["pre-spawned", "replace", "cleanup", "cleanup-dry", "cleanup-force", "spawn-cleanup-flag", "hang-cleanup", "cleanup-closed-tab", "cleanup-close-denied", "cleanup-relist-unreadable", "cleanup-discovery-fail", "replace-closed-tab"]);
if (SEEDED.has(mode)) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    join(STATE_DIR, "spawns.json"),
    `${JSON.stringify(
      {
        spawns: {
          "fixture-task": {
            taskId: "fixture-task",
            adapterId: "fixture-adapter",
            agentName: label,
            worktreePath: wtPath,
            workspaceId: "w9",
            tabId: "w9:t9",
            paneId: "w9:t9:p1",
            cwd,
            at: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const taskId = mode === "unknown" ? "unknown-task" : mode === "anyr" ? "anyr-task" : "fixture-task";
const cliArgs = (() => {
  switch (mode) {
    case "dry-run":
      return ["manager", "spawn", taskId];
    case "cleanup":
    case "cleanup-none":
    case "cleanup-closed-tab":
    case "cleanup-close-denied":
    case "cleanup-relist-unreadable":
    case "cleanup-discovery-fail":
    case "hang-cleanup":
      return ["manager", "cleanup", taskId, "--execute"];
    case "cleanup-dry":
      return ["manager", "cleanup", taskId];
    case "cleanup-force":
      return ["manager", "cleanup", taskId, "--execute", "--force"];
    case "replace":
    case "replace-closed-tab":
      return ["manager", "spawn", taskId, "--execute", "--replace"];
    case "spawn-cleanup-flag":
      return ["manager", "spawn", taskId, "--cleanup", "--execute"];
    default:
      return ["manager", "spawn", taskId, "--execute"];
  }
})();
process.argv = [process.execPath, cli, ...cliArgs];
await import(cli);
