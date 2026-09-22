import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const RUNNER = new URL("./fixtures/manager-spawn-runner.ts", import.meta.url).href;
let fixture: ReturnType<typeof createFixture>;

function spawnsFile() {
  return join(fixture.home, ".local", "state", "herdr-harness", "spawns.json");
}

function readSpawns() {
  return JSON.parse(readFileSync(spawnsFile(), "utf8")).spawns;
}

function worktreeArgs() {
  return ["worktree", "create", "--cwd", fixture.cwd, "--branch", "fixture-branch",
    "--base", "fixture-base", "--path", join(fixture.root, "worktree"), "--label", "fixture-label", "--no-focus"];
}

function tabArgs(workspace = "<workspace-id>") {
  return ["tab", "create", "--workspace", workspace, "--cwd", join(fixture.root, "worktree"),
    "--label", "harness:fixture-task", "--no-focus"];
}

// Route kind "grok" is a supported herdr agent kind, so the agent step is `agent start`.
function agentArgs(pane = "<pane-id>") {
  return ["agent", "start", "harness:fixture-task", "--kind", "grok", "--pane", pane,
    "--", "--model", "grok-build", "--verbose"];
}

function run(mode: string) {
  fixture.assertIsolation();
  const child = fixture.runCode(`
    process.argv = [process.execPath, ${JSON.stringify(RUNNER)}, ${JSON.stringify(mode)},
      ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}];
    await import(${JSON.stringify(RUNNER)});
  `);
  expect(child.stderr).toBe("");
  const json = JSON.parse(child.stdout);
  const calls = JSON.parse(readFileSync(join(fixture.root, "manager-calls.json"), "utf8"));
  expect(existsSync(join(fixture.root, "worktree"))).toBe(false);
  return { ...child, json, calls };
}

beforeEach(() => {
  fixture = createFixture();
  writeFileSync(join(fixture.cwd, ".herdr-harness.json"), JSON.stringify({
    adapters: {
      default: "fixture-adapter",
      routes: {
        "fixture-adapter": { kind: "grok", model: "grok-build", flags: ["--verbose"] },
        anyr: { kind: "anyr", via: "claude" },
      },
    },
    tasks: [
      { id: "fixture-task", worktree: {
        branch: "fixture-branch", base: "fixture-base", path: join(fixture.root, "worktree"), label: "fixture-label",
      } },
      { id: "anyr-task", adapter: "anyr" },
    ],
  }));
});

afterEach(() => {
  fixture?.cleanup();
});

describe("manager spawn child tab/agent", () => {
  test("dry-run shows the full worktree + tab + agent plan", () => {
    const result = run("dry-run");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "dry-run" });
    expect(result.json.intendedCommands).toEqual([
      ["herdr", ...worktreeArgs()],
      ["herdr", ...tabArgs()],
      ["herdr", ...agentArgs()],
    ]);
    expect(result.calls).toEqual([["--version"]]);
  });

  test("executed spawn runs worktree, tab create and agent start in order", () => {
    const result = run("success");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed" });
    expect(result.calls).toEqual([
      ["--version"],
      worktreeArgs(),
      tabArgs("w1"),
      agentArgs("w1:t2:p1"),
    ]);
    expect(result.json.agent).toMatchObject({ launch: "agent-start", kind: "grok" });
    expect(result.json.spawn).toMatchObject({
      taskId: "fixture-task",
      workspaceId: "w1",
      worktreePath: join(fixture.root, "worktree"),
      tabId: "w1:t2",
      paneId: "w1:t2:p1",
      agentName: "harness:fixture-task",
    });
    expect(readSpawns()["fixture-task"]).toMatchObject({
      workspaceId: "w1",
      tabId: "w1:t2",
      paneId: "w1:t2:p1",
    });
  });

  test("adapter without a herdr kind falls back to pane run", () => {
    const result = run("anyr");
    expect(result.exit).toBe(0);
    expect(result.json.ok).toBe(true);
    // anyr route is { kind: "anyr", via: "claude" } → `anyr claude` in the pane.
    expect(result.calls[3]).toEqual(["pane", "run", "w1:t2:p1", "anyr", "claude"]);
    expect(result.json.agent).toMatchObject({ launch: "shell", command: ["anyr", "claude"] });
  });

  test("tab create failure yields ok:false, exit 1 and a partial spawn record", () => {
    const result = run("fail-tab");
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.mode).toBe("executed");
    expect(result.json.error).toBe("herdr tab create failed");
    expect(result.json.results).toHaveLength(2);
    expect(result.calls).toEqual([["--version"], worktreeArgs(), tabArgs("w1")]);
    // Partial progress is persisted so cleanup can find the worktree.
    expect(readSpawns()["fixture-task"]).toMatchObject({ workspaceId: "w1", tabId: "w1:t1" });
  });

  test("agent start failure yields ok:false and exit 1 after earlier steps", () => {
    const result = run("fail-agent");
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.error).toBe("herdr agent start failed");
    expect(result.json.results).toHaveLength(3);
    expect(readSpawns()["fixture-task"]).toMatchObject({ tabId: "w1:t2", paneId: "w1:t2:p1" });
  });

  test("existing worktree failure points at --replace/--cleanup", () => {
    const result = run("exists");
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.error).toBe("herdr worktree create failed");
    expect(result.json.hint).toContain("--replace");
    expect(result.json.hint).toContain("cleanup");
    expect(result.calls).toEqual([["--version"], worktreeArgs()]);
  });

  test("recorded spawn refuses a second spawn without --replace", () => {
    const result = run("pre-spawned");
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.error).toBe("task already spawned: fixture-task");
    expect(result.json.spawn).toMatchObject({ workspaceId: "w9", tabId: "w9:t9" });
    expect(result.json.hint).toContain("--replace");
    expect(result.calls).toEqual([["--version"]]);
  });
});

describe("manager cleanup / replace", () => {
  test("cleanup closes the spawned tab then removes the worktree", () => {
    const result = run("cleanup");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed", taskId: "fixture-task" });
    expect(result.calls).toEqual([
      ["--version"],
      ["tab", "list"],
      ["worktree", "list", "--cwd", fixture.cwd],
      ["tab", "close", "w9:t9"],
      ["worktree", "remove", "--workspace", "w9"],
    ]);
    expect(result.json.cleanup).toMatchObject({
      ok: true,
      closedTabs: ["w9:t9"],
      removedWorkspace: "w9",
      cleaned: true,
    });
    expect(result.json.previousSpawn).toMatchObject({ workspaceId: "w9" });
    expect(readSpawns()["fixture-task"]).toBeUndefined();
  });

  test("cleanup --force forwards --force to worktree remove", () => {
    const result = run("cleanup-force");
    expect(result.exit).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(result.calls.at(-1)).toEqual(["worktree", "remove", "--workspace", "w9", "--force"]);
  });

  test("cleanup with nothing live or recorded is a safe no-op", () => {
    const result = run("cleanup-none");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed" });
    expect(result.json.cleanup.cleaned).toBe(false);
    expect(result.json.cleanup.closedTabs).toEqual([]);
    expect(result.json.cleanup.removedWorkspace).toBeNull();
    expect(result.calls).toEqual([
      ["--version"],
      ["tab", "list"],
      ["worktree", "list", "--cwd", fixture.cwd],
    ]);
  });

  test("cleanup dry-run shows the plan without executing", () => {
    const result = run("cleanup-dry");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "dry-run", taskId: "fixture-task" });
    expect(result.json.cleanup.intendedCommands).toEqual([
      ["herdr", "tab", "list"],
      ["herdr", "worktree", "list", "--cwd", fixture.cwd],
      ["herdr", "tab", "close", "w9:t9"],
      ["herdr", "worktree", "remove", "--workspace", "w9"],
    ]);
    expect(result.json.previousSpawn).toMatchObject({ workspaceId: "w9" });
    expect(result.calls).toEqual([["--version"]]);
    expect(readSpawns()["fixture-task"]).toMatchObject({ workspaceId: "w9" });
  });

  test("spawn --cleanup is an alias for manager cleanup", () => {
    const result = run("spawn-cleanup-flag");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed", taskId: "fixture-task" });
    expect(result.json.cleanup.cleaned).toBe(true);
    expect(result.calls).toContainEqual(["worktree", "remove", "--workspace", "w9"]);
  });

  test("--replace cleans up the old spawn then runs the full sequence", () => {
    const result = run("replace");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed", replace: true });
    expect(result.calls).toEqual([
      ["--version"],
      ["tab", "list"],
      ["worktree", "list", "--cwd", fixture.cwd],
      ["tab", "close", "w9:t9"],
      ["worktree", "remove", "--workspace", "w9"],
      worktreeArgs(),
      tabArgs("w1"),
      agentArgs("w1:t2:p1"),
    ]);
    expect(result.json.cleanup).toMatchObject({ ok: true, removedWorkspace: "w9" });
    // The record now tracks the replacement spawn, not the old one.
    expect(readSpawns()["fixture-task"]).toMatchObject({
      workspaceId: "w1",
      tabId: "w1:t2",
      paneId: "w1:t2:p1",
    });
  });
});
