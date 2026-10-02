import { strict as assert } from "node:assert";
import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";

const [mode, home, cwd] = process.argv.slice(2);
assert.equal(process.env.HOME, home);
assert.equal(process.cwd(), cwd);

const REPO = new URL("../../", import.meta.url);
const CHAT_HTML = readFileSync(new URL("src/static/chat.html", REPO), "utf8");
const README = readFileSync(new URL("README.md", REPO), "utf8");
const GATEWAY_SOURCE = readFileSync(new URL("src/gateway.ts", REPO), "utf8");

// Mirrored from src/gateway.ts; keep the two in step.
const REQUEST_MAX_BYTES = 256 * 1024;

const { STATE_DIR, LAST_INGRESS_FILE, INGRESS_QUEUE_FILE } = await import("../../src/shared.ts");

let detail: Record<string, unknown>;

if (mode === "server") {
  // Plan 032 option (b): the contract is a bodiless 413 from the HTTP server,
  // not the handler's JSON envelope. This drives a real `Bun.serve` over a
  // loopback socket on an ephemeral port — the only way to observe the layer
  // that actually answers, which is the one the README now describes.
  const quiet = console.error;
  console.error = () => {};
  process.env.HARNESS_GATEWAY_HOST = "127.0.0.1";
  process.env.HARNESS_GATEWAY_PORT = "0";
  const { startGatewayServer } = await import("../../src/gateway.ts");
  const server = startGatewayServer();
  console.error = quiet;
  // Bun reports the port it actually bound, which is optional until the
  // listener is up; an absent one is not a port.
  const port = server.port ?? 0;
  assert(port > 0, "expected an ephemeral port");

  const raw = (head: string, body: string) =>
    new Promise<string>((resolve) => {
      let out = "";
      const socket = connect({ host: "127.0.0.1", port }, () => socket.write(head + body));
      // A 413 arrives with no body and the peer keeps the connection open, so
      // the backstop is the only exit; clearing it keeps the runner's event
      // loop empty.
      const backstop = setTimeout(() => { socket.destroy(); resolve(out); }, 2_000);
      const finish = () => { clearTimeout(backstop); socket.destroy(); resolve(out); };
      socket.on("data", (d) => { out += d.toString("utf8"); });
      socket.on("close", finish);
      socket.on("error", finish);
    });

  function chunked(text: string) {
    let out = "";
    for (let i = 0; i < text.length; i += 8192) {
      const piece = text.slice(i, i + 8192);
      out += `${piece.length.toString(16)}\r\n${piece}\r\n`;
    }
    return `${out}0\r\n\r\n`;
  }
  const CHUNKED_HEAD =
    "POST /chat HTTP/1.1\r\nHost: localhost\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n";

  // The plan's own reproduction: a >256 KB POST with a declared Content-Length,
  // which is the path every ordinary fetch and `curl -d @file` takes.
  const payload = JSON.stringify({ text: "x".repeat(REQUEST_MAX_BYTES * 2) });
  assert(Buffer.byteLength(payload, "utf8") > REQUEST_MAX_BYTES, "the fixture must be oversize");
  const declared = await raw(
    `POST /chat HTTP/1.1\r\nHost: localhost\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`,
    payload,
  );
  const [statusLine, ...rest] = declared.split("\r\n");
  assert.match(statusLine!, /^HTTP\/1\.1 413/, "a declared oversize is a 413");

  // Option (b), asserted rather than assumed: the answer is the status and
  // nothing else. No JSON, no content-type, no envelope — which is exactly why
  // `chat.html` used to show an empty bubble.
  const headers = rest.slice(0, rest.indexOf("")).join("\r\n").toLowerCase();
  assert.equal(/content-type/.test(headers), false, "the 413 must not advertise a body: " + headers);
  assert.equal(/request body exceeds/.test(declared), false, "the envelope must not be on the wire");
  const declaredBody = declared.slice(declared.indexOf("\r\n\r\n") + 4);
  assert.equal(declaredBody, "", `the 413 carried a body: ${JSON.stringify(declaredBody.slice(0, 120))}`);

  // The undeclared path answers the same way: `Bun.serve` cuts the stream
  // mid-read rather than letting the handler's counted read answer.
  const chunkedAnswer = await raw(CHUNKED_HEAD, chunked(payload));
  assert.match(chunkedAnswer.split("\r\n")[0]!, /^HTTP\/1\.1 413/, "an undeclared oversize is a 413 too");
  const chunkedBody = chunkedAnswer.slice(chunkedAnswer.indexOf("\r\n\r\n") + 4);
  assert.equal(chunkedBody, "", "the chunked 413 carried a body");

  // Neither refusal wrote anything.
  assert.equal(existsSync(LAST_INGRESS_FILE), false, "an oversize POST wrote an event");
  assert.equal(existsSync(INGRESS_QUEUE_FILE), false, "an oversize POST queued an event");

  // An ordinary request still gets in: the ceiling is a bound, not a block.
  const small = JSON.stringify({ text: "hello" });
  const ordinary = await raw(
    `POST /chat HTTP/1.1\r\nHost: localhost\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(small, "utf8")}\r\n\r\n`,
    small,
  );
  assert.match(ordinary.split("\r\n")[0]!, /^HTTP\/1\.1 200/, "an ordinary POST must still succeed");
  assert.match(ordinary, /stub:/, "and still answer with the stub reply");

  server.stop(true);
  detail = { port, declaredBytes: Buffer.byteLength(payload, "utf8"), declaredBodyBytes: 0 };
} else if (mode === "contract") {
  // README and the wire must agree, checked as text so a future edit that
  // re-promises the envelope fails here rather than in a user's client.
  // The stale sentence is quoted exactly as plan 032 found it.
  const STALE =
    'refused before any of this with **413** and the same `{ "ok": false, "error": "request body exceeds 262144 bytes" }` envelope';
  assert.equal(README.includes(STALE), false, "README must not promise the 413 envelope again");
  // And the truth is stated instead: the server answers, with no body.
  assert.match(README, /no body at all/, "README must say the 413 carries no body");
  assert.match(README, /do not parse the body of a 413/, "README must tell clients to read the status");

  // The ceiling is not weakened to make the promise true.
  assert.match(GATEWAY_SOURCE, /maxRequestBodySize: INGRESS_REQUEST_MAX_BYTES/, "the server ceiling must stay");
  assert.match(GATEWAY_SOURCE, /function payloadTooLarge\(\)/, "the handler's own refusal must stay");
  detail = { promiseRemoved: true, ceilingHeld: true };
} else if (mode === "chat-html") {
  // The half of plan 032 that does not depend on the option chosen: a
  // non-JSON or empty error response must surface a visible error naming the
  // HTTP status, never an empty bubble. The page's own `<script>` is run
  // against a minimal DOM, so this is the shipped file, not a copy of it.
  const script = CHAT_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert(script, "chat.html has no inline script");

  function runPage(fetchImpl: (url: string, init?: unknown) => Promise<unknown>) {
    const bubbles: { className: string; textContent: string }[] = [];
    const make = (id: string) => ({
      id,
      dataset: {} as Record<string, string>,
      value: "",
      className: "",
      textContent: "",
      scrollTop: 0,
      scrollHeight: 0,
      // The page assigns this on the form; the harness then calls it.
      onsubmit: undefined as unknown as (event: unknown) => void | Promise<void>,
      appendChild(child: { className: string; textContent: string }) { bubbles.push(child); },
    });
    const elements: Record<string, ReturnType<typeof make>> = {
      log: make("log"),
      t: make("t"),
      f: make("f"),
    };
    elements.t!.value = "x".repeat(300 * 1024);
    const document = {
      getElementById: (id: string) => elements[id],
      createElement: () => make("div"),
      querySelector: () => make("span"),
    };
    // The page schedules its own polling; the harness drives one submit.
    const run = new Function("document", "fetch", "setInterval", script!);
    run(document, fetchImpl, () => 0);
    return { bubbles, form: elements.f! };
  }

  // A bodiless 413 — the exact answer the server gives for the payload above.
  const bodiless = runPage(async () => ({
    ok: false,
    status: 413,
    json: () => Promise.reject(new Error("Unexpected end of JSON input")),
  }));
  await bodiless.form.onsubmit!({ preventDefault() {} });

  const errors = bodiless.bubbles.filter((b) => b.className.includes("err"));
  assert.equal(errors.length, 1, `expected one error bubble, got ${JSON.stringify(bodiless.bubbles)}`);
  assert.match(errors[0]!.textContent, /HTTP 413/, "the error must name the status: " + errors[0]!.textContent);
  assert.equal(errors[0]!.textContent.includes("undefined"), false, "no undefined in the error");
  // The user's own message is still on screen above it.
  assert.match(bodiless.bubbles[0]!.className, /user/, "the user bubble is still there");

  // A well-formed error envelope is an error too, and says why.
  const enveloped = runPage(async () => ({
    ok: false,
    status: 400,
    json: () => Promise.resolve({ ok: false, error: "invalid JSON" }),
  }));
  await enveloped.form.onsubmit!({ preventDefault() {} });
  const envelopedError = enveloped.bubbles.find((b) => b.className.includes("err"));
  assert(envelopedError, "a 400 envelope must not render as a reply");
  assert.match(envelopedError!.textContent, /HTTP 400/);
  assert.match(envelopedError!.textContent, /invalid JSON/);

  // A 200 with a non-JSON body is surfaced too, rather than reading `undefined`.
  const html200 = runPage(async () => ({
    ok: true,
    status: 200,
    json: () => Promise.reject(new Error("Unexpected token '<'")),
  }));
  await html200.form.onsubmit!({ preventDefault() {} });
  const htmlError = html200.bubbles.find((b) => b.className.includes("err"));
  assert(htmlError, "a non-JSON 200 must not render as a reply");
  assert.match(htmlError!.textContent, /HTTP 200/);

  // A transport failure has no status to name, and says so rather than
  // rendering an empty reply.
  const offline = runPage(async () => { throw new Error("connection refused"); });
  await offline.form.onsubmit!({ preventDefault() {} });
  const offlineError = offline.bubbles.find((b) => b.className.includes("err"));
  assert(offlineError, "a transport failure must not render as a reply");
  assert.match(offlineError!.textContent, /request failed/);

  // The ordinary path is unchanged: a 200 envelope still renders the reply,
  // and nothing is flagged as an error.
  const happy = runPage(async (url: string) =>
    url === "/status"
      ? { json: () => Promise.resolve({ lastEvent: null }) }
      : { ok: true, status: 200, json: () => Promise.resolve({ reply: "stub: hello" }) },
  );
  await happy.form.onsubmit!({ preventDefault() {} });
  const reply = happy.bubbles.find((b) => b.className.includes("asst") && !b.className.includes("err"));
  assert(reply, "the ordinary reply must still render");
  assert.equal(reply!.textContent, "stub: hello");
  assert.equal(happy.bubbles.filter((b) => b.className.includes("err")).length, 0, "no error on the happy path");

  detail = { cases: 5 };
} else {
  throw new Error(`Unknown runner mode: ${mode}`);
}

console.log(JSON.stringify({ ok: true, mode, detail }));