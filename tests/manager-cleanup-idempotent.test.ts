import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const RUNNER = new URL("./fixtures/manager-spawn-runner.ts", import.meta.url).href;
let fixture: ReturnType<typeof createFixture>;

function readSpawns() {
  return JSON.parse(readFileSync(join(fixture.home, ".local", "state", "herdr-harness", "spawns.json"), "utf8")).spawns;
}

function calls(): string[][] {
  return JSON.parse(readFileSync(join(fixture.root, "manager-calls.json"), "utf8"));
}

function worktreeArgs() {
  return ["worktree", "create", "--cwd", fixture.cwd, "--branch", "fixture-branch",
    "--base", "fixture-base", "--path", join(fixture.root, "worktree"), "--label", "fixture-label", "--no-focus"];
}

function tabArgs(workspace = "<workspace-id>") {
  return ["tab", "create", "--workspace", workspace, "--cwd", join(fixture.root, "worktree"),
    "--label", "harness:fixture-task", "--no-focus"];
}

function agentArgs(pane = "<pane-id>") {
  return ["agent", "start", "harness:fixture-task", "--kind", "grok", "--pane", pane,
    "--", "--model", "grok-build", "--verbose"];
}

// The seeded record the runner writes before the CLI runs. Its `at` stamp is
// never rewritten, so matching on it proves cleanup left the record untouched
// rather than rewriting an equivalent one.
const SEEDED = {
  taskId: "fixture-task",
  workspaceId: "w9",
  tabId: "w9:t9",
  paneId: "w9:t9:p1",
  at: "2026-01-01T00:00:00.000Z",
};

function statuses(json: { cleanup: { results: { status: number | null }[] } }) {
  return json.cleanup.results.map((r) => r.status);
}

function run(mode: string) {
  fixture.assertIsolation();
  const child = fixture.runCode(`
    process.argv = [process.execPath, ${JSON.stringify(RUNNER)}, ${JSON.stringify(mode)},
      ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}];
    await import(${JSON.stringify(RUNNER)});
  `);
  expect(child.stderr).toBe("");
  return { ...child, json: JSON.parse(child.stdout) };
}

beforeEach(() => {
  fixture = createFixture();
  writeFileSync(join(fixture.cwd, ".herdr-harness.json"), JSON.stringify({
    adapters: {
      default: "fixture-adapter",
      routes: { "fixture-adapter": { kind: "grok", model: "grok-build", flags: ["--verbose"] } },
    },
    tasks: [{ id: "fixture-task", worktree: {
      branch: "fixture-branch", base: "fixture-base", path: join(fixture.root, "worktree"), label: "fixture-label",
    } }],
  }));
});

afterEach(() => {
  fixture?.cleanup();
});

describe("cleanup is idempotent: a close that failed only because the tab was already gone", () => {
  // The wedge this plan exists to remove. Discovery sees the tab, `tab close`
  // then exits nonzero because the user closed it in between — but the re-list
  // proves the desired end state (no tab, no worktree), so the record must go.
  test("still reports ok and deletes the spawn record", () => {
    const result = run("cleanup-closed-tab");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed", taskId: "fixture-task" });
    expect(result.json.cleanup).toMatchObject({ ok: true, removedWorkspace: "w9", cleaned: true });
    // Honest transcript: the failed close is still reported, verbatim.
    expect(result.json.cleanup.closedTabs).toEqual([]);
    expect(statuses(result.json)).toEqual([0, 0, 9, 0, 0, 0]);
    expect(result.json.cleanup.results[2].stderr).toBe("herdr: no such tab w9:t9");
    // Only an unconfirmed step buys the re-list, and it is where absence is proved.
    expect(calls()).toEqual([
      ["--version"],
      ["tab", "list"],
      ["worktree", "list", "--cwd", fixture.cwd],
      ["tab", "close", "w9:t9"],
      ["worktree", "remove", "--workspace", "w9"],
      ["tab", "list"],
      ["worktree", "list", "--cwd", fixture.cwd],
    ]);
    expect(readSpawns()["fixture-task"]).toBeUndefined();
  });

  // --replace is the recovery loop that was permanently blocked: cleanup could
  // never succeed, so the re-spawn never ran. It must now run to completion.
  test("unblocks --replace, which re-spawns and repoints the record", () => {
    const result = run("replace-closed-tab");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed", replace: true });
    expect(result.json.cleanup).toMatchObject({ ok: true, removedWorkspace: "w9" });
    // The success envelope carries a null task error, not an absent one.
    expect(result.json.error).toBeNull();
    expect(calls()).toEqual([
      ["--version"],
      ["tab", "list"],
      ["worktree", "list", "--cwd", fixture.cwd],
      ["tab", "close", "w9:t9"],
      ["worktree", "remove", "--workspace", "w9"],
      ["tab", "list"],
      ["worktree", "list", "--cwd", fixture.cwd],
      worktreeArgs(),
      tabArgs("w1"),
      agentArgs("w1:t2:p1"),
    ]);
    // The record now tracks the replacement spawn, not the wedged one.
    expect(readSpawns()["fixture-task"]).toMatchObject({
      workspaceId: "w1",
      tabId: "w1:t2",
      paneId: "w1:t2:p1",
    });
  });
});

describe("cleanup stays strict wherever absence cannot be established", () => {
  // A re-list that proves nothing must not be read as proof. This is the guard
  // on the whole fix: without it, "close returned nonzero" would be enough to
  // delete a record for a tab that is still running.
  test("a close denied while the tab is still listed keeps the record and exits 1", () => {
    const result = run("cleanup-close-denied");
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.cleanup.ok).toBe(false);
    // The worktree really was removed, so cleanup is honest about the partial.
    expect(result.json.cleanup.removedWorkspace).toBe("w9");
    expect(result.json.cleanup.closedTabs).toEqual([]);
    expect(result.json.cleanup.results[2].stderr).toContain("permission denied");
    // Discovery, close, remove, then the re-list that contradicts it.
    expect(statuses(result.json)).toEqual([0, 0, 9, 0, 0, 0]);
    expect(readSpawns()["fixture-task"]).toMatchObject(SEEDED);
  });

  test("an unreadable re-list is not an empty one, so cleanup stays failed", () => {
    const result = run("cleanup-relist-unreadable");
    expect(result.exit).toBe(1);
    expect(result.json.cleanup.ok).toBe(false);
    // The re-list exited 0 — a clean exit is not a readable list.
    expect(statuses(result.json)).toEqual([0, 0, 9, 0, 0, 0]);
    expect(readSpawns()["fixture-task"]).toMatchObject(SEEDED);
  });

  test("a failed discovery refuses to clean up and keeps the record", () => {
    const result = run("cleanup-discovery-fail");
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.cleanup.ok).toBe(false);
    expect(result.json.cleanup.error).toBe("herdr discovery failed; not safe to clean up");
    // Nothing was mutated and nothing was re-listed: without a first
    // observation there is no baseline to conclude anything from. Discovery is
    // eager, so both listings still ran before the statuses were judged.
    expect(calls()).toEqual([
      ["--version"],
      ["tab", "list"],
      ["worktree", "list", "--cwd", fixture.cwd],
    ]);
    expect(statuses(result.json)).toEqual([7, 0]);
    expect(readSpawns()["fixture-task"]).toMatchObject(SEEDED);
  });
});

describe("the happy path is untouched", () => {
  test("every step exiting 0 needs no re-list and behaves exactly as before", () => {
    const result = run("cleanup");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed", taskId: "fixture-task" });
    expect(result.json.cleanup).toMatchObject({
      ok: true,
      closedTabs: ["w9:t9"],
      removedWorkspace: "w9",
      cleaned: true,
      found: { tabs: ["w9:t9"], worktrees: 1, workspaceId: "w9" },
    });
    // No step failed, so nothing needed confirming: the call list is unchanged.
    expect(calls()).toEqual([
      ["--version"],
      ["tab", "list"],
      ["worktree", "list", "--cwd", fixture.cwd],
      ["tab", "close", "w9:t9"],
      ["worktree", "remove", "--workspace", "w9"],
    ]);
    expect(statuses(result.json)).toEqual([0, 0, 0, 0]);
    expect(readSpawns()["fixture-task"]).toBeUndefined();
  });
});
