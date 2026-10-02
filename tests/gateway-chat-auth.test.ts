import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

// Plan 008: /chat execute is gated on the route kind, the gateway bind and the
// request Origin. Isolated fixtures under dist/.test-tmp/, local shell scripts
// only — no sockets, no network, no LLM adapters.

const RUNNER = new URL("./fixtures/gateway-chat-auth-runner.ts", import.meta.url).href;
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
  // `claude` is a built-in allowlisted kind; the other two are resolvable on
  // PATH so a denial is proven by the absent marker, not by a missing binary.
  writeAdapter("claude", echoArgv);
  writeAdapter("fixture-extra-kind", echoArgv);
  writeAdapter("fixture-secret-bin", echoArgv);
  writeFileSync(
    join(fixture.cwd, ".herdr-harness.json"),
    JSON.stringify({
      adapters: {
        default: "claude",
        chat: { executeKinds: ["fixture-extra-kind"] },
        routes: {
          "allow-adapter": { kind: "claude" },
          "extra-adapter": { kind: "fixture-extra-kind" },
          "denied-adapter": { kind: "fixture-secret-bin" },
        },
      },
      tasks: [
        { id: "allow-task", adapter: "allow-adapter" },
        { id: "extra-task", adapter: "extra-adapter" },
        { id: "denied-task", adapter: "denied-adapter" },
      ],
    }),
  );
});

afterEach(() => {
  fixture?.cleanup();
});

describe("gateway /chat execute gate (isolated, no sockets)", () => {
  test("a built-in allowlisted kind executes on a loopback bind", () => {
    run("allowlisted-kind");
  });

  test("a kind outside the allowlist is refused and names the config key", () => {
    run("denied-kind");
  });

  test("a kind allowlisted via adapters.chat.executeKinds executes", () => {
    run("config-kind");
  });

  test("HARNESS_CHAT_EXECUTE=1 does not override a denied kind", () => {
    run("env-not-override");
  });

  test("a non-loopback bind refuses execute unless HARNESS_CHAT_ALLOW_REMOTE=1", () => {
    run("remote-bind");
  });

  test("a foreign Origin refuses execute; allowed and absent Origins execute", () => {
    run("origin");
  });

  test("plain stub mode is unaffected by every bind and Origin combination", () => {
    run("stub-modes");
  });

  test("summary pickup is held to the same bind check as execute", () => {
    run("pickup");
  });
});