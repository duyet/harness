import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = join(ROOT, "src", "cli.ts");
const SHARED = new URL("../src/shared.ts", import.meta.url).href;

export function createFixture() {
  const parent = join(ROOT, "dist", ".test-tmp");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "baseline-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  const tmp = join(root, "tmp");
  const env = Object.freeze({
    HOME: home,
    PATH: process.env.PATH || `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    TMPDIR: tmp,
    HERDR_BIN_PATH: join(root, "missing-herdr"),
    HERDR_SOCKET: join(root, "missing-herdr.sock"),
  });
  let cleaned = false;

  function cleanup() {
    rmSync(root, { recursive: true, force: true });
    cleaned = true;
  }

  try {
    for (const path of [home, cwd, tmp]) mkdirSync(path);
  } catch (error) {
    cleanup();
    throw error;
  }

  function run(args: string[], input?: string) {
    assert(!cleaned, "cannot run a cleaned fixture");
    const result = spawnSync(process.execPath, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30000,
      killSignal: "SIGKILL",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      input,
    });
    if (result.error) throw result.error;
    assert.equal(result.signal, null, `child terminated: ${result.signal}\n${result.stderr}`);
    assert.notEqual(result.status, null, "child has no exit status");
    return { stdout: result.stdout, stderr: result.stderr, exit: result.status! };
  }

  function runCode(code: string) {
    return run(["--eval", code]);
  }

  function assertIsolation() {
    const result = runCode(`
      import { STATE_DIR, STATE_FILE } from ${JSON.stringify(SHARED)};
      console.log(JSON.stringify({ stateDir: STATE_DIR, stateFile: STATE_FILE, cwd: process.cwd() }));
    `);
    assert.equal(result.exit, 0, result.stderr);
    const paths = JSON.parse(result.stdout);
    assert.equal(paths.stateDir, join(home, ".local", "state", "herdr-harness"));
    assert.equal(paths.stateFile, join(paths.stateDir, "state.json"));
    assert.equal(paths.cwd, cwd);
    return paths;
  }

  function runCli(args: string[], input?: string) {
    // Check before every CLI invocation, not just an order-dependent smoke test.
    assertIsolation();
    return run([CLI, ...args], input);
  }

  return { root, home, cwd, tmp, env, runCli, runCode, assertIsolation, cleanup };
}
