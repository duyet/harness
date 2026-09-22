import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spyOn } from "bun:test";

const [mode, home, cwd] = process.argv.slice(2);
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
  "anyr",
]);
assert(MODES.has(mode), `bad mode: ${mode}`);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);
const root = dirname(home);
const capture = join(root, "manager-calls.json");
const bin = join(root, "bin");
const herdr = join(bin, "fixture-herdr");
const socket = join(root, "fixture.sock");
const wtPath = join(root, "worktree");
const label = "harness:fixture-task";
assert.equal(existsSync(capture), false);
mkdirSync(bin);
writeFileSync(capture, "[]");
writeFileSync(socket, "fixture only; not a socket\n");
// Run only this recorder through real spawnSync, never Herdr or a worktree operation.
writeFileSync(herdr, `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const capture = ${JSON.stringify(capture)};
const args = process.argv.slice(2);
const calls = JSON.parse(readFileSync(capture, "utf8"));
calls.push(args);
writeFileSync(capture, JSON.stringify(calls));
const mode = ${JSON.stringify(mode)};
const wtPath = ${JSON.stringify(wtPath)};
const label = ${JSON.stringify(label)};
const cwd = ${JSON.stringify(cwd)};
const out = (result) => { console.log(JSON.stringify({ id: "fixture", result })); };
const fail = () => { console.log("fixture stdout"); console.error("fixture stderr"); process.exit(7); };
const populated = ["cleanup", "cleanup-dry", "cleanup-force", "replace", "spawn-cleanup-flag"].includes(mode);
if (args.length === 1 && args[0] === "--version") {
  console.log("fixture version");
  process.exit(mode === "unavailable" ? 1 : 0);
}
const [a0, a1] = args;
if (a0 === "worktree" && a1 === "create") {
  if (mode === "null") { console.log("fixture stdout"); console.error("fixture stderr"); process.kill(process.pid, "SIGTERM"); }
  if (mode === "nonzero") fail();
  if (mode === "exists") { console.error("error: worktree already exists"); process.exit(3); }
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
  out({
    type: "tab_list",
    tabs: populated
      ? [{ tab_id: "w9:t9", workspace_id: "w9", number: 1, label, focused: false, pane_count: 1, agent_status: "working" }]
      : [],
  });
  process.exit(0);
}
if (a0 === "worktree" && a1 === "list") {
  out({
    type: "worktree_list",
    source: { repo_root: cwd },
    worktrees: populated
      ? [{ path: wtPath, label, open_workspace_id: "w9", is_bare: false, is_detached: false, is_prunable: true, is_linked_worktree: true }]
      : [],
  });
  process.exit(0);
}
if (a0 === "tab" && a1 === "close") { out({ type: "ok" }); process.exit(0); }
if (a0 === "worktree" && a1 === "remove") {
  out({ type: "worktree_removed", forced: args.includes("--force"), path: wtPath, workspace_id: "w9" });
  process.exit(0);
}
console.error("unexpected fixture-herdr args: " + args.join(" "));
process.exit(2);
`, { mode: 0o755 });
process.env.HERDR_BIN_PATH = herdr;
process.env.HERDR_SOCKET = socket;
// No system executables are reachable through PATH, including a background gateway's bun.
process.env.PATH = bin;
function unexpected(name: string): never {
  throw new Error(`Unexpected side effect: ${name}`);
}
spyOn(Bun, "serve").mockImplementation(() => unexpected("Bun.serve"));
spyOn(globalThis, "fetch").mockImplementation(() => unexpected("fetch"));
const { STATE_DIR } = await import("../../src/shared.ts");
assert.equal(STATE_DIR, join(home, ".local", "state", "herdr-harness"));
const SEEDED = new Set(["pre-spawned", "replace", "cleanup", "cleanup-dry", "cleanup-force", "spawn-cleanup-flag"]);
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
      return ["manager", "cleanup", taskId, "--execute"];
    case "cleanup-dry":
      return ["manager", "cleanup", taskId];
    case "cleanup-force":
      return ["manager", "cleanup", taskId, "--execute", "--force"];
    case "replace":
      return ["manager", "spawn", taskId, "--execute", "--replace"];
    case "spawn-cleanup-flag":
      return ["manager", "spawn", taskId, "--cleanup", "--execute"];
    default:
      return ["manager", "spawn", taskId, "--execute"];
  }
})();
process.argv = [process.execPath, cli, ...cliArgs];
await import(cli);
