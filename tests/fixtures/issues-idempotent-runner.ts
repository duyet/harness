import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, home, cwd, event = "a"] = process.argv.slice(2);
const MODES = new Set(["dry-run", "execute", "replay-direct", "replay-gateway"]);
assert(MODES.has(mode), `bad mode: ${mode}`);
assert(event === "a" || event === "b", `bad event: ${event}`);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);

const root = dirname(home);
const capture = join(root, "gh-calls.json");
const bin = join(root, "bin");

// Unlike issues-gh-runner this fixture is reused across several invocations in
// one test: the payload, the recording `gh` and the capture file all persist
// under the fixture root so a replay sees the same event as the first delivery.
mkdirSync(bin, { recursive: true });
if (!existsSync(capture)) writeFileSync(capture, "[]");
writeFileSync(
  join(bin, "gh"),
  `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const capture = ${JSON.stringify(capture)};
const args = process.argv.slice(2);
const calls = JSON.parse(readFileSync(capture, "utf8"));
const n = calls.length;
calls.push(args);
writeFileSync(capture, JSON.stringify(calls));
if (args[0] === "issue" && args[1] === "create") {
  console.log("https://github.com/duyet/harness/issues/" + (42 + n));
  process.exit(0);
}
console.error("unexpected fixture-gh args: " + args.join(" "));
process.exit(2);
`,
  { mode: 0o755 },
);
for (const name of ["a", "b"] as const) {
  writeFileSync(
    join(root, `payload-${name}.json`),
    `${JSON.stringify({
      event_id: `idem-fixture-${name}`,
      project: "harness",
      message: "TypeError: boom",
      culprit: "src/cli.ts",
      level: "error",
    })}\n`,
  );
}
const payload = join(root, `payload-${event}.json`);
const raw = JSON.parse(readFileSync(payload, "utf8"));
// Only the fixture bin is reachable; no real gh, no other system executables.
process.env.PATH = bin;

if (mode === "replay-direct") {
  // The gateway ingress path: ingestErrorEvent in isolation, no CLI.
  const { ingestErrorEvent } = await import("../../src/issues.ts");
  console.log(JSON.stringify({ ok: true, mode, draft: ingestErrorEvent("sentry", raw) }));
} else if (mode === "replay-gateway") {
  const { handleGatewayRequest } = await import("../../src/gateway.ts");
  const response = await handleGatewayRequest(
    new Request("http://localhost/ingress/sentry", {
      method: "POST",
      body: JSON.stringify(raw),
    }),
    { hostname: "127.0.0.1", port: 8787 },
  );
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.ok, true);
  console.log(JSON.stringify({ ok: true, mode, draft: body.draft }));
} else {
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
    ...(mode === "execute" ? ["--execute"] : []),
  ];
  await import(cli);
}
