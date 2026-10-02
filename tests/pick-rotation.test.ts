import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

// `pick` rotation across all three tiers. The task tier already rotated and is
// pinned unmodified by pick-delivery.test.ts; what is new here is that issues
// and freeform rotate too, that both fall back safely when the recorded cursor
// no longer resolves, and — because `pick`'s output is a documented contract —
// that none of it changed the shape a caller receives.

const RUNNER = new URL("./fixtures/pick-rotation-runner.ts", import.meta.url).href;

let fixture: ReturnType<typeof createFixture>;

function stateDir() {
  return join(fixture.home, ".local", "state", "herdr-harness");
}

function issuesDir() {
  return join(stateDir(), "issues");
}

function writeConfig(tasks: unknown[] = [{ id: "fixture-task" }]) {
  writeFileSync(
    join(fixture.cwd, ".herdr-harness.json"),
    JSON.stringify({
      adapters: {
        default: "fixture-adapter",
        routes: { "fixture-adapter": { kind: "fixture" } },
      },
      tasks,
    }),
  );
}

function cliJson(args: string[], exit = 0, input?: string) {
  const result = fixture.runCli(args, input);
  expect(result.exit, result.stdout).toBe(exit);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function pick() {
  return cliJson(["pick", "--json"]);
}

function ingest(raw: Record<string, unknown>) {
  return cliJson(["issues", "ingest", "--source", "sentry"], 0, JSON.stringify(raw)).draft;
}

function run(mode: string, payload?: string) {
  const result = fixture.runCode(`
    process.argv = [process.execPath, ${JSON.stringify(RUNNER)}, ${JSON.stringify(mode)},
      ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}, ${JSON.stringify(payload ?? "")}];
    await import(${JSON.stringify(RUNNER)});
  `);
  expect(result.exit, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

// A stored draft written directly, so `createdAt` is controllable and the
// severity/recency tie-break can be exercised without waiting on the clock.
// Fingerprints are filename-safe so the file name is predictable.
function plantDraft(over: {
  fingerprint: string;
  level?: string;
  createdAt: string;
  status?: string;
}) {
  mkdirSync(issuesDir(), { recursive: true });
  const draft = {
    id: over.fingerprint,
    title: `[sentry] fixture: ${over.fingerprint}`,
    body: "",
    labels: ["sentry", ...(over.level ? [over.level] : []), "desk:sentry-issues"],
    source: "sentry",
    playbook: "desk:sentry-issues",
    fingerprint: over.fingerprint,
    createdAt: over.createdAt,
    status: over.status ?? "mock-draft",
  };
  const path = join(issuesDir(), `sentry-${over.fingerprint}.json`);
  writeFileSync(path, `${JSON.stringify({ ...draft, path }, null, 2)}\n`);
  return path;
}

function draftPath(fingerprint: string) {
  return join(issuesDir(), `sentry-${fingerprint}.json`);
}

// One freeform ingress event. Untagged on purpose: `id` is then the literal
// "freeform" for every one of them, which is exactly why the cursor cannot be
// the id.
function freeformEvent(text: string, at: string) {
  return {
    at,
    source: "chat",
    taskId: null,
    text,
    sender: "fixture",
    channel: null,
    freeform: true,
    route: { kind: "fixture" },
    body: {},
  };
}

function lastPicked() {
  return run("last-picked").lastPicked as Record<string, unknown> | null;
}

beforeEach(() => {
  fixture = createFixture();
  fixture.assertIsolation();
  writeConfig();
});

afterEach(() => {
  fixture?.cleanup();
});

describe("issue tier rotation", () => {
  test("cold start still returns the highest-severity, newest draft", () => {
    // Severity beats recency: the fatal draft is older than both errors.
    plantDraft({ fingerprint: "fatal-old", level: "fatal", createdAt: "2026-01-01T00:00:00Z" });
    plantDraft({ fingerprint: "error-new", level: "error", createdAt: "2026-01-03T00:00:00Z" });
    plantDraft({ fingerprint: "error-old", level: "error", createdAt: "2026-01-02T00:00:00Z" });

    const first = pick();
    expect(first).toMatchObject({
      ok: true,
      id: "issue:fatal-old",
      kind: "issue",
      severity: "fatal",
      title: "[sentry] fixture: fatal-old",
      adapter: "fixture-adapter",
    });
    // The output contract is unchanged: same reason text, same rules array
    // shape, with the severity ordering rule still stated.
    expect(first.reason).toBe(
      "priority: mock issue drafts by severity then recency (github-created drafts are skipped)",
    );
    expect(Array.isArray(first.rules)).toBe(true);
    expect(first.rules.join("\n")).toMatch(/fatal > error > warning > info > other/);
  });

  test("two drafts rotate distinctly and wrap, severity intact at each position", () => {
    plantDraft({ fingerprint: "e-AAA", level: "fatal", createdAt: "2026-01-01T00:00:00Z" });
    plantDraft({ fingerprint: "e-BBB", level: "warning", createdAt: "2026-01-02T00:00:00Z" });

    const picks = [pick(), pick(), pick()];
    expect(picks.map((p) => p.id)).toEqual(["issue:e-AAA", "issue:e-BBB", "issue:e-AAA"]);
    // Rotation moves the starting point, never the ranking: at each position
    // the reported severity is that draft's own, and the fatal one still wins
    // whenever it is reached.
    expect(picks.map((p) => p.severity)).toEqual(["fatal", "warning", "fatal"]);
    expect(picks.every((p) => p.kind === "issue")).toBe(true);
  });

  test("rotation survives a draft that disappears from under the cursor", () => {
    plantDraft({ fingerprint: "e-AAA", level: "fatal", createdAt: "2026-01-01T00:00:00Z" });
    plantDraft({ fingerprint: "e-BBB", level: "warning", createdAt: "2026-01-02T00:00:00Z" });
    expect(pick().id).toBe("issue:e-AAA");

    // Published, evicted or hand-deleted: the cursor now names a draft that is
    // not there. It must read as a cold start, not as index -1.
    unlinkSync(draftPath("e-AAA"));
    const second = pick();
    expect(second).toMatchObject({ id: "issue:e-BBB", kind: "issue", severity: "warning" });

    // And the next draft still rotates in: no entry is skipped or repeated.
    plantDraft({ fingerprint: "e-CCC", level: "error", createdAt: "2026-01-03T00:00:00Z" });
    expect(pick().id).toBe("issue:e-CCC");
    expect(pick().id).toBe("issue:e-BBB");
    expect(pick().id).toBe("issue:e-CCC");
  });

  test("a lastPicked from another kind does not steer the issue cursor", () => {
    // A task pick leaves lastPicked.kind === "task"; the issue tier must ignore
    // it rather than match a task id against `issue:<fingerprint>`.
    expect(pick()).toMatchObject({ kind: "task", id: "fixture-task" });
    plantDraft({ fingerprint: "e-AAA", level: "fatal", createdAt: "2026-01-01T00:00:00Z" });
    plantDraft({ fingerprint: "e-BBB", level: "warning", createdAt: "2026-01-02T00:00:00Z" });

    expect(pick().id).toBe("issue:e-AAA");
    expect(pick().id).toBe("issue:e-BBB");

    // And a cursor with no id at all — an unexpected value, not a matching one.
    run("set-last-picked", JSON.stringify({ lastPicked: { kind: "issue", at: "2026-01-01T00:00:00Z" } }));
    expect(pick().id).toBe("issue:e-AAA");
  });
});

describe("freeform tier rotation", () => {
  test("three freeform events rotate distinctly and wrap", () => {
    // No tasks and no drafts: the freeform tier is reachable at all.
    writeConfig([]);
    run("seed-queue", JSON.stringify([
      freeformEvent("oldest", "2026-01-01T00:00:00Z"),
      freeformEvent("middle", "2026-01-02T00:00:00Z"),
      freeformEvent("newest", "2026-01-03T00:00:00Z"),
    ]));

    // Cold start takes the newest — unchanged from before rotation.
    const picks = [pick(), pick(), pick()];
    // Untagged events all share the id "freeform", so the text is what
    // distinguishes them; the rotation is on the event, not the id.
    expect(picks.map((p) => p.title)).toEqual(["newest", "oldest", "middle"]);
    expect(picks.map((p) => p.id)).toEqual(["freeform", "freeform", "freeform"]);
    expect(picks.every((p) => p.kind === "freeform")).toBe(true);
    expect(picks[0].reason).toBe("priority: freeform ingress queue");

    // Fourth pick wraps back to the first.
    expect(pick().title).toBe("newest");

    // The cursor is the event's own `at`, kept separate from `at`, which is
    // when the pick happened — the two are different things and only the first
    // can be matched back against the queue.
    const recorded = lastPicked();
    expect(recorded).toMatchObject({
      kind: "freeform",
      id: "freeform",
      eventAt: "2026-01-03T00:00:00Z",
    });
    expect(recorded?.at).not.toBe(recorded?.eventAt);
    expect(Date.parse(String(recorded?.at))).toBeGreaterThan(Date.parse("2026-01-03T00:00:00Z"));
  });

  test("a cursor whose event has aged out falls back to the newest event", () => {
    writeConfig([]);
    run("seed-queue", JSON.stringify([
      freeformEvent("older", "2026-01-01T00:00:00Z"),
      freeformEvent("newer", "2026-01-02T00:00:00Z"),
    ]));

    // An eventAt the queue no longer holds — it trimmed out of the ring.
    run("set-last-picked", JSON.stringify({
      lastPicked: { id: "freeform", kind: "freeform", at: "2026-01-05T00:00:00Z", eventAt: "2020-01-01T00:00:00Z" },
    }));
    expect(pick()).toMatchObject({ kind: "freeform", title: "newer", id: "freeform" });

    // A state.json written before the cursor existed: no eventAt field at all.
    run("set-last-picked", JSON.stringify({
      lastPicked: { id: "freeform", kind: "freeform", at: "2026-01-05T00:00:00Z" },
    }));
    expect(pick()).toMatchObject({ kind: "freeform", title: "newer" });
  });

  test("an issue pick does not steer the freeform cursor", () => {
    plantDraft({ fingerprint: "e-AAA", level: "fatal", createdAt: "2026-01-01T00:00:00Z" });
    expect(pick()).toMatchObject({ kind: "issue", id: "issue:e-AAA" });

    // Same events, same newest-first cold start, no interaction with the
    // issue cursor that is still recorded in lastPicked. The draft has to go
    // for the freeform tier to be reachable at all — issues outrank it.
    unlinkSync(draftPath("e-AAA"));
    writeConfig([]);
    run("seed-queue", JSON.stringify([
      freeformEvent("older", "2026-01-01T00:00:00Z"),
      freeformEvent("newer", "2026-01-02T00:00:00Z"),
    ]));
    expect(pick()).toMatchObject({ kind: "freeform", title: "newer" });
  });

  test("a freeform event with no timestamp records no cursor and picks the newest", () => {
    writeConfig([]);
    const undated = { ...freeformEvent("undated", "2026-01-01T00:00:00Z") } as Record<string, unknown>;
    delete undated.at;
    run("seed-queue", JSON.stringify([undated, freeformEvent("dated", "2026-01-02T00:00:00Z")]));

    expect(pick().title).toBe("dated");
    // No cursor to record for a freeform pick that took a timestamp-less event.
    run("seed-queue", JSON.stringify([undated]));
    expect(pick().title).toBe("undated");
    expect(lastPicked()).toMatchObject({ kind: "freeform" });
    expect(lastPicked()?.eventAt).toBeUndefined();
  });
});

describe("task tier and empty case are unchanged", () => {
  test("task rotation and cold start behave exactly as before", () => {
    writeConfig([{ id: "plain" }, { id: "wt", worktree: { branch: "fixture-branch" } }]);
    const picks = [pick(), pick(), pick()];
    expect(picks.map((p) => p.id)).toEqual(["wt", "plain", "wt"]);
    expect(picks.every((p) => p.kind === "task")).toBe(true);
    expect(picks[0].reason).toContain("worktree stub");
    expect(picks[1].reason).toContain("rotate after lastPicked");

    // Task picks record no freeform cursor.
    expect(lastPicked()?.eventAt).toBeUndefined();
    expect(lastPicked()).toMatchObject({ kind: "task", id: "wt" });
  });

  test("the empty case still reports nothing to pick and exits 1", () => {
    writeConfig([]);
    const empty = cliJson(["pick", "--json"], 1);
    expect(empty.ok).toBe(false);
    expect(empty.error).toBe("nothing to pick");
    expect(Array.isArray(empty.rules)).toBe(true);
    expect(empty.rules.length).toBeGreaterThan(0);
    // The rules describe the rotation the code now implements.
    expect(empty.rules.join("\n")).toMatch(/issues: rotate down the ranked drafts/);
    expect(empty.rules.join("\n")).toMatch(/freeform: rotate through freeform ingress events/);
    // And an empty queue never writes a cursor.
    expect(lastPicked()).toBeNull();
  });
});