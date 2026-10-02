import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createFixture } from "./helpers.ts";

const RUNNER = new URL("./fixtures/atomic-state-writes-runner.ts", import.meta.url).href;
const SRC = new URL("../src/", import.meta.url);
let fixture: ReturnType<typeof createFixture>;

// The runner drives the real writers and the real readers in an isolated
// HOME, and asserts in its own process; a failure there is a nonzero exit, not
// a throw across the boundary.
function run(): void {
  fixture.assertIsolation();
  const result = fixture.runCode(`
    process.argv = [process.execPath, ${JSON.stringify(RUNNER)}, ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}];
    await import(${JSON.stringify(RUNNER)});
  `);
  expect(result.exit, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).ok).toBe(true);
}

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture?.cleanup();
});

describe("atomic state writes", () => {
  test("every durable JSON writer leaves a complete document and no scratch file", () => {
    run();
  });

  test("`summary --deliver` writes all three files whole, markdown included", () => {
    fixture.assertIsolation();
    const result = fixture.runCli(["summary", "--deliver", "--json"]);
    expect(result.exit, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.lastDelivery.kind).toBe("summary");

    const stateDir = join(fixture.home, ".local", "state", "herdr-harness");
    const { summaryPath, summaryJsonPath, deliveryPath } = envelope.delivered;

    // The markdown body is in the set on purpose: the JSON fallback does not
    // protect a reader that shows a report stopping mid-sentence.
    const markdown = readFileSync(summaryPath, "utf8");
    expect(markdown.startsWith("# harness daily summary")).toBe(true);
    expect(markdown.endsWith("\n")).toBe(true);
    expect(JSON.parse(readFileSync(summaryJsonPath, "utf8")).ok).toBe(true);
    const record = JSON.parse(readFileSync(deliveryPath, "utf8"));
    expect(record.kind).toBe("summary");
    expect(record.excerpt.length).toBeLessThanOrEqual(600);

    // Same three paths, same trailing-newline convention, no scratch left over.
    expect(summaryPath).toBe(join(stateDir, "last-summary.md"));
    expect(summaryJsonPath).toBe(join(stateDir, "last-summary.json"));
    expect(deliveryPath).toBe(join(stateDir, "last-delivery.json"));
    expect(readdirSync(stateDir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  test("a failed atomic write keeps the previous file and leaves no orphan", () => {
    // A directory that cannot be written to is the honest way to fail a write
    // without racing a real one; the previous good file must survive it.
    fixture.assertIsolation();
    const stateDir = join(fixture.home, ".local", "state", "herdr-harness");
    const result = fixture.runCode(`
      import { mkdirSync, readFileSync, readdirSync } from "node:fs";
      import { join } from "node:path";
      import { STATE_DIR, writeJsonAtomic } from ${JSON.stringify(new URL("../src/shared.ts", import.meta.url).href)};
      mkdirSync(STATE_DIR, { recursive: true });
      writeJsonAtomic(join(STATE_DIR, "keep.json"), { good: true });
      const failed = [];
      for (const p of [join(STATE_DIR, "missing", "a.json"), STATE_DIR]) {
        try { writeJsonAtomic(p, { bad: true }); } catch (e) { failed.push(String(e)); }
      }
      console.log(JSON.stringify({
        failed: failed.length,
        kept: readFileSync(join(STATE_DIR, "keep.json"), "utf8"),
        files: readdirSync(STATE_DIR).filter((f) => f.includes(".tmp")),
      }));
    `);
    expect(result.exit, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.failed).toBe(2);
    expect(JSON.parse(out.kept)).toEqual({ good: true });
    expect(out.files).toEqual([]);
  });
});

describe("the write protocol is enforced in-tree", () => {
  const sources = ["shared.ts", "gateway.ts", "issues.ts", "cli.ts"];

  test("no durable writer in src/ uses a bare writeFileSync on a final path", () => {
    // The plan's done criterion, checked mechanically so a later writer cannot
    // quietly reintroduce the asymmetry. A surviving call must be the atomic
    // helper's own scratch write, or a PID file — plain text, written once by a
    // single process, and read back with a trim.
    const offenders: string[] = [];
    for (const name of sources) {
      const text = readFileSync(join(SRC.pathname, name), "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        if (!/^\s*(writeFileSync|.*[^.\w]writeFileSync)\(/.test(line)) continue;
        if (line.includes("tmp,")) continue; // the scratch write inside the helper
        if (line.includes("PID_FILE")) continue; // gateway.pid
        offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("each promoted writer routes through the shared helper", () => {
    const shared = readFileSync(join(SRC.pathname, "shared.ts"), "utf8");
    expect(shared).toContain("export function writeJsonAtomic");
    expect(shared).toContain("export function writeFileAtomic");

    // Ingress still uses the same helper — the promotion moved it, it did not
    // fork a second implementation.
    const gateway = readFileSync(join(SRC.pathname, "gateway.ts"), "utf8");
    expect(gateway).not.toContain("function writeJsonAtomic");
    expect(gateway).toContain("writeJsonAtomic(LAST_INGRESS_FILE");
    expect(gateway).toContain("writeJsonAtomic(INGRESS_QUEUE_FILE");
    // gateway.json is durable JSON, so it joined them.
    expect(gateway).toContain("writeJsonAtomic(GATEWAY_META_FILE");
    expect(gateway).not.toMatch(/writeFileSync\(/);

    expect(readFileSync(join(SRC.pathname, "issues.ts"), "utf8")).not.toMatch(/writeFileSync\(/);
    const cli = readFileSync(join(SRC.pathname, "cli.ts"), "utf8");
    expect(cli).toContain("writeJsonAtomic(LAST_DELIVERY_FILE");
    expect(cli).toContain("writeJsonAtomic(LAST_SUMMARY_JSON_FILE");
    expect(cli).toContain("writeFileAtomic(LAST_SUMMARY_FILE");
  });

  test("the shared helper never leaves a `.tmp` beside a live state file", () => {
    // Belt and braces on the naming: a reader that listed the state directory
    // should never see a scratch file that is not in flight.
    const shared = readFileSync(join(SRC.pathname, "shared.ts"), "utf8");
    expect(shared).toMatch(/const tmp = `\$\{path\}\.\$\{process\.pid\}\.tmp`/);
    expect(existsSync(join(SRC.pathname, "shared.ts"))).toBe(true);
  });
});
