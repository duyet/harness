import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spyOn } from "bun:test";

const [mode, home, cwd] = process.argv.slice(2);
assert(["success", "nonzero", "null", "dry-run", "unavailable", "unknown"].includes(mode));
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);
const root = dirname(home);
const capture = join(root, "manager-calls.json");
const bin = join(root, "bin");
const herdr = join(bin, "fixture-herdr");
const socket = join(root, "fixture.sock");
const worktreeArgs = ["worktree", "create", "--cwd", cwd, "--branch", "fixture-branch",
  "--base", "fixture-base", "--path", join(root, "worktree"), "--label", "fixture-label", "--no-focus"];
assert.equal(existsSync(capture), false);
mkdirSync(bin);
writeFileSync(capture, "[]");
writeFileSync(socket, "fixture only; not a socket\n");
// Run only this recorder through real spawnSync, never Herdr or a worktree operation.
writeFileSync(herdr, `#!${process.execPath}
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
const capture = ${JSON.stringify(capture)};
const args = process.argv.slice(2);
const calls = JSON.parse(readFileSync(capture, "utf8"));
calls.push(args);
writeFileSync(capture, JSON.stringify(calls));
if (args.length === 1 && args[0] === "--version") {
  console.log("fixture version");
  process.exit(${mode === "unavailable" ? 1 : 0});
}
assert.deepEqual(args, ${JSON.stringify(worktreeArgs)});
assert(${JSON.stringify(["success", "nonzero", "null"].includes(mode))}, "unexpected worktree execution");
console.log("fixture stdout");
console.error("fixture stderr");
${mode === "null" ? 'process.kill(process.pid, "SIGTERM");' : `process.exit(${mode === "nonzero" ? 7 : 0});`}
`, { mode: 0o755 });
process.env.HERDR_BIN_PATH = herdr;
process.env.HERDR_SOCKET = socket;
// No system executables are reachable through PATH, including a background gateway's bun.
process.env.PATH = bin;
function unexpected(name: string): never {
  throw new Error(`Unexpected side effect: ${name}`);
}
spyOn(Bun, "serve").mockImplementation(() => unexpected("Bun.serve"));
spyOn(globalThis, "fetch").mockImplementation(() => unexpected("fetch"));
const { STATE_DIR } = await import("../../src/shared.ts");
assert.equal(STATE_DIR, join(home, ".local", "state", "herdr-harness"));
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
process.argv = [process.execPath, cli, "manager", "spawn",
  mode === "unknown" ? "unknown-task" : "fixture-task", ...(mode === "dry-run" ? [] : ["--execute"])];
await import(cli);
