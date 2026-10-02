import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const RUNNER = new URL("./fixtures/issues-idempotent-runner.ts", import.meta.url).href;
const EVENT_A = "idem-fixture-a";
const EVENT_B = "idem-fixture-b";
const URL_A = "https://github.com/duyet/harness/issues/42";
const URL_B = "https://github.com/duyet/harness/issues/43";
const GHES_URL_A = "https://ghe.example.com/duyet/harness/issues/42";

let fixture: ReturnType<typeof createFixture>;

function issuesDir() {
  return join(fixture.home, ".local", "state", "herdr-harness", "issues");
}

function draftFiles() {
  if (!existsSync(issuesDir())) return [];
  return readdirSync(issuesDir())
    .filter((f) => f.endsWith(".json"))
    .sort();
}

function storedDraft(fingerprint: string) {
  return JSON.parse(readFileSync(join(issuesDir(), `sentry-${fingerprint}.json`), "utf8"));
}

// Every gh invocation appends its argv here; a duplicate publish would show up
// as a second entry and rewrite the recorded URL.
function ghCalls(): string[][] {
  return JSON.parse(readFileSync(join(fixture.root, "gh-calls.json"), "utf8"));
}

// Drive one CLI/gateway ingest through the fixture runner, which owns the
// recording `gh` and the isolated PATH. `flavour` is what that `gh` prints on
// success — "plain" github.com, a GHES host, a URL past the 500-char reporting
// slice, or no URL at all.
function ingest(mode: string, event: "a" | "b" = "a", flavour = "plain") {
  fixture.assertIsolation();
  const child = fixture.runCode(`
    process.argv = [process.execPath, ${JSON.stringify(RUNNER)}, ${JSON.stringify(mode)},
      ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}, ${JSON.stringify(event)},
      ${JSON.stringify(flavour)}];
    await import(${JSON.stringify(RUNNER)});
  `);
  expect(child.stderr, `${mode}/${event}`).toBe("");
  return { exit: child.exit, stdout: child.stdout, json: JSON.parse(child.stdout) };
}

function cliJson(args: string[], exit = 0) {
  const result = fixture.runCli(args);
  expect(result.exit).toBe(exit);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

beforeEach(() => {
  fixture = createFixture();
  writeFileSync(
    join(fixture.cwd, ".herdr-harness.json"),
    JSON.stringify({
      adapters: { default: "fixture-adapter", routes: { "fixture-adapter": { kind: "fixture" } } },
      tasks: [{ id: "fixture-task" }],
    }),
  );
});

afterEach(() => {
  fixture?.cleanup();
});

describe("issue ingest replay", () => {
  test("a first ingest writes exactly sentry-<event_id>.json as a mock draft", () => {
    const result = ingest("dry-run");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "dry-run" });
    expect(draftFiles()).toEqual([`sentry-${EVENT_A}.json`]);
    const draft = storedDraft(EVENT_A);
    expect(draft.status).toBe("mock-draft");
    expect(draft.fingerprint).toBe(EVENT_A);
    expect(draft.githubIssueUrl).toBeUndefined();
    expect(ghCalls()).toEqual([]);
  });

  test("--execute publishes once; replaying the identical payload files no second issue", () => {
    ingest("dry-run");
    const first = ingest("execute");
    expect(first.exit).toBe(0);
    expect(first.json).toMatchObject({
      ok: true,
      mode: "executed",
      github: { status: 0, url: URL_A, issueNumber: 42 },
    });
    const published = storedDraft(EVENT_A);
    expect(published.status).toBe("github-created");
    expect(published.githubIssueUrl).toBe(URL_A);
    expect(published.githubIssueNumber).toBe(42);
    expect(ghCalls()).toHaveLength(1);

    // Identical payload, delivered again — the duplicate upstream replay.
    const replay = ingest("execute");
    expect(replay.exit).toBe(0);
    expect(replay.json).toMatchObject({ ok: true, mode: "executed" });
    // Nothing was spawned, and the recorded issue is reported back unchanged.
    expect(replay.json.github).toMatchObject({
      command: [],
      status: null,
      url: URL_A,
      issueNumber: 42,
    });
    expect(ghCalls()).toHaveLength(1);
    expect(draftFiles()).toEqual([`sentry-${EVENT_A}.json`]);

    const after = storedDraft(EVENT_A);
    expect(after.status).toBe("github-created");
    expect(after.githubIssueUrl).toBe(URL_A);
    expect(after.githubIssueNumber).toBe(42);
    // createdAt is when the issue was first seen; pick tie-breaks on it.
    expect(after.createdAt).toBe(published.createdAt);
    expect(replay.json.draft.createdAt).toBe(published.createdAt);
    expect(replay.json.draft.status).toBe("github-created");
  });

  test("direct ingestErrorEvent replay keeps published state and issues list agrees", () => {
    ingest("execute");
    expect(storedDraft(EVENT_A).status).toBe("github-created");

    const replay = ingest("replay-direct");
    expect(replay.exit).toBe(0);
    expect(replay.json.draft).toMatchObject({
      fingerprint: EVENT_A,
      status: "github-created",
      githubIssueUrl: URL_A,
      githubIssueNumber: 42,
    });
    expect(ghCalls()).toHaveLength(1);

    const listed = cliJson(["issues", "list", "--json"]);
    expect(listed.drafts).toHaveLength(1);
    expect(listed.drafts[0]).toMatchObject({
      fingerprint: EVENT_A,
      status: "github-created",
      githubIssueUrl: URL_A,
      githubIssueNumber: 42,
    });
  });

  test("gateway POST /ingress/sentry replay leaves the draft published", () => {
    ingest("execute");
    const published = storedDraft(EVENT_A);

    const replay = ingest("replay-gateway");
    expect(replay.exit).toBe(0);
    expect(replay.json.draft).toMatchObject({
      status: "github-created",
      githubIssueUrl: URL_A,
      githubIssueNumber: 42,
    });
    expect(storedDraft(EVENT_A)).toMatchObject({
      status: "github-created",
      githubIssueUrl: URL_A,
      createdAt: published.createdAt,
    });
    expect(ghCalls()).toHaveLength(1);
  });

  test("a replayed draft is not offered by pick, an unpublished one still is", () => {
    ingest("execute"); // published: never pickable
    ingest("dry-run", "b"); // still a mock draft: pickable
    ingest("replay-gateway");

    const picked = cliJson(["pick", "--json"]);
    expect(picked).toMatchObject({ ok: true, kind: "issue", id: `issue:${EVENT_B}` });
    expect(picked.severity).toBe("error");
    expect(JSON.stringify(picked)).not.toContain(`issue:${EVENT_A}`);

    // With the only remaining draft published too, pick falls through to tasks.
    ingest("execute", "b");
    ingest("replay-direct", "b");
    const afterBoth = cliJson(["pick", "--json"]);
    expect(afterBoth).toMatchObject({ ok: true, kind: "task", id: "fixture-task" });
    expect(JSON.stringify(afterBoth)).not.toContain(`issue:${EVENT_A}`);
    expect(JSON.stringify(afterBoth)).not.toContain(`issue:${EVENT_B}`);
  });

  test("a different event_id still ingests and publishes alongside the first", () => {
    ingest("execute");
    ingest("dry-run", "b");
    const second = ingest("execute", "b");
    expect(second.exit).toBe(0);
    expect(second.json).toMatchObject({
      ok: true,
      mode: "executed",
      github: { status: 0, url: URL_B, issueNumber: 43 },
    });

    // One gh call per distinct event, and both drafts coexist.
    expect(ghCalls()).toHaveLength(2);
    expect(draftFiles()).toEqual([`sentry-${EVENT_A}.json`, `sentry-${EVENT_B}.json`]);
    expect(storedDraft(EVENT_A)).toMatchObject({
      status: "github-created",
      githubIssueUrl: URL_A,
      githubIssueNumber: 42,
    });
    expect(storedDraft(EVENT_B)).toMatchObject({
      status: "github-created",
      githubIssueUrl: URL_B,
      githubIssueNumber: 43,
    });

    const listed = cliJson(["issues", "list", "--json"]);
    expect(listed.drafts.map((d: { fingerprint: string }) => d.fingerprint).sort()).toEqual([
      EVENT_A,
      EVENT_B,
    ]);
  });
});

// Plan 026: `gh` exiting 0 does not mean the harness can identify the issue it
// filed. Recording `github-created` without a URL reads as "never published" to
// both once-only guards, so a replay files a duplicate and a plain re-ingest
// erases the record. These pin both halves: the shapes that *are* identifiable
// are published normally, and the one that is not is never recorded as
// published at all.
describe("issue publish identification", () => {
  test("a GHES publish is recorded with its URL, and a re-ingest keeps it", () => {
    const first = ingest("execute", "a", "ghes");
    expect(first.exit).toBe(0);
    expect(first.json).toMatchObject({
      ok: true,
      mode: "executed",
      github: { status: 0, url: GHES_URL_A, issueNumber: 42 },
    });
    expect(storedDraft(EVENT_A)).toMatchObject({
      status: "github-created",
      githubIssueUrl: GHES_URL_A,
      githubIssueNumber: 42,
    });
    expect(ghCalls()).toHaveLength(1);

    // A plain re-ingest of the same event must not read the file as
    // unpublished and rewrite it back to a mock draft.
    const replay = ingest("replay-direct");
    expect(replay.exit).toBe(0);
    expect(replay.json.draft).toMatchObject({
      status: "github-created",
      githubIssueUrl: GHES_URL_A,
    });
    expect(storedDraft(EVENT_A)).toMatchObject({
      status: "github-created",
      githubIssueUrl: GHES_URL_A,
    });
    expect(ghCalls()).toHaveLength(1);
  });

  test("a URL past 500 chars of preamble is recorded, and a re-ingest keeps it", () => {
    const first = ingest("execute", "a", "long");
    expect(first.exit).toBe(0);
    expect(first.json).toMatchObject({
      ok: true,
      mode: "executed",
      github: { status: 0, url: URL_A, issueNumber: 42 },
    });
    expect(storedDraft(EVENT_A)).toMatchObject({
      status: "github-created",
      githubIssueUrl: URL_A,
      githubIssueNumber: 42,
    });
    expect(ghCalls()).toHaveLength(1);

    const replay = ingest("replay-gateway");
    expect(replay.exit).toBe(0);
    expect(replay.json.draft).toMatchObject({ status: "github-created", githubIssueUrl: URL_A });
    expect(storedDraft(EVENT_A)).toMatchObject({
      status: "github-created",
      githubIssueUrl: URL_A,
    });
    expect(ghCalls()).toHaveLength(1);
  });

  test("an unidentifiable publish stays a mock draft and a replay does not file a second issue", () => {
    const first = ingest("execute", "a", "no-url");
    expect(first.exit).toBe(1);
    expect(first.json.ok).toBe(false);
    expect(first.json.mode).toBe("executed");
    expect(first.json.github.status).toBe(0);
    expect(first.json.github.error).toContain("printed no recognisable issue URL");
    // Nothing on disk claims this event was published, because nothing on disk
    // can name the issue that was.
    const afterPublish = storedDraft(EVENT_A);
    expect(afterPublish.status).toBe("mock-draft");
    expect(afterPublish.githubIssueUrl).toBeUndefined();
    expect(ghCalls()).toHaveLength(1);

    // The same event delivered again, by both ingest paths: neither spawns a
    // second `gh issue create` for it.
    for (const mode of ["replay-direct", "replay-gateway"] as const) {
      const replay = ingest(mode);
      expect(replay.exit).toBe(0);
      expect(replay.json.draft.status).toBe("mock-draft");
      expect(storedDraft(EVENT_A).status).toBe("mock-draft");
      expect(ghCalls()).toHaveLength(1);
    }

    // And it is still pickable, which is the honest state for a draft nobody
    // can prove was published.
    const picked = cliJson(["pick", "--json"]);
    expect(picked).toMatchObject({ ok: true, kind: "issue", id: `issue:${EVENT_A}` });
  });
});
