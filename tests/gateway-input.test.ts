import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const RUNNER = new URL("./fixtures/gateway-input-runner.ts", import.meta.url).href;
let fixture: ReturnType<typeof createFixture>;

function run(mode: string) {
  const result = fixture.runCode(`
    process.argv = [process.execPath, ${JSON.stringify(RUNNER)}, ${JSON.stringify(mode)}, ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}];
    await import(${JSON.stringify(RUNNER)});
  `);
  expect(result.exit, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, mode });
}

beforeEach(() => {
  fixture = createFixture();
  fixture.assertIsolation();
  writeFileSync(join(fixture.cwd, ".herdr-harness.json"), JSON.stringify({
    adapters: { default: "fixture-default", routes: { "fixture-adapter": { kind: "fixture" } } },
    tasks: [{ id: "fixture-task", adapter: "fixture-adapter" }],
  }));
});

afterEach(() => {
  fixture?.cleanup();
});

describe("gateway JSON input (isolated, no sockets)", () => {
  test("preserves GET, 404 and successful POST responses and persistence", () => {
    run("happy");
  });

  test("rejects malformed, non-object and wrong-shape POSTs with JSON 400 and no writes", () => {
    run("invalid");
  });

  test("rejected POSTs preserve existing queues, drafts and nested state", () => {
    run("invalid-seeded");
  });

  test("accepts optional containers, unknown fields and task aliases", () => {
    run("compatible");
  });

  test("storage failures are not relabeled as client errors", () => {
    run("storage");
  });
});
