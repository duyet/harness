import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFixture } from "./helpers.ts";

const ISSUES = new URL("../src/issues.ts", import.meta.url).href;
const config = {
  name: "baseline-fixture",
  adapters: {
    default: "primary",
    routes: {
      primary: { kind: "fixture", model: "primary-model" },
      secondary: { kind: "fixture", model: "secondary-model" },
    },
  },
  tasks: [{ id: "first" }, { id: "second", adapter: "secondary" }],
};

let fixture: ReturnType<typeof createFixture>;

function stateDir() {
  return join(fixture.home, ".local", "state", "herdr-harness");
}

function stateFile() {
  return join(stateDir(), "state.json");
}

function readState() {
  return JSON.parse(readFileSync(stateFile(), "utf8"));
}

function cliJson(args: string[], exit = 0) {
  const result = fixture.runCli(args);
  expect(result.exit).toBe(exit);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function codeJson(code: string) {
  const result = fixture.runCode(code);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

beforeEach(() => {
  fixture = createFixture();
  fixture.assertIsolation();
  writeFileSync(join(fixture.cwd, ".herdr-harness.json"), JSON.stringify(config));
});

afterEach(() => {
  fixture?.cleanup();
});

describe("isolated CLI baseline", () => {
  test("child STATE_DIR resolves under the fixture home", () => {
    const paths = fixture.assertIsolation();
    expect(paths.stateDir).toBe(stateDir());
    expect(paths.stateFile).toBe(stateFile());
    expect(paths.cwd).toBe(fixture.cwd);
    expect(existsSync(paths.stateDir)).toBe(false);
  });

  test("--help exits successfully", () => {
    const result = fixture.runCli(["--help"]);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("harness start [--resume]");
    expect(existsSync(stateFile())).toBe(false);
  });

  test("fresh status is idle", () => {
    const status = cliJson(["status", "--json"]);
    expect(status.ok).toBe(true);
    expect(status.started).toBe(false);
    expect(status.sessionId).toBeNull();
    expect(status.startedAt).toBeNull();
    expect(status.stateFile).toBe(stateFile());
    expect(status.configPath).toBe(join(fixture.cwd, ".herdr-harness.json"));
    expect(status.tasks).toEqual(config.tasks);
    expect(existsSync(stateFile())).toBe(false);
  });

  test("resume without state exits 1", () => {
    const result = fixture.runCli(["resume"]);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("nothing to resume: no session id in state");
    expect(result.stderr).toContain(stateFile());
    expect(existsSync(stateFile())).toBe(false);
  });

  test("start persists a session", () => {
    expect(fixture.runCli(["start"]).exit).toBe(0);
    const state = readState();
    expect(state.started).toBe(true);
    expect(typeof state.sessionId).toBe("string");
    expect(state.sessionId.length).toBeGreaterThan(0);
    expect(state.agent).toBe(config.adapters.default);
    const status = cliJson(["status", "--json"]);
    expect(status.started).toBe(true);
    expect(status.sessionId).toBe(state.sessionId);
  });

  test("start --resume preserves the existing session", () => {
    expect(fixture.runCli(["start"]).exit).toBe(0);
    const first = readState();
    expect(fixture.runCli(["start", "--resume"]).exit).toBe(0);
    const resumed = readState();
    expect(resumed.started).toBe(true);
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.startedAt).toBe(first.startedAt);
  });

  test("ordinary second start changes the session", () => {
    expect(fixture.runCli(["start"]).exit).toBe(0);
    const first = readState();
    expect(fixture.runCli(["start"]).exit).toBe(0);
    const second = readState();
    expect(typeof second.sessionId).toBe("string");
    expect(second.sessionId.length).toBeGreaterThan(0);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.started).toBe(true);
  });

  test("manager route resolves fixture tasks and adapters", () => {
    for (const [index, adapterId] of ["primary", "secondary"].entries()) {
      const task = config.tasks[index];
      const route = cliJson(["manager", "route", task.id]);
      expect(route.ok).toBe(true);
      expect(route.error).toBeNull();
      expect(route.task).toEqual(task);
      expect(route.adapterId).toBe(adapterId);
      expect(route.route).toEqual(config.adapters.routes[adapterId as keyof typeof config.adapters.routes]);
      expect(route.configPath).toBe(join(fixture.cwd, ".herdr-harness.json"));
    }
  });

  test("unknown task exits 1 with ok:false", () => {
    const route = cliJson(["manager", "route", "missing-task"], 1);
    expect(route.ok).toBe(false);
    expect(route.error).toBe("unknown task: missing-task");
    expect(route.tasks).toEqual(config.tasks);
  });

  test("issue normalization sets source and labels without writing", () => {
    const drafts = codeJson(`
      import { normalizeErrorEvent } from ${JSON.stringify(ISSUES)};
      const raw = { event_id: "ordinary-event-1", project: "fixture", message: "Example error", level: "warning" };
      console.log(JSON.stringify(["sentry", "bugsink"].map(source => normalizeErrorEvent(source, raw))));
    `);
    for (const [index, source] of ["sentry", "bugsink"].entries()) {
      expect(drafts[index].source).toBe(source);
      expect(drafts[index].labels).toEqual(["mock", source, "warning", "desk:sentry-issues"]);
      expect(drafts[index].title).toBe(`[${source}] fixture: Example error`);
      expect(drafts[index].status).toBe("mock-draft");
      expect(drafts[index].path).toBeUndefined();
    }
    // Bun's own --eval cache may appear under HOME; the app's state must not.
    expect(existsSync(stateDir())).toBe(false);
    expect(readdirSync(fixture.cwd)).toEqual([".herdr-harness.json"]);
  });

  test("repeated ordinary event IDs have stable fingerprints", () => {
    const fingerprints = codeJson(`
      import { fingerprintFor } from ${JSON.stringify(ISSUES)};
      console.log(JSON.stringify(["event_id", "eventId", "id"].map(key => [
        fingerprintFor({ [key]: "ordinary-event-1", message: "First message" }),
        fingerprintFor({ [key]: "ordinary-event-1", message: "Changed message" }),
      ])));
    `);
    for (const [first, repeated] of fingerprints) {
      expect(typeof first).toBe("string");
      expect(first.length).toBeGreaterThan(0);
      expect(repeated).toBe(first);
    }
    // Pure functions: no state or issue drafts written (state dir holds issues/).
    expect(existsSync(stateDir())).toBe(false);
    expect(readdirSync(fixture.cwd)).toEqual([".herdr-harness.json"]);
  });

  test("named-task picks rotate through two fixture tasks", () => {
    for (const task of [config.tasks[0], config.tasks[1], config.tasks[0]]) {
      const picked = cliJson(["pick", "--json"]);
      expect(picked.ok).toBe(true);
      expect(picked.id).toBe(task.id);
      expect(picked.kind).toBe("task");
      expect(picked.adapter).toBe(task.adapter ?? config.adapters.default);
      const state = readState();
      expect(state.lastPicked.id).toBe(task.id);
      expect(state.lastPicked.kind).toBe("task");
      expect(state.lastPicked.adapter).toBe(picked.adapter);
    }
  });
});
