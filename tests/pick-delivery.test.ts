import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const ISSUES = new URL("../src/issues.ts", import.meta.url).href;
const CHAT_RUNNER = new URL("./fixtures/chat-pickup-runner.ts", import.meta.url).href;

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

function ingest(raw: Record<string, unknown>) {
  return cliJson(["issues", "ingest", "--source", "sentry"], 0, JSON.stringify(raw)).draft;
}

// Write a stored draft directly (e.g. a github-created one that ingest cannot
// produce without a real gh). Fingerprints here are filename-safe.
function plantDraft(over: {
  fingerprint: string;
  status?: string;
  level?: string;
  createdAt?: string;
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
    createdAt: over.createdAt ?? new Date().toISOString(),
    status: over.status ?? "mock-draft",
  };
  const path = join(issuesDir(), `sentry-${over.fingerprint}.json`);
  writeFileSync(path, `${JSON.stringify({ ...draft, path }, null, 2)}\n`);
  return path;
}

beforeEach(() => {
  fixture = createFixture();
  fixture.assertIsolation();
  writeConfig();
});

afterEach(() => {
  fixture?.cleanup();
});

describe("pick issue ordering", () => {
  test("rankIssueDrafts orders severity desc, then createdAt desc", () => {
    const out = codeJson(`
      import { rankIssueDrafts, issueSeverity } from ${JSON.stringify(ISSUES)};
      const mk = (fingerprint, level, createdAt, rawLevel) => ({
        id: fingerprint, title: fingerprint, body: "",
        labels: ["mock", "sentry", ...(level ? [level] : []), "desk:sentry-issues"],
        source: "sentry", playbook: "desk:sentry-issues",
        fingerprint, createdAt, status: "mock-draft",
        ...(rawLevel ? { raw: { level: rawLevel } } : {}),
      });
      const drafts = [
        mk("info-new", "info", "2026-01-03T00:00:00Z"),
        mk("fatal-old", "fatal", "2026-01-01T00:00:00Z"),
        mk("error-old", "error", "2026-01-01T00:00:00Z"),
        mk("other-new", null, "2026-01-04T00:00:00Z"),
        mk("warn-mid", "warning", "2026-01-02T12:00:00Z"),
        mk("error-new", "error", "2026-01-02T00:00:00Z"),
        mk("raw-fatal", null, "2026-01-05T00:00:00Z", "fatal"),
      ];
      console.log(JSON.stringify({
        order: rankIssueDrafts(drafts).map((d) => d.fingerprint),
        severities: Object.fromEntries(drafts.map((d) => [d.fingerprint, issueSeverity(d)])),
      }));
    `);
    expect(out.order).toEqual([
      "raw-fatal",
      "fatal-old",
      "error-new",
      "error-old",
      "warn-mid",
      "info-new",
      "other-new",
    ]);
    expect(out.severities["raw-fatal"]).toBe("fatal");
    expect(out.severities["other-new"]).toBe("other");
    expect(out.severities["warn-mid"]).toBe("warning");
  });

  test("severity beats recency and github-created drafts are never picked", () => {
    // A github-created fatal draft newer than everything: still not pickable.
    plantDraft({
      fingerprint: "created-fatal",
      status: "github-created",
      level: "fatal",
      createdAt: "2099-01-01T00:00:00Z",
    });
    ingest({ event_id: "err-first", project: "fixture", message: "older error", level: "error" });
    ingest({ event_id: "info-second", project: "fixture", message: "newer info", level: "info" });

    const first = cliJson(["pick", "--json"]);
    expect(first).toMatchObject({ ok: true, id: "issue:err-first", kind: "issue", severity: "error" });
    expect(Array.isArray(first.rules)).toBe(true);
    expect(first.rules.join("\n")).toMatch(/fatal > error > warning > info > other/);

    // Remove the error draft: the newer info mock is next, still over the
    // github-created fatal draft.
    unlinkSync(join(issuesDir(), "sentry-err-first.json"));
    const second = cliJson(["pick", "--json"]);
    expect(second).toMatchObject({ id: "issue:info-second", kind: "issue", severity: "info" });

    // Only github-created drafts remain: the issue tier is empty, tasks win.
    unlinkSync(join(issuesDir(), "sentry-info-second.json"));
    const third = cliJson(["pick", "--json"]);
    expect(third).toMatchObject({ ok: true, kind: "task", id: "fixture-task" });
  });

  test("cold start prefers a worktree-stub task, then rotates by list order", () => {
    writeConfig([{ id: "plain" }, { id: "wt", worktree: { branch: "fixture-branch" } }]);
    const picks = ["wt", "plain", "wt"].map((expected) => {
      const picked = cliJson(["pick", "--json"]);
      expect(picked).toMatchObject({ ok: true, kind: "task", id: expected });
      return picked;
    });
    expect(picks[0].reason).toContain("worktree stub");
    expect(picks[1].reason).toContain("rotate after lastPicked");
  });

  test("cold start falls back to list order when no task has a worktree", () => {
    writeConfig([{ id: "first" }, { id: "second" }]);
    expect(cliJson(["pick", "--json"]).id).toBe("first");
    expect(cliJson(["pick", "--json"]).id).toBe("second");
  });
});

describe("summary delivery stub", () => {
  const summaryMd = () => join(stateDir(), "last-summary.md");
  const summaryJson = () => join(stateDir(), "last-summary.json");
  const deliveryFile = () => join(stateDir(), "last-delivery.json");

  test("--deliver writes markdown, JSON sidecar and last-delivery under fixture HOME", () => {
    const result = fixture.runCli(["summary", "--deliver"]);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("# harness daily summary");
    expect(result.stdout).toContain(`delivered: ${summaryMd()}`);

    for (const path of [summaryMd(), summaryJson(), deliveryFile()]) {
      expect(path.startsWith(fixture.home)).toBe(true);
      expect(existsSync(path)).toBe(true);
    }
    const markdown = readFileSync(summaryMd(), "utf8");
    expect(markdown).toContain("# harness daily summary");
    expect(markdown).toContain("## Last delivery");

    const sidecar = JSON.parse(readFileSync(summaryJson(), "utf8"));
    expect(sidecar.ok).toBe(true);
    expect(sidecar.version).toBeTruthy();

    const record = JSON.parse(readFileSync(deliveryFile(), "utf8"));
    expect(record).toMatchObject({
      kind: "summary",
      summaryPath: summaryMd(),
      summaryJsonPath: summaryJson(),
      deliveryPath: deliveryFile(),
    });
    expect(record.excerpt).toContain("harness daily summary");
    expect(record.bytes).toBe(Buffer.byteLength(markdown, "utf8"));

    // The record is surfaced by follow-up status commands.
    const status = cliJson(["gateway", "status", "--json"]);
    expect(status.lastDelivery).toMatchObject({ kind: "summary", summaryPath: summaryMd() });
    const summary = cliJson(["summary", "--json"]);
    expect(summary.lastDelivery.summaryPath).toBe(summaryMd());
  });

  test("--deliver --json reports the delivered paths", () => {
    const json = cliJson(["summary", "--deliver", "--json"]);
    expect(json.delivered).toEqual({
      summaryPath: summaryMd(),
      summaryJsonPath: summaryJson(),
      deliveryPath: deliveryFile(),
    });
    expect(json.lastDelivery.kind).toBe("summary");
  });

  test("--write is an alias for --deliver", () => {
    expect(fixture.runCli(["summary", "--write"]).exit).toBe(0);
    expect(existsSync(summaryMd())).toBe(true);
    expect(existsSync(deliveryFile())).toBe(true);
  });

  test("summary without --deliver writes no state files", () => {
    const result = fixture.runCli(["summary", "--json"]);
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.stdout).lastDelivery).toBeNull();
    expect(existsSync(stateDir())).toBe(false);
  });
});

describe("chat summary pickup (stub)", () => {
  function run(mode: string) {
    const result = fixture.runCode(`
      process.argv = [process.execPath, ${JSON.stringify(CHAT_RUNNER)}, ${JSON.stringify(mode)},
        ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}];
      await import(${JSON.stringify(CHAT_RUNNER)});
    `);
    expect(result.exit, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, mode });
  }

  test("stub /chat replies include the delivered summary on pickup", () => {
    expect(fixture.runCli(["summary", "--deliver"]).exit).toBe(0);
    run("pickup");
  });

  test("pickup with no delivered summary yields lastSummary null", () => {
    run("pickup-empty");
  });
});
