import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFixture } from "./helpers.ts";

// Plan 032, option (b) — correct the documentation. `README.md` promised a
// `{ ok:false, error:"request body exceeds …" }` envelope on the 413, but
// `Bun.serve`'s `maxRequestBodySize` runs at the same ceiling and answers
// first, with a status line and no body at all. Measured against Bun 1.4.2 at
// three oversize tiers and both transport shapes (declared `Content-Length`
// and chunked): every one of them is a bodiless 413, and the handler's own
// response is discarded. So the promise was the thing that was wrong.
//
// The `chat.html` half is not optional under either option: a bodiless 413
// must never look like the assistant said nothing.
const RUNNER = new URL("./fixtures/gateway-413-runner.ts", import.meta.url).href;
let fixture: ReturnType<typeof createFixture>;

function run(mode: string): Record<string, unknown> {
  fixture.assertIsolation();
  const result = fixture.runCode(`
    process.argv = [process.execPath, ${JSON.stringify(RUNNER)}, ${JSON.stringify(mode)}, ${JSON.stringify(fixture.home)}, ${JSON.stringify(fixture.cwd)}];
    await import(${JSON.stringify(RUNNER)});
  `);
  expect(result.exit, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const parsed = JSON.parse(result.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.mode).toBe(mode);
  return parsed.detail as Record<string, unknown>;
}

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture?.cleanup();
});

describe("the 413 contract (real server, loopback socket)", () => {
  test("an oversize POST is a bodiless 413 and writes nothing", { timeout: 30_000 }, () => {
    // The plan's reproduction, against a real `Bun.serve` on an ephemeral port.
    // `declaredBodyBytes` is the assertion that matters: the 413 is a status
    // line and nothing else, which is the half of the contract the README
    // used to get wrong.
    const detail = run("server");
    expect(detail.port as number).toBeGreaterThan(0);
    expect(detail.declaredBytes as number).toBeGreaterThan(256 * 1024);
    expect(detail.declaredBodyBytes).toBe(0);
  });

  test("README states the bodiless 413 and no longer promises the envelope", () => {
    expect(run("contract")).toEqual({ promiseRemoved: true, ceilingHeld: true });
  });
});

describe("the chat page never renders a refusal as silence", () => {
  test("a bodiless 413, an error envelope, a non-JSON 200 and a dead socket all surface", () => {
    // The shipped `src/static/chat.html` script, run against a minimal DOM —
    // so this is the file itself, not a copy of its logic. The four refusals
    // each have to produce a visible bubble naming the status; the ordinary
    // 200 must still render its reply and flag nothing.
    expect(run("chat-html").cases).toBe(5);
  });
});