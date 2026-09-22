import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

const RUNNER = new URL("./fixtures/gateway-chat-runner.ts", import.meta.url).href;
let fixture: ReturnType<typeof createFixture>;
let fakeBin: string;

function writeAdapter(name: string, body: string) {
  writeFileSync(join(fakeBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function run(mode: string) {
  const result = fixture.runCode(`
    process.argv = [process.execPath, ${JSON.stringify(RUNNER)}, ${JSON.stringify(mode)}, ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}, ${JSON.stringify(fakeBin)}];
    await import(${JSON.stringify(RUNNER)});
  `);
  expect(result.exit, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, mode });
}

beforeEach(() => {
  fixture = createFixture();
  fixture.assertIsolation();
  fakeBin = join(fixture.root, "bin");
  mkdirSync(fakeBin, { recursive: true });
  const echoArgv = [
    `echo ran >> "$MOCK_MARKER"`,
    `printf 'mock-adapter-reply:'`,
    `for a in "$@"; do printf ' <%s>' "$a"; done`,
    `printf '\\n'`,
  ].join("\n");
  writeAdapter("fixture-chat", echoArgv);
  // Freeform chat resolves to the default adapter id as the binary.
  writeAdapter("fixture-adapter", echoArgv);
  writeAdapter("fixture-hang", `echo ran >> "$MOCK_MARKER"\nexec sleep 60`);
  writeAdapter(
    "fixture-fail",
    `echo ran >> "$MOCK_MARKER"\necho fixture-adapter-failed >&2\nexit 3`,
  );
  writeFileSync(
    join(fixture.cwd, ".herdr-harness.json"),
    JSON.stringify({
      adapters: {
        default: "fixture-adapter",
        routes: {
          "fixture-adapter": { kind: "fixture-chat" },
          "hang-adapter": { kind: "fixture-hang" },
          "fail-adapter": { kind: "fixture-fail" },
          "ghost-adapter": { kind: "fixture-absent-bin" },
          "full-adapter": {
            kind: "fixture-chat",
            via: "via-arg",
            model: "fixture-model",
            flags: ["--flag-a", "--flag-b"],
          },
        },
      },
      tasks: [
        { id: "fixture-task", adapter: "fixture-adapter" },
        { id: "hang-task", adapter: "hang-adapter" },
        { id: "fail-task", adapter: "fail-adapter" },
        { id: "ghost-task", adapter: "ghost-adapter" },
        { id: "full-task", adapter: "full-adapter" },
      ],
    }),
  );
});

afterEach(() => {
  fixture?.cleanup();
});

describe("gateway /chat adapter replies (isolated, no sockets)", () => {
  test("default chat stays a stub and never spawns the adapter", () => {
    run("stub");
  });

  test('"execute": true runs the resolved adapter and returns its output', () => {
    run("execute-field");
  });

  test("HARNESS_CHAT_EXECUTE=1 opts in without a request field", () => {
    run("execute-env");
  });

  test("missing adapter binary falls back to stub with executeError", () => {
    run("execute-missing");
  });

  test("non-zero adapter exit falls back to stub with executeError", () => {
    run("execute-nonzero");
  });

  test("hung adapter is killed at the timeout and falls back to stub", () => {
    run("execute-timeout");
  });
});
