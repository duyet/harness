import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const RUNNER = new URL("./fixtures/manager-exit-runner.ts", import.meta.url).href;
let fixture: ReturnType<typeof createFixture>;

function worktreeArgs() {
  return ["worktree", "create", "--cwd", fixture.cwd, "--branch", "fixture-branch",
    "--base", "fixture-base", "--path", join(fixture.root, "worktree"), "--label", "fixture-label", "--no-focus"];
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
  if (json.mode === "dry-run") {
    expect(json.herdr.bin).toBe(join(fixture.root, "bin", "fixture-herdr"));
  }
  return { ...child, json, calls };
}

beforeEach(() => {
  fixture = createFixture();
  writeFileSync(join(fixture.cwd, ".herdr-harness.json"), JSON.stringify({
    adapters: { default: "fixture-adapter", routes: { "fixture-adapter": { kind: "fixture" } } },
    tasks: [{ id: "fixture-task", worktree: {
      branch: "fixture-branch", base: "fixture-base", path: join(fixture.root, "worktree"), label: "fixture-label",
    } }],
  }));
});

afterEach(() => {
  fixture?.cleanup();
});

describe("manager spawn exit status", () => {
  test("executed success returns complete JSON and exits zero", () => {
    const result = run("success");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed", task: { id: "fixture-task" } });
    expect(result.json.results).toEqual([{
      command: [join(fixture.root, "bin", "fixture-herdr"), ...worktreeArgs()],
      status: 0, stdout: "fixture stdout", stderr: "fixture stderr",
    }]);
    expect(result.calls).toEqual([["--version"], worktreeArgs()]);
  });

  test("default dry-run never executes the worktree command", () => {
    const result = run("dry-run");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "dry-run", herdr: { ok: true } });
    expect(result.json.skippedExecute).toContain("default is dry-run");
    expect(result.json.intendedCommands).toEqual([["herdr", ...worktreeArgs()]]);
    expect(result.json.results).toBeUndefined();
    expect(result.calls).toEqual([["--version"]]);
  });

  test("unavailable Herdr with --execute falls back to successful dry-run", () => {
    const result = run("unavailable");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "dry-run", herdr: { ok: false } });
    expect(result.json.skippedExecute).toBe(result.json.herdr.reason);
    expect(result.json.intendedCommands).toEqual([["herdr", ...worktreeArgs()]]);
    expect(result.json.results).toBeUndefined();
    expect(result.calls).toEqual([["--version"]]);
  });

  test("unknown task exits one without executing a worktree command", () => {
    const result = run("unknown");
    expect(result.exit).toBe(1);
    expect(result.json).toMatchObject({ ok: false, mode: "dry-run", error: "unknown task: unknown-task" });
    expect(result.json.intendedCommands).toEqual([]);
    expect(result.json.results).toBeUndefined();
    expect(result.calls).toEqual([["--version"]]);
  });

  test("nonzero child status yields ok:false JSON and CLI exit one", () => {
    const result = run("nonzero");
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.mode).toBe("executed");
    expect(result.json.results).toEqual([{
      command: [join(fixture.root, "bin", "fixture-herdr"), ...worktreeArgs()],
      status: 7, stdout: "fixture stdout", stderr: "fixture stderr",
    }]);
    expect(result.calls).toEqual([["--version"], worktreeArgs()]);
  });

  test("signalled child with null status yields ok:false JSON and CLI exit one", () => {
    const result = run("null");
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.mode).toBe("executed");
    expect(result.json.results).toEqual([{
      command: [join(fixture.root, "bin", "fixture-herdr"), ...worktreeArgs()],
      status: null, stdout: "fixture stdout", stderr: "fixture stderr",
    }]);
    expect(result.calls).toEqual([["--version"], worktreeArgs()]);
  });
});
