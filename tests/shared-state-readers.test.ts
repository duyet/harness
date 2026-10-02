import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFixture } from "./helpers.ts";

// Plan 031: the residual of plan 025. That plan hardened the readers in
// `gateway.ts`; the three here live in `shared.ts` and kept their pre-025
// fallbacks, so a file that is valid JSON of the wrong shape was adopted
// wholesale — and two of the three then lose or corrupt a real write.
const RUNNER = new URL("./fixtures/shared-state-readers-runner.ts", import.meta.url).href;
const SRC = new URL("../src/", import.meta.url);
let fixture: ReturnType<typeof createFixture>;

// The runner asserts in its own process against the real readers and the real
// writers; a failure there is a nonzero exit, not a throw across the boundary.
function run(mode: string): Record<string, unknown> {
  fixture.assertIsolation();
  const result = fixture.runCode(`
    process.argv = [process.execPath, ${JSON.stringify(RUNNER)}, ${JSON.stringify(mode)}, ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}];
    await import(${JSON.stringify(RUNNER)});
  `);
  expect(result.exit, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const parsed = JSON.parse(result.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.mode).toBe(mode);
  return parsed.detail as Record<string, unknown>;
}

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture?.cleanup();
});

describe("shared.ts state readers reject wrong-shaped files (isolated)", () => {
  test("each reader answers its empty fallback and the next write survives", () => {
    // Every wrong shape is checked twice: the reader must not adopt it, and the
    // write that follows the read must still be on disk afterwards. `spawns`
    // carries the record just written, `state` carries `lastPicked` spread over
    // the loaded value, and `lastDelivery` has no writer to follow it.
    const detail = run("readers");
    expect(detail.spawnCases).toBe(14);
    expect(detail.stateCases).toBe(7);
    expect(detail.deliveryCases).toBe(13);
  });

  test("each guard is load-bearing: the pre-031 readers lose the write", () => {
    // The mutation is textual, in a copy of `shared.ts`: the pre-031 body is
    // put back and the plan's own three reproducers are re-run against it. The
    // shipped readers refuse the same three bytes at the end of the same run.
    expect(run("mutants").mutants).toBe(3);
  });
});

describe("the guards are beside the parse, not in gateway.ts", () => {
  test("shared.ts imports nothing from gateway.ts", () => {
    // Plan 031's STOP condition, checked mechanically: `readJsonFile` could
    // only be reused by inverting the dependency, since `gateway.ts` already
    // imports everything in `shared.ts`. The check is on the import list, not
    // on the word — `shared.ts` names the gateway in constants and paths.
    const shared = readFileSync(join(SRC.pathname, "shared.ts"), "utf8");
    const imports = [...shared.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gm)]
      .map((m) => m[1]!);
    expect(imports.some((specifier) => specifier.includes("gateway"))).toBe(false);
    // The duplicated check is the three lines plan 031 sanctions, not a copy
    // of the helper.
    expect(shared).toContain("function isRecord");
  });
});