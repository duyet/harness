import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXAMPLE_CONFIG = join(ROOT, "examples", "herdr-config-ctrl-g.toml");
const PLUGIN_TOML = join(ROOT, "herdr-plugin.toml");

let fixture: ReturnType<typeof createFixture>;

beforeEach(() => {
  fixture = createFixture();
  fixture.assertIsolation();
});

afterEach(() => {
  fixture?.cleanup();
});

describe("Ctrl+G install docs wiring", () => {
  test("example config binds ctrl+g to plugin_action harness.resume", () => {
    const toml = readFileSync(EXAMPLE_CONFIG, "utf8");
    expect(toml).toContain('key = "ctrl+g"');
    expect(toml).toContain('type = "plugin_action"');
    expect(toml).toContain('command = "harness.resume"');
  });

  test("herdr-plugin.toml declares the resume action behind harness.resume", () => {
    const toml = readFileSync(PLUGIN_TOML, "utf8");
    // plugin_action targets are <plugin id>.<action id>.
    expect(toml).toContain('id = "harness"');
    expect(toml).toContain('id = "resume"');
    expect(toml).toContain('command = ["bin/harness", "resume"]');
  });

  test("status --json exposes ctrlGHint pointing at the example config", () => {
    const status = JSON.parse(fixture.runCli(["status", "--json"]).stdout);
    expect(status.ok).toBe(true);
    expect(status.ctrlGHint.action).toBe("harness.resume");
    expect(status.ctrlGHint.exampleConfig).toBe(EXAMPLE_CONFIG);
  });

  test("upgrade output points at the example config", () => {
    const result = fixture.runCli(["upgrade"]);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("herdr-config-ctrl-g.toml");
  });
});
