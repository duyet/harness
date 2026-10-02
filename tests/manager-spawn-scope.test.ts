import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

// Plan 028: spawns.json is one global file keyed by a bare taskId, and the
// cleanup tab match was a global label match. Two checkouts that both define
// `scope-task` therefore collided, and `manager spawn scope-task --replace` run
// from the wrong one tore down the right one's worktree while reporting ok.
//
// Every case runs the CLI with its cwd in repo B while the fake herdr reports
// repo A's tab and worktree.
const RUNNER = new URL("./fixtures/manager-spawn-scope-runner.ts", import.meta.url).href;
let fixture: ReturnType<typeof createFixture>;
let repoA: string;

function calls(): string[][] {
  return JSON.parse(readFileSync(join(fixture.root, "scope-calls.json"), "utf8"));
}

function herdrState() {
  return JSON.parse(readFileSync(join(fixture.root, "herdr-scope-state.json"), "utf8"));
}

function readSpawns(): Record<string, any> {
  return JSON.parse(readFileSync(join(fixture.home, ".local", "state", "herdr-harness", "spawns.json"), "utf8")).spawns;
}

function openTabIds(): string[] {
  return herdrState().tabs.map((t: any) => t.tab_id);
}

function openWorkspaceIds(): string[] {
  return herdrState().worktrees.map((w: any) => w.open_workspace_id);
}

function worktreeArgs() {
  return ["worktree", "create", "--cwd", fixture.cwd, "--branch", "fixture-branch",
    "--base", "fixture-base", "--path", join(fixture.root, "wt-b"), "--label", "harness:scope-task", "--no-focus"];
}

function tabArgs(workspace = "<workspace-id>") {
  return ["tab", "create", "--workspace", workspace, "--cwd", join(fixture.root, "wt-b"),
    "--label", "harness:scope-task", "--no-focus"];
}

function agentArgs(pane = "<pane-id>") {
  return ["agent", "start", "harness:scope-task", "--kind", "grok", "--pane", pane,
    "--", "--model", "grok-build", "--verbose"];
}

function run(mode: string) {
  fixture.assertIsolation();
  const child = fixture.runCode(`
    process.argv = [process.execPath, ${JSON.stringify(RUNNER)}, ${JSON.stringify(mode)},
      ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}, ${JSON.stringify(repoA)}];
    await import(${JSON.stringify(RUNNER)});
  `);
  expect(child.stderr).toBe("");
  return { ...child, json: JSON.parse(child.stdout) };
}

beforeEach(() => {
  fixture = createFixture();
  // Two sibling checkouts under the fixture root. The CLI only ever sees repo B
  // as its cwd; repo A exists to be somebody else's worktree.
  repoA = join(fixture.root, "repoA");
  mkdirSync(repoA, { recursive: true });
  writeFileSync(join(fixture.cwd, ".herdr-harness.json"), JSON.stringify({
    adapters: {
      default: "fixture-adapter",
      routes: { "fixture-adapter": { kind: "grok", model: "grok-build", flags: ["--verbose"] } },
    },
    tasks: [{ id: "scope-task", worktree: {
      branch: "fixture-branch", base: "fixture-base", path: join(fixture.root, "wt-b"), label: "harness:scope-task",
    } }],
  }));
});

afterEach(() => {
  fixture?.cleanup();
});

describe("a record from another repository is refused before any herdr call", () => {
  // The gate sits ahead of the liveness probe, not after it: the probe is itself
  // a herdr subprocess, and an empty call list is the proof that nothing ran.
  test("--replace refuses instead of closing repo A's tab and removing its worktree", () => {
    const result = run("foreign-replace");
    expect(result.exit).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      mode: "executed",
      taskId: "scope-task",
      error: "refusing to clean up a spawn recorded in another repository",
      recordCwd: repoA,
      cwd: fixture.cwd,
    });
    // Both paths are in the envelope, and the hint says which tree to re-run in.
    expect(result.json.hint).toContain(repoA);
    expect(result.json.hint).toContain("harness manager cleanup scope-task --execute");
    // Not even `herdr --version` ran.
    expect(calls()).toEqual([]);
    expect(openTabIds()).toEqual(["ws-A:t1"]);
    expect(openWorkspaceIds()).toEqual(["ws-A"]);
    expect(readSpawns()["scope-task"]).toMatchObject({ workspaceId: "ws-A", cwd: repoA });
  });

  test("--cleanup refuses the same way", () => {
    const result = run("foreign-cleanup");
    expect(result.exit).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      error: "refusing to clean up a spawn recorded in another repository",
      recordCwd: repoA,
      cwd: fixture.cwd,
    });
    expect(calls()).toEqual([]);
    expect(openTabIds()).toEqual(["ws-A:t1"]);
    expect(openWorkspaceIds()).toEqual(["ws-A"]);
  });

  // Without --replace the record is inert: refusing to spawn is the right
  // answer, and the envelope is the pre-existing "already spawned" one.
  test("spawn without --replace still refuses with the already-spawned error", () => {
    const result = run("foreign-already-spawned");
    expect(result.exit).toBe(1);
    expect(result.json).toMatchObject({ ok: false, error: "task already spawned: scope-task" });
    expect(result.json.spawn).toMatchObject({ cwd: repoA, workspaceId: "ws-A" });
    expect(calls()).toEqual([["--version"]]);
    expect(openTabIds()).toEqual(["ws-A:t1"]);
  });
});

describe("the label arm cannot reach across workspaces", () => {
  // `harness:<taskId>` names a task, not a checkout. With no record there is no
  // workspace to scope the match to, so the label matches nothing.
  test("no record: a same-labelled tab in another workspace survives --replace", () => {
    const result = run("label-collision-no-record");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed", replace: true });
    expect(result.json.cleanup).toMatchObject({ ok: true, found: { tabs: [], workspaceId: null }, closedTabs: [], cleaned: false });
    expect(calls()).not.toContainEqual(expect.arrayContaining(["tab", "close"]));
    expect(openTabIds()).toEqual(["ws-A:t1"]);
    // Cleanup was a no-op, so the re-spawn is what ran.
    expect(calls()).toEqual([
      ["--version"],
      ["tab", "list"],
      ["worktree", "list", "--cwd", fixture.cwd],
      worktreeArgs(),
      tabArgs("w1"),
      agentArgs("w1:t2:p1"),
    ]);
    // The record now points at this repo, so a later cleanup is in-repo.
    expect(readSpawns()["scope-task"]).toMatchObject({ cwd: fixture.cwd, workspaceId: "w1" });
  });

  // A stale in-repo record still has a workspace id, so the label arm fires —
  // but only inside that workspace, which repo A's tab is not in.
  test("a stale in-repo record does not close another workspace's tab", () => {
    const result = run("label-collision-stale");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed" });
    expect(result.json.cleanup).toMatchObject({ ok: true, found: { tabs: [], workspaceId: "ws-OLD" } });
    expect(result.json.cleanup.closedTabs).toEqual([]);
    expect(calls()).not.toContainEqual(expect.arrayContaining(["tab", "close"]));
    expect(openTabIds()).toEqual(["ws-A:t1"]);
    // The stale record is still ours to clear, and it is not repo A's tab.
    expect(calls()).toContainEqual(["worktree", "remove", "--workspace", "ws-OLD"]);
    expect(openWorkspaceIds()).toEqual(["ws-A"]);
  });
});

describe("018's in-repo happy path is unchanged", () => {
  // Same global listing, two same-labelled tabs, one of them ours. Only ours is
  // closed; the collision is the regression this plan exists to prevent.
  test("--replace closes its own tab and removes its own worktree, not the neighbour's", () => {
    const result = run("in-repo-replace");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed", replace: true });
    expect(result.json.cleanup).toMatchObject({
      ok: true,
      found: { tabs: ["ws-B:t1"], workspaceId: "ws-B" },
      closedTabs: ["ws-B:t1"],
      removedWorkspace: "ws-B",
      cleaned: true,
    });
    expect(calls()).toEqual([
      ["--version"],
      ["tab", "list"],
      ["worktree", "list", "--cwd", fixture.cwd],
      ["tab", "close", "ws-B:t1"],
      ["worktree", "remove", "--workspace", "ws-B"],
      worktreeArgs(),
      tabArgs("w1"),
      agentArgs("w1:t2:p1"),
    ]);
    // Repo A's tab and worktree are exactly as they were.
    expect(openTabIds()).toEqual(["ws-A:t1"]);
    expect(openWorkspaceIds()).toEqual(["ws-A"]);
    expect(readSpawns()["scope-task"]).toMatchObject({ workspaceId: "w1", tabId: "w1:t2", paneId: "w1:t2:p1" });
  });
});
