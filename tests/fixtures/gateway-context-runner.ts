import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spyOn } from "bun:test";

const mode = process.argv[2];
const home = process.argv[3];
const cwd = process.argv[4];

function unexpected(name: string): never {
  throw new Error(`Unexpected side effect: ${name}`);
}

assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);
spyOn(process, "kill").mockImplementation(() => unexpected("process.kill"));
spyOn(Bun, "serve").mockImplementation(() => unexpected("Bun.serve"));

let healthChecks = 0;
spyOn(globalThis, "fetch").mockImplementation(async (input) => {
  assert.equal(mode, "launch");
  assert.equal(String(input), "http://127.0.0.1:8787/health");
  healthChecks++;
  return Response.json({ ok: true });
});

const { STATE_DIR, GATEWAY_PID_FILE, loadConfig } = await import("../../src/shared.ts");
assert.equal(STATE_DIR, join(home, ".local", "state", "herdr-harness"));

if (mode === "launch") {
  assert.equal(existsSync(GATEWAY_PID_FILE), false);
  const bin = join(dirname(home), "bin");
  const capture = join(dirname(home), "gateway-launch.json");
  assert.equal(existsSync(capture), false);
  mkdirSync(bin);
  // The real Node spawn runs only this short-lived recorder, never gateway.ts.
  writeFileSync(join(bin, "bun"), `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  cwd: process.cwd(), args: process.argv.slice(2), home: process.env.HOME,
  tmp: process.env.TMPDIR, herdr: process.env.HERDR_BIN_PATH, pid: process.pid
}));
process.exit(0);
`, { mode: 0o755 });
  process.env.PATH = bin + delimiter + process.env.PATH;
  const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
  process.argv = [process.execPath, cli, "gateway", "start"];
  await import(cli);
  assert.equal(healthChecks, 1);
  const deadline = Date.now() + 5000;
  while (!existsSync(capture) && Date.now() < deadline) await Bun.sleep(10);
  assert(existsSync(capture), "PATH shim did not record the launch");
  const captured = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(captured.cwd, cwd);
  assert.deepEqual(captured.args, [fileURLToPath(new URL("../../src/gateway.ts", import.meta.url))]);
  assert.equal(captured.home, home);
} else if (mode === "route") {
  const gateway = fileURLToPath(new URL("../../src/gateway.ts", import.meta.url));
  const { handleIngress } = await import(gateway);
  const result = handleIngress("chat", { taskId: "fixture-context-task" });
  console.log(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, stateDir: STATE_DIR,
    configPath: loadConfig().path, result }));
  assert.equal(healthChecks, 0);
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}
