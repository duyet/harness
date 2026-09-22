import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, home, cwd] = process.argv.slice(2);
const MODES = new Set(["mock", "created", "created-no-url", "fail", "no-gh"]);
assert(MODES.has(mode), `bad mode: ${mode}`);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);
const root = dirname(home);
const capture = join(root, "gh-calls.json");
const bin = join(root, "bin");
const payload = join(root, "payload.json");
assert.equal(existsSync(capture), false);
mkdirSync(bin);
writeFileSync(capture, "[]");
writeFileSync(
  payload,
  `${JSON.stringify({
    event_id: "gh-fixture-1",
    project: "harness",
    message: "TypeError: boom",
    culprit: "src/cli.ts",
    level: "error",
  })}\n`,
);
// A `gh` on PATH that only records argv — never a real GitHub call. The
// "no-gh" mode leaves PATH pointing at an empty bin dir instead.
if (mode !== "no-gh") {
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const capture = ${JSON.stringify(capture)};
const args = process.argv.slice(2);
const calls = JSON.parse(readFileSync(capture, "utf8"));
calls.push(args);
writeFileSync(capture, JSON.stringify(calls));
const mode = ${JSON.stringify(mode)};
if (mode === "fail") { console.error("gh: not logged in"); process.exit(4); }
if (args[0] === "issue" && args[1] === "create") {
  if (mode === "created") console.log("https://github.com/duyet/harness/issues/42");
  if (mode === "created-no-url") console.log("issue created");
  process.exit(0);
}
console.error("unexpected fixture-gh args: " + args.join(" "));
process.exit(2);
`,
    { mode: 0o755 },
  );
}
// Only the fixture bin is reachable; no real gh, no other system executables.
process.env.PATH = bin;
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
  ...(mode === "mock" ? [] : ["--execute"]),
];
await import(cli);
