import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, home, cwd] = process.argv.slice(2);
assert(["tty-stdin", "tty-with-file"].includes(mode), `bad mode: ${mode}`);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);

// Stand in for a terminal. Bun reports isTTY === true only on a real character
// device — a pipe and /dev/null both read as undefined — so this is exactly
// the value the guard has to refuse, and nothing else. The real-pty case is
// covered end to end by the `script` test in issues-stdin-bound.test.ts.
process.stdin.isTTY = true;
assert.equal(process.stdin.isTTY, true);

const event = { event_id: "stdin-guard-1", project: "harness", message: "TypeError: boom", level: "error" };
const argv = [process.execPath, "harness", "issues", "ingest", "--source", "sentry"];

if (mode === "tty-with-file") {
  // The guard is ordered on `!file`, so --file must still work with a terminal
  // attached — otherwise the fix would break the documented file path.
  const root = join(home, ".local", "state");
  mkdirSync(root, { recursive: true });
  const file = join(root, "event.json");
  writeFileSync(file, JSON.stringify(event));
  argv.push("--file", file);
}
process.argv = argv;

// `cmdIssues` is dispatched without being awaited, so it runs on a later
// microtask: the CLI's answer lands after this import returns. Watch for it —
// `printJson` writes through console.log, and the refusal path exits before it
// ever gets there.
let answered = false;
const realLog = console.log;
console.log = (...args: unknown[]) => {
  answered = true;
  realLog(...args);
};

await import("../../src/cli.ts");

// Reaching this line with nothing printed means the process is still parked in
// Bun.stdin.text() with no way out — say so, so the suite fails in half a
// second instead of waiting out a kill timeout.
await new Promise((resolve) => setTimeout(resolve, 500));
if (!answered) {
  console.error("harness-stdin-guard-did-not-answer");
  process.exit(3);
}
process.exit(0);
