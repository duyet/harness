import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const ISSUES = new URL("../src/issues.ts", import.meta.url).href;
const BASE64 = "base64";

// Mirrors the documented storage-key contract: allowlisted IDs keep the legacy
// basename, everything else is encoded as "~" + full sha256 hex. The "~"
// namespace is excluded from the allowlist so a direct ID can never alias it.
const SAFE_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

function expectedKey(fingerprint: string): string {
  if (SAFE_KEY_RE.test(fingerprint)) return fingerprint;
  return `~${createHash("sha256").update(fingerprint).digest("hex")}`;
}

let fixture: ReturnType<typeof createFixture>;

function stateDir() {
  return join(fixture.home, ".local", "state", "herdr-harness");
}

// The issues directory lives under the fixture HOME via shared.ts constants.
function issuesDir() {
  return join(stateDir(), "issues");
}

// Values must survive JSON stringification into a bun --eval program; base64
// keeps hostile strings (newlines, quotes, non-ASCII) opaque to both shells.
function jsonPayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString(BASE64);
}

function ingest(raw: Record<string, unknown>, source: "sentry" | "bugsink" = "sentry") {
  const code = `
    import { ingestErrorEvent } from ${JSON.stringify(ISSUES)};
    const payload = JSON.parse(Buffer.from(${JSON.stringify(jsonPayload(raw))}, "${BASE64}").toString("utf8"));
    console.log(JSON.stringify(ingestErrorEvent(${JSON.stringify(source)}, payload)));
  `;
  const result = fixture.runCode(code);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

// Like ingest(), but reports rejections: spawnSync cannot carry an exception,
// so the child — whose try block wraps only the ingest call itself — reports
// whether the call threw and with what message.
function ingestRejected(raw: Record<string, unknown>, source: string) {
  const code = `
    import { ingestErrorEvent } from ${JSON.stringify(ISSUES)};
    const payload = JSON.parse(Buffer.from(${JSON.stringify(jsonPayload(raw))}, "${BASE64}").toString("utf8"));
    try {
      ingestErrorEvent(${JSON.stringify(source)}, payload);
      console.log(JSON.stringify({ threw: false }));
    } catch (error) {
      console.log(JSON.stringify({ threw: true, message: String(error instanceof Error ? error.message : error) }));
    }
  `;
  const result = fixture.runCode(code);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

// writeIssueDraft corrupted the way an untyped consumer could corrupt it.
function writeIssueRejected(mutate: string) {
  const code = `
    import { normalizeErrorEvent, writeIssueDraft } from ${JSON.stringify(ISSUES)};
    const draft = normalizeErrorEvent("sentry", { event_id: "ordinary-event-1", message: "Example error" });
    ${mutate}
    try {
      writeIssueDraft(draft);
      console.log(JSON.stringify({ threw: false }));
    } catch (error) {
      console.log(JSON.stringify({ threw: true, message: String(error instanceof Error ? error.message : error) }));
    }
  `;
  const result = fixture.runCode(code);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function listDrafts() {
  const code = `
    import { listIssueDrafts } from ${JSON.stringify(ISSUES)};
    console.log(JSON.stringify(listIssueDrafts()));
  `;
  const result = fixture.runCode(code);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function draftFiles(): string[] {
  return existsSync(issuesDir()) ? readdirSync(issuesDir()).sort() : [];
}

// Marker file planted beside — never inside — the issues directory.
function plantSentinel(): string {
  mkdirSync(stateDir(), { recursive: true });
  const sentinel = join(stateDir(), "sentinel.txt");
  writeFileSync(sentinel, "intact\n");
  return sentinel;
}

beforeEach(() => {
  fixture = createFixture();
  fixture.assertIsolation();
});

afterEach(() => {
  fixture?.cleanup();
});

describe("issue draft path containment", { timeout: 60000 }, () => {
  test("ordinary safe IDs keep the legacy basename", () => {
    for (const fingerprint of ["ordinary-event-1", "Ev3nt_ID-42", "a".repeat(128)]) {
      for (const source of ["sentry", "bugsink"] as const) {
        const draft = ingest({ event_id: fingerprint, message: "Example error" }, source);
        expect(draft.source).toBe(source);
        expect(dirname(draft.path)).toBe(issuesDir());
        expect(basename(draft.path)).toBe(`${source}-${fingerprint}.json`);
      }
    }
  });

  test("storing the same source and ID twice yields one file", () => {
    const first = ingest({ event_id: "ordinary-event-1", message: "First message" });
    const second = ingest({ event_id: "ordinary-event-1", message: "First message" });
    expect(second.path).toBe(first.path);
    expect(draftFiles()).toEqual(["sentry-ordinary-event-1.json"]);
    expect(listDrafts()).toHaveLength(1);
  });

  test("returned path names the stored file and listIssueDrafts reads it", () => {
    const draft = ingest({ event_id: "ordinary-event-2", message: "Example error" });
    expect(existsSync(draft.path)).toBe(true);
    const stored = JSON.parse(readFileSync(draft.path, "utf8"));
    expect(stored.fingerprint).toBe("ordinary-event-2");
    expect(stored.path).toBe(draft.path);
    const listed = listDrafts();
    expect(listed).toHaveLength(1);
    expect(listed[0].path).toBe(draft.path);
    expect(listed[0].fingerprint).toBe("ordinary-event-2");
  });

  test("unsafe IDs are contained with encoded, deterministic filenames", () => {
    const cases: { fingerprint: string }[] = [
      { fingerprint: "a".repeat(129) },
      { fingerprint: "a/b" },
      { fingerprint: "a\\b" },
      { fingerprint: ".." },
      { fingerprint: "../../outside" },
      { fingerprint: "." },
      { fingerprint: "\t padded id \n" },
      { fingerprint: "evént-日本語" },
      { fingerprint: "~leading-tilde" },
    ];
    for (const { fingerprint } of cases) {
      const draft = ingest({ event_id: fingerprint, message: "Example error" });
      expect(draft.fingerprint).toBe(fingerprint);
      expect(basename(draft.path)).toBe(`sentry-${expectedKey(fingerprint)}.json`);
      expect(dirname(draft.path)).toBe(issuesDir());
      expect(existsSync(draft.path)).toBe(true);
      const stored = JSON.parse(readFileSync(draft.path, "utf8"));
      expect(stored.fingerprint).toBe(fingerprint);
    }
    expect(draftFiles()).toHaveLength(cases.length);
    for (const name of draftFiles()) {
      expect(name).toMatch(/^sentry-~[0-9a-f]{64}\.json$/);
    }
  });

  test("invalid source and non-string fingerprint throw without creating drafts", () => {
    const rejected = ingestRejected({ event_id: "ordinary-event-3", message: "Example error" }, "github");
    expect(rejected.threw).toBe(true);
    expect(rejected.message).toContain("invalid issue source");
    // Threw before directory creation: the issues dir must not exist yet.
    expect(existsSync(issuesDir())).toBe(false);

    ingest({ event_id: "ordinary-event-4", message: "Example error" });
    expect(draftFiles()).toEqual(["sentry-ordinary-event-4.json"]);
    for (const mutate of [`draft.source = "github";`, `draft.fingerprint = "";`, `draft.fingerprint = 42;`]) {
      const result = writeIssueRejected(mutate);
      expect(result.threw).toBe(true);
      expect(result.message).toContain(mutate.includes("source") ? "invalid issue source" : "fingerprint");
      expect(draftFiles()).toEqual(["sentry-ordinary-event-4.json"]);
    }
  });

  test("encoded namespace cannot collide with direct safe IDs", () => {
    const direct = ingest({ event_id: "ordinary-event-5", message: "Example error" });
    const tilde = ingest({ event_id: "~ordinary-event-5", message: "Example error" });
    expect(basename(direct.path)).toBe("sentry-ordinary-event-5.json");
    expect(basename(tilde.path)).toBe(`sentry-${expectedKey("~ordinary-event-5")}.json`);
    expect(direct.path).not.toBe(tilde.path);

    // Even a direct ID spelling out a would-be encoded key stays distinct:
    // encoded names always carry the "~" prefix.
    const hex = createHash("sha256").update("a/b").digest("hex");
    const hexDraft = ingest({ event_id: hex, message: "Example error" });
    const slashDraft = ingest({ event_id: "a/b", message: "Example error" });
    expect(basename(hexDraft.path)).toBe(`sentry-${hex}.json`);
    expect(basename(slashDraft.path)).toBe(`sentry-~${hex}.json`);
    expect(draftFiles()).toHaveLength(4);
    expect(listDrafts().map((d: { fingerprint: string }) => d.fingerprint).sort()).toEqual(
      ["~ordinary-event-5", "a/b", hex, "ordinary-event-5"].sort(),
    );
  });

  test("both sources with the same fingerprint produce separate files", () => {
    const fingerprint = "shared/unsafe/id";
    const sentry = ingest({ event_id: fingerprint }, "sentry");
    const bugsink = ingest({ event_id: fingerprint }, "bugsink");
    expect(basename(sentry.path)).toBe(`sentry-${expectedKey(fingerprint)}.json`);
    expect(basename(bugsink.path)).toBe(`bugsink-${expectedKey(fingerprint)}.json`);
    expect(sentry.path).not.toBe(bugsink.path);
    expect(draftFiles()).toHaveLength(2);
    const listed = listDrafts();
    expect(listed).toHaveLength(2);
    for (const draft of listed) {
      expect(draft.fingerprint).toBe(fingerprint);
    }
    expect(listed.map((draft: { source: string }) => draft.source).sort()).toEqual(["bugsink", "sentry"]);
  });

  test("hostile ingestion leaves the rest of the state directory untouched", () => {
    const sentinel = plantSentinel();
    const draft = ingest({ event_id: "../escape-payload", message: "Example error" });
    expect(dirname(draft.path)).toBe(issuesDir());
    expect(draftFiles()).toEqual([`sentry-${expectedKey("../escape-payload")}.json`]);
    expect(readFileSync(sentinel, "utf8")).toBe("intact\n");
    expect(readdirSync(stateDir()).sort()).toEqual(["issues", "sentinel.txt"]);
  });
});
