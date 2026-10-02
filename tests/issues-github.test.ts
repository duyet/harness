import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const RUNNER = new URL("./fixtures/issues-gh-runner.ts", import.meta.url).href;
const ISSUES = new URL("../src/issues.ts", import.meta.url).href;
const LONG_URL = "https://github.com/duyet/harness/issues/42";
let fixture: ReturnType<typeof createFixture>;

function issuesDir() {
  return join(fixture.home, ".local", "state", "herdr-harness", "issues");
}

function storedDrafts() {
  if (!existsSync(issuesDir())) return [];
  return readdirSync(issuesDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(issuesDir(), f), "utf8")));
}

function ghCalls(): string[][] {
  return JSON.parse(readFileSync(join(fixture.root, "gh-calls.json"), "utf8"));
}

function labelsOf(argv: string[]): string[] {
  const labels: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--label") labels.push(argv[i + 1]);
  }
  return labels;
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
});

afterEach(() => {
  fixture?.cleanup();
});

describe("issues ingest gh publish spec", () => {
  test("githubIssueSpec drops the mock label and mock body note", () => {
    const result = fixture.runCode(`
      import { normalizeErrorEvent, githubIssueSpec, ghIssueCreateArgv } from ${JSON.stringify(ISSUES)};
      const raw = { event_id: "e1", project: "harness", message: "TypeError: boom", level: "error" };
      const draft = normalizeErrorEvent("sentry", raw);
      const spec = githubIssueSpec(draft);
      // Drafts without a stored raw payload fall back to a body note swap.
      const noRaw = githubIssueSpec({ ...draft, raw: undefined });
      console.log(JSON.stringify({ spec, noRaw, argv: ghIssueCreateArgv(draft) }));
    `);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    const { spec, noRaw, argv } = JSON.parse(result.stdout);
    expect(spec.title).toBe("[sentry] harness: TypeError: boom");
    expect(spec.labels.sort()).toEqual(["desk:sentry-issues", "error", "sentry"]);
    expect(spec.body).toContain("Source: sentry (created via gh issue create)");
    expect(spec.body).not.toContain("not called");
    expect(spec.body).toContain("Fingerprint: e1");
    expect(noRaw.body).toBe(spec.body);
    expect(argv.slice(0, 4)).toEqual(["issue", "create", "--title", spec.title]);
    expect(argv[4]).toBe("--body");
    expect(argv[5]).toBe(spec.body);
    expect(labelsOf(argv).sort()).toEqual(["desk:sentry-issues", "error", "sentry"]);
  });
});

describe("issues ingest --execute (fixture gh)", { timeout: 60000 }, () => {
  test("default ingest stays a mock draft and never invokes gh", () => {
    const result = run("mock");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      mode: "dry-run",
      github: "not called (mock-draft)",
    });
    expect(result.json.intendedCommand.slice(0, 3)).toEqual(["gh", "issue", "create"]);
    expect(result.json.draft.status).toBe("mock-draft");
    expect(ghCalls()).toEqual([]);
    const [stored] = storedDrafts();
    expect(stored.status).toBe("mock-draft");
    expect(stored.labels).toContain("mock");
  });

  test("--execute runs gh issue create and marks the draft github-created", () => {
    const result = run("created");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed" });
    expect(result.json.github).toMatchObject({
      status: 0,
      url: "https://github.com/duyet/harness/issues/42",
      issueNumber: 42,
    });
    const calls = ghCalls();
    expect(calls).toHaveLength(1);
    const argv = calls[0];
    expect(argv.slice(0, 2)).toEqual(["issue", "create"]);
    expect(labelsOf(argv).sort()).toEqual(["desk:sentry-issues", "error", "sentry"]);
    const body = argv[argv.indexOf("--body") + 1];
    expect(body).toContain("created via gh issue create");
    expect(body).not.toContain("not called");
    const [stored] = storedDrafts();
    expect(stored.status).toBe("github-created");
    expect(stored.githubIssueUrl).toBe("https://github.com/duyet/harness/issues/42");
    expect(stored.githubIssueNumber).toBe(42);
    expect(result.json.draft.status).toBe("github-created");
  });

  test("a GitHub Enterprise URL is recognised, not merely tolerated", () => {
    const result = run("created-ghes");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed" });
    expect(result.json.github).toMatchObject({
      status: 0,
      url: "https://ghe.example.com/duyet/harness/issues/42",
      issueNumber: 42,
    });
    const [stored] = storedDrafts();
    expect(stored.status).toBe("github-created");
    expect(stored.githubIssueUrl).toBe("https://ghe.example.com/duyet/harness/issues/42");
    expect(stored.githubIssueNumber).toBe(42);
  });

  test("a URL past 500 chars of preamble is parsed from the untruncated stdout", () => {
    const result = run("created-long-url");
    expect(result.exit).toBe(0);
    expect(result.json).toMatchObject({ ok: true, mode: "executed" });
    expect(result.json.github).toMatchObject({
      status: 0,
      url: "https://github.com/duyet/harness/issues/42",
      issueNumber: 42,
    });
    // The reported stdout is still bounded — a separate concern from what is
    // matched — so the URL is absent from it and present on the draft.
    const [stored] = storedDrafts();
    expect(stored.status).toBe("github-created");
    expect(stored.githubIssueUrl).toBe("https://github.com/duyet/harness/issues/42");
    expect(stored.githubIssueNumber).toBe(42);
  });

  // Plan 026: exit 0 with nothing identifiable is not a publish we can record.
  // Persisting `github-created` without a URL reads as "never published" to
  // both once-only guards, so a replay files a duplicate issue and a plain
  // re-ingest erases the record — the exact harm plan 007 closed.
  test("gh exit 0 with no recognisable URL fails and leaves the draft unpublished", () => {
    const result = run("created-no-url");
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.mode).toBe("executed");
    expect(result.json.github.status).toBe(0);
    expect(result.json.github.error).toContain("printed no recognisable issue URL");
    expect(result.json.github.error).toContain("re-running risks a duplicate");
    expect(result.json.github.url).toBeUndefined();
    const [stored] = storedDrafts();
    expect(stored.status).toBe("mock-draft");
    expect(stored.githubIssueUrl).toBeUndefined();
    expect(stored.githubIssueNumber).toBeUndefined();
  });

  // What is *reported* stays bounded at 500 chars, while what is *matched* is
  // read from the untruncated copy. `publishIssueDraft` takes the gh binary as
  // an argument, so the outcome is observable without a fixture PATH.
  test("the reported stdout is bounded while the URL is matched in full", () => {
    const gh = join(fixture.root, "gh-loud");
    writeFileSync(gh, `#!${process.execPath}\nconsole.log("x".repeat(900) + "\\n" + ${JSON.stringify(LONG_URL)});\n`, {
      mode: 0o755,
    });
    const result = fixture.runCode(`
      import { normalizeErrorEvent, publishIssueDraft } from ${JSON.stringify(ISSUES)};
      const draft = normalizeErrorEvent("sentry", { event_id: "e-loud", message: "boom", level: "error" });
      const out = publishIssueDraft(draft, ${JSON.stringify(gh)});
      console.log(JSON.stringify({ ok: out.ok, url: out.url, issueNumber: out.issueNumber, stdout: out.stdout }));
    `);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    const out = JSON.parse(result.stdout);
    expect(out).toMatchObject({ ok: true, url: LONG_URL, issueNumber: 42 });
    expect(out.stdout).toHaveLength(500);
    expect(out.stdout).not.toContain("issues/42");
  });

  test("writeIssueDraft refuses a github-created draft with no URL", () => {
    const result = fixture.runCode(`
      import { normalizeErrorEvent, writeIssueDraft } from ${JSON.stringify(ISSUES)};
      const draft = normalizeErrorEvent("sentry", { event_id: "e-nourl", message: "boom", level: "error" });
      console.log(JSON.stringify({
        mocked: writeIssueDraft(draft).status,
        withUrl: writeIssueDraft({ ...draft, status: "github-created", githubIssueUrl: "https://github.com/a/b/issues/1" }).status,
        threw: (() => {
          try { writeIssueDraft({ ...draft, status: "github-created" }); return false; }
          catch (e) { return String(e).includes("requires a githubIssueUrl"); }
        })(),
      }));
    `);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ mocked: "mock-draft", withUrl: "github-created", threw: true });
  });

  test("gh failure exits 1 and keeps the mock draft on disk", () => {
    const result = run("fail");
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.mode).toBe("executed");
    expect(result.json.github.error).toContain("exited 4");
    expect(result.json.github.stderr).toContain("not logged in");
    const [stored] = storedDrafts();
    expect(stored.status).toBe("mock-draft");
    expect(stored.githubIssueUrl).toBeUndefined();
  });

  test("missing gh binary exits 1 with the draft retained", () => {
    const result = run("no-gh");
    expect(result.exit).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.mode).toBe("executed");
    expect(result.json.github.error).toContain("gh not usable");
    expect(ghCalls()).toEqual([]);
    const [stored] = storedDrafts();
    expect(stored.status).toBe("mock-draft");
  });
});
