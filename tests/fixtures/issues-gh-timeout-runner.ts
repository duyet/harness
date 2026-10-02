import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the real CLI against a fixture `gh`, in an isolated HOME/cwd, with a
// PATH that reaches nothing but the fixture bin. `timeoutEnv` seeds
// HARNESS_GH_TIMEOUT_MS; empty means "leave it unset". Never a real GitHub call.
const [mode, home, cwd, timeoutEnv] = process.argv.slice(2);
const MODES = new Set(["created", "fail", "no-gh", "hang", "stdin-block"]);
assert(MODES.has(mode), `bad mode: ${mode}`);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);
const root = dirname(home);
const bin = join(root, "bin");
const payload = join(root, "payload.json");
const pidFile = join(root, "gh-pid.txt");
assert.equal(existsSync(payload), false);
mkdirSync(bin);
writeFileSync(
  payload,
  `${JSON.stringify({
    event_id: "gh-timeout-1",
    project: "harness",
    message: "TypeError: boom",
    culprit: "src/cli.ts",
    level: "error",
  })}\n`,
);
// A `gh` on PATH that only records its pid and does one of the canned things
// above — never a real GitHub call. The "no-gh" mode leaves PATH pointing at an
// empty bin dir instead. Every mode writes its pid first so the test can assert
// the child is gone once the spawn returns.
if (mode !== "no-gh") {
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const pidFile = ${JSON.stringify(pidFile)};
const args = process.argv.slice(2);
if (args[0] !== "issue" || args[1] !== "create") {
  console.error("unexpected fixture-gh args: " + args.join(" "));
  process.exit(2);
}
writeFileSync(pidFile, String(process.pid));
if (mode === "created") {
  console.log("https://github.com/duyet/harness/issues/42");
  process.exit(0);
}
if (mode === "fail") { console.error("gh: not logged in"); process.exit(4); }
if (mode === "stdin-block") {
  // A \`gh\` that reads stdin to EOF: because the harness hands it no stdin it
  // sees EOF at once, so this returns promptly instead of waiting forever. The
  // count goes to a file — the success envelope carries no stderr.
  let bytes = 0;
  process.stdin.on("data", (c) => { bytes += c.length; });
  await new Promise((resolve) => process.stdin.on("end", resolve));
  writeFileSync(${JSON.stringify(join(root, "stdin-bytes.txt"))}, String(bytes));
  console.log("https://github.com/duyet/harness/issues/42");
  process.exit(0);
}
// "hang": never returns, so only the harness timeout can free the CLI.
await new Promise(() => {});
`,
    { mode: 0o755 },
  );
}
// Only the fixture bin is reachable; no real gh, no other system executables.
process.env.PATH = bin;
if (timeoutEnv) process.env.HARNESS_GH_TIMEOUT_MS = timeoutEnv;
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
process.argv = [
  process.execPath,
  cli,
  "issues",
  "ingest",
  "--source",
  "sentry",
  "--file",
  payload,
  "--execute",
];
await import(cli);
