import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  VERSION,
  ROOT,
  STATE_DIR,
  INGRESS_QUEUE_FILE,
  LAST_INGRESS_FILE,
  GATEWAY_META_FILE,
  loadConfig,
  resolveTask,
  gatewayBind,
  lastDelivery,
} from "./shared.ts";
import { ingestErrorEvent } from "./issues.ts";
import {
  CHAT_ALLOW_ORIGIN_ENV,
  CHAT_ALLOW_REMOTE_ENV,
  CHAT_BUILTIN_KINDS,
  CHAT_EXECUTE_KINDS_CONFIG_KEY,
  chatAdapterArgv,
  chatAdapterKind,
  chatEnvEnabled,
  chatExecuteEnabled,
  chatKindAllowed,
  chatTimeoutMs,
  invokeAdapter,
} from "./chat.ts";

const CHAT_HTML = join(ROOT, "src", "static", "chat.html");

export type IngressEvent = {
  at: string;
  source: "matrix" | "telegram" | "chat";
  taskId: string | null;
  text: string | null;
  sender: string | null;
  channel: string | null;
  freeform: boolean;
  route: unknown;
  body: unknown;
  // Set only when the value beside them was capped. An ordinary event carries
  // none of these, so its serialized shape is unchanged from before.
  bodyTruncated?: boolean;
  bodyBytes?: number;
  textTruncated?: boolean;
  textBytes?: number;
  senderTruncated?: boolean;
  senderBytes?: number;
  channelTruncated?: boolean;
  channelBytes?: number;
  taskIdTruncated?: boolean;
  taskIdBytes?: number;
};

// --- ingress state bounds ----------------------------------------------------
// The ingress routes are unauthenticated by design (the /chat execute gate above
// covers only `execute`), so any caller can write to the state directory. Each
// stored event is capped individually and the retained queue carries a byte
// budget on top of its count window. Both thresholds sit far above ordinary
// chat and error payloads: they exist to stop a loop of large POSTs, not to
// trim real reports.
const INGRESS_BODY_MAX_BYTES = 4 * 1024;
const INGRESS_TEXT_MAX_CHARS = 200;
const INGRESS_QUEUE_MAX_EVENTS = 50;
const INGRESS_QUEUE_MAX_BYTES = 2 * 1024 * 1024;

// `sender` is a Matrix user id (`@alice:example.org`) or a Telegram username;
// `channel` is a Matrix room id (`!abc:example.org`) or a Telegram chat id. Both
// are short identifiers a real bridge emits in tens of characters, so 200 chars
// leaves two orders of magnitude of headroom — no genuine envelope is ever
// touched — while stopping a caller writing megabytes through a field that
// exists only to say who spoke and where.
const INGRESS_SENDER_MAX_CHARS = 200;
const INGRESS_CHANNEL_MAX_CHARS = 200;

// `taskId` is a different kind of field and is capped differently on purpose.
// The two above are display values; this one is a *lookup key* — `resolveTask`
// compares it against the task ids in the repo config, so cutting it would make
// a real id silently stop matching and the message would fall through to the
// freeform route instead of the task the sender asked for. The cap is therefore
// set far above any id an operator would actually write (config ids are short
// hand-authored strings) and truncation is expected never to occur; if it ever
// does, `taskIdTruncated` says the id was cut rather than letting the mismatch
// read as an unknown task.
const INGRESS_TASK_ID_MAX_CHARS = 512;

// The caps above bound what is *persisted*; nothing bounds what is *read*, and
// they all run after the body has been buffered and JSON.parse'd in full. This
// is the ceiling on the read: 64x the stored-body cap, set above what a real
// envelope can be — a Matrix/Telegram message with quoting, and a Sentry or
// Bugsink event with a stack trace and a long breadcrumb list, which the error
// routes ingest and bound separately — so a legitimate payload is truncated
// with a visible flag rather than refused, while one hostile POST still has a
// hard stop.
const INGRESS_REQUEST_MAX_BYTES = 256 * 1024;

// The event/response key names a capped field writes. One list, so the shared
// cap helper stays generic and the projection cannot drift from the type.
type CapField = "text" | "sender" | "channel" | "taskId";

type Capped = { value: string | null; truncated?: boolean; bytes?: number };

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// Both state files are rewritten on every request. Writing to a sibling temp
// file and renaming means a crash mid-write can never leave half a JSON
// document behind — same directory, so the rename stays within one filesystem.
function writeJsonAtomic(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

// Above the cap the stored body becomes a prefix of the caller's serialized
// payload. Trimming the parsed object instead would have to guess which keys
// matter, and could yield a structure that still parses as real data.
function capBody(raw: Record<string, unknown>): Pick<IngressEvent, "body" | "bodyTruncated" | "bodyBytes"> {
  const serialized = JSON.stringify(raw);
  const bytes = byteLength(serialized);
  if (bytes <= INGRESS_BODY_MAX_BYTES) return { body: raw };
  const prefix = Buffer.from(serialized, "utf8")
    .subarray(0, INGRESS_BODY_MAX_BYTES)
    // Slicing mid-character would leave a replacement char that reads like
    // corruption rather than a deliberate cut.
    .toString("utf8")
    .replace(/�$/, "");
  return { body: prefix, bodyTruncated: true, bodyBytes: bytes };
}

// The one cap primitive behind every stored ingress string: cut at `maxChars`,
// append an ellipsis, mark the cut and record the original size. At or below
// the threshold it returns the value untouched and no flags, so an ordinary
// event's serialized shape stays byte-identical to before. Callers pick the
// field's flag names back out through `capFlags`, because the same value is
// capped at the normalization boundary but named at the event/projection one.
function capString(value: string | null, maxChars: number): Capped {
  if (value === null || value.length <= maxChars) return { value };
  return { value: `${value.slice(0, maxChars)}…`, truncated: true, bytes: byteLength(value) };
}

// A capped field that is not visibly capped reads as data loss with no
// explanation, so the `<field>Truncated` / `<field>Bytes` pair travels with it
// onto the stored event and into the unauthenticated `/status` projection.
function capFlags<F extends CapField>(
  capped: Capped,
  field: F,
): Partial<Record<`${F}Truncated` | `${F}Bytes`, boolean | number>> {
  if (!capped.truncated) return {};
  return {
    [`${field}Truncated`]: true,
    [`${field}Bytes`]: capped.bytes,
  } as Partial<Record<`${F}Truncated` | `${F}Bytes`, boolean | number>>;
}

// `text` is what the chat page header and `harness summary` display, so it is
// capped on its own: letting the body budget cut it would truncate it at an
// arbitrary offset chosen by key order. Kept as a named wrapper because the
// event construction site and the projection both refer to it by name.
function capText(text: string | null): Pick<IngressEvent, "text" | "textTruncated" | "textBytes"> {
  const capped = capString(text, INGRESS_TEXT_MAX_CHARS);
  if (!capped.truncated) return { text: capped.value };
  return { text: capped.value, textTruncated: true, textBytes: capped.bytes };
}

// Count window first, then the byte budget, so a burst of large events cannot
// accumulate even while it is under 50 events. The newest event is always kept:
// `last-ingress.json` and `/status` describe it, and dropping it would let the
// budget silently swallow the event that was just accepted.
function trimQueue(queue: IngressEvent[]): IngressEvent[] {
  const recent = queue.slice(-INGRESS_QUEUE_MAX_EVENTS);
  const kept: IngressEvent[] = [];
  let bytes = 2; // the "[\n" / "\n]\n" wrapper of the pretty-printed array
  for (let i = recent.length - 1; i >= 0; i--) {
    const event = recent[i]!;
    const size = byteLength(`${JSON.stringify(event, null, 2)}\n`) + 1; // + separating comma
    if (kept.length > 0 && bytes + size > INGRESS_QUEUE_MAX_BYTES) break;
    kept.push(event);
    bytes += size;
  }
  return kept.reverse();
}

function persistIngress(event: IngressEvent) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(LAST_INGRESS_FILE, event);
  const queue = readJsonFile<IngressEvent[]>(INGRESS_QUEUE_FILE, []);
  queue.push(event);
  const trimmed = trimQueue(queue);
  writeJsonAtomic(INGRESS_QUEUE_FILE, trimmed);
  return { last: event, queued: trimmed.length };
}

// Every source of a taskId passes through the cap here rather than at the event
// construction site, so no normalization path can be a bypass. The two direct
// branches copy caller-supplied strings; the regex branch is bounded too, even
// though it only ever scans `[a-zA-Z0-9_.:-]+` out of `text` — `text` reaches
// this function uncapped (capping it is the event construction's job), so the
// match is bounded only by the request-size ceiling and could otherwise store a
// quarter-megabyte "task id".
function extractTaskId(raw: Record<string, unknown>, text: string | null): Capped {
  if (typeof raw.taskId === "string" && raw.taskId) {
    return capString(raw.taskId, INGRESS_TASK_ID_MAX_CHARS);
  }
  if (typeof raw.task_id === "string" && raw.task_id) {
    return capString(raw.task_id, INGRESS_TASK_ID_MAX_CHARS);
  }
  if (!text) return { value: null };
  const m = text.match(/(?:task:|\/run)\s*([a-zA-Z0-9_.:-]+)/i);
  return capString(m?.[1] ?? null, INGRESS_TASK_ID_MAX_CHARS);
}

function normalizeMatrix(raw: Record<string, unknown>) {
  const content = (raw.content as Record<string, unknown> | undefined) ?? {};
  const text =
    (typeof content.body === "string" && content.body) ||
    (typeof raw.body === "string" && raw.body) ||
    null;
  return {
    text,
    sender: capString(typeof raw.sender === "string" ? raw.sender : null, INGRESS_SENDER_MAX_CHARS),
    channel: capString(typeof raw.room_id === "string" ? raw.room_id : null, INGRESS_CHANNEL_MAX_CHARS),
    taskId: extractTaskId(raw, text),
  };
}

function normalizeTelegram(raw: Record<string, unknown>) {
  const message = (raw.message as Record<string, unknown> | undefined) ?? raw;
  const chat = (message.chat as Record<string, unknown> | undefined) ?? {};
  const from = (message.from as Record<string, unknown> | undefined) ?? {};
  const text =
    (typeof message.text === "string" && message.text) ||
    (typeof raw.text === "string" && raw.text) ||
    null;
  const sender =
    (typeof from.username === "string" && from.username) ||
    (from.id != null && String(from.id)) ||
    null;
  const channel = chat.id != null ? String(chat.id) : null;
  const nested = { ...raw, ...message };
  return {
    text,
    sender: capString(sender, INGRESS_SENDER_MAX_CHARS),
    channel: capString(channel, INGRESS_CHANNEL_MAX_CHARS),
    taskId: extractTaskId(nested, text),
  };
}

// `sender` and `channel` are fixed literals here, so they are bounded by
// construction; only the taskId can carry caller input.
function normalizeChat(raw: Record<string, unknown>) {
  const text = typeof raw.text === "string" ? raw.text : typeof raw.body === "string" ? raw.body : null;
  return {
    text,
    sender: capString("chat-ui", INGRESS_SENDER_MAX_CHARS),
    channel: capString("local", INGRESS_CHANNEL_MAX_CHARS),
    taskId: extractTaskId(raw, text),
  };
}

export function handleIngress(source: "matrix" | "telegram" | "chat", raw: Record<string, unknown>) {
  const norm =
    source === "matrix"
      ? normalizeMatrix(raw)
      : source === "telegram"
        ? normalizeTelegram(raw)
        : normalizeChat(raw);
  const { config } = loadConfig();
  const defaultAdapter = config?.adapters?.default ?? config?.agent ?? "grok-build";
  let route: ReturnType<typeof resolveTask> | { error: string; defaultAdapter: string; freeform: true };
  let freeform = false;
  if (norm.taskId.value) {
    const resolved = resolveTask(norm.taskId.value);
    if (resolved.error) {
      freeform = true;
      route = { error: resolved.error, defaultAdapter, freeform: true };
    } else {
      route = resolved;
    }
  } else {
    freeform = true;
    route = { error: "freeform intent", defaultAdapter, freeform: true };
  }

  const event: IngressEvent = {
    at: new Date().toISOString(),
    source,
    taskId: norm.taskId.value,
    ...capText(norm.text),
    sender: norm.sender.value,
    channel: norm.channel.value,
    freeform,
    route,
    ...capBody(raw),
    // The values above were already capped by their normalizer; these carry the
    // flags that make a capped field visibly capped rather than quietly short.
    ...capFlags(norm.taskId, "taskId"),
    ...capFlags(norm.sender, "sender"),
    ...capFlags(norm.channel, "channel"),
  };
  const saved = persistIngress(event);
  const adapterId =
    !freeform && "adapterId" in route ? route.adapterId : defaultAdapter;
  const routeObj = !freeform && "route" in route ? route.route : null;

  return {
    ok: true,
    source,
    queued: saved.queued,
    task: {
      id: norm.taskId.value,
      text: norm.text,
      sender: norm.sender.value,
      channel: norm.channel.value,
      adapterId,
      freeform,
    },
    route: routeObj,
    lastEvent: event.at,
  };
}

function stubReply(result: ReturnType<typeof handleIngress>): string {
  const t = result.task;
  if (t.freeform) {
    return `stub: freeform via ${t.adapterId} — ${t.text ?? "(empty)"}`;
  }
  const kind = result.route && typeof result.route === "object" && "kind" in result.route
    ? String((result.route as { kind?: string }).kind)
    : t.adapterId;
  return `stub: routed task ${t.id} → adapter ${t.adapterId} (${kind}). No LLM.`;
}

// --- /chat execute gate ------------------------------------------------------
// Reaching POST /chat means reaching the harness's ability to spawn processes:
// the endpoint is unauthenticated by design and takes the binary name from the
// repo config. Execution therefore needs all three of an allowlisted route
// kind, a loopback bind (unless HARNESS_CHAT_ALLOW_REMOTE=1) and a browser
// Origin that is absent or listed in HARNESS_CHAT_ALLOW_ORIGIN. Ingress without
// `execute` is untouched by any of this.

const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1", "0:0:0:0:0:0:0:1"]);

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|]$/g, "");
  if (LOOPBACK_HOSTNAMES.has(h)) return true;
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  const octets = /^127(?:\.\d{1,3}){3}$/.exec(h)?.[0].split(".") ?? [];
  return octets.length === 4 && octets.every((o) => Number(o) <= 255);
}

// Absent Origin (curl, a local script) is fine — this is a browser
// cross-origin guard, not authentication, and it adds no CORS headers.
export function chatOriginAllowed(origin: string | null): boolean {
  if (!origin) return true;
  const allowed = (process.env[CHAT_ALLOW_ORIGIN_ENV] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin.trim());
}

type ExecuteGate = { allowed: true } | { allowed: false; error: string };

function chatExecuteGate(
  result: ReturnType<typeof handleIngress>,
  req: Request,
  bind: ReturnType<typeof gatewayBind>,
): ExecuteGate {
  if (!isLoopbackHostname(bind.hostname) && !chatEnvEnabled(CHAT_ALLOW_REMOTE_ENV)) {
    return {
      allowed: false,
      error:
        `execute refused: bind ${bind.hostname} is not a loopback address. ` +
        `/chat is unauthenticated by design and must not be exposed to an untrusted network — ` +
        `bind loopback with HARNESS_GATEWAY_HOST, or set ${CHAT_ALLOW_REMOTE_ENV}=1 to opt in.`,
    };
  }
  const origin = req.headers.get("origin");
  if (!chatOriginAllowed(origin)) {
    return {
      allowed: false,
      error:
        `execute refused: Origin ${origin} is not allowed. /chat is unauthenticated ` +
        `by design and must not be exposed to an untrusted network — list the page origin ` +
        `in ${CHAT_ALLOW_ORIGIN_ENV}, or call /chat without an Origin header.`,
    };
  }
  const kind = chatAdapterKind(result.task.adapterId, result.route);
  if (!chatKindAllowed(kind, loadConfig().config)) {
    return {
      allowed: false,
      error:
        `execute refused: route kind "${kind}" is not in the execute allowlist ` +
        `(built-in: ${CHAT_BUILTIN_KINDS.join(", ")}). Add "${kind}" to ` +
        `"${CHAT_EXECUTE_KINDS_CONFIG_KEY}" in .herdr-harness.json to allow it.`,
    };
  }
  return { allowed: true };
}

// /chat replies: stub by default; with `"execute": true` in the body or
// HARNESS_CHAT_EXECUTE=1 the resolved adapter CLI runs as a short bounded
// subprocess — but only if the execute gate above allows it. Any gate refusal
// or invoke failure still returns ok:true with mode:"stub" and an executeError
// field — the chat endpoint never hangs or 500s on adapters.
async function chatReply(
  result: ReturnType<typeof handleIngress>,
  raw: Record<string, unknown>,
  req: Request,
  bind: ReturnType<typeof gatewayBind>,
) {
  const adapterId = result.task.adapterId;
  if (!chatExecuteEnabled(raw)) {
    return { mode: "stub" as const, reply: stubReply(result), adapterId };
  }
  const gate = chatExecuteGate(result, req, bind);
  if (!gate.allowed) {
    // Same stub shape as an adapter failure, but nothing was spawned: no
    // `execute` detail object, only executeError naming the missing opt-in.
    return {
      mode: "stub" as const,
      reply: stubReply(result),
      adapterId,
      executeError: gate.error,
    };
  }
  const prompt =
    result.task.text ?? (result.task.id ? `task: ${result.task.id}` : "");
  const command = chatAdapterArgv(adapterId, result.route, prompt);
  const timeoutMs = chatTimeoutMs();
  const invoked = await invokeAdapter(command, timeoutMs);
  const execute = {
    command,
    timeoutMs,
    status: invoked.status,
    timedOut: invoked.timedOut,
    durationMs: invoked.durationMs,
  };
  if (invoked.ok) {
    return {
      mode: "executed" as const,
      reply: invoked.stdout || "(adapter exited 0 with no output)",
      adapterId,
      execute,
    };
  }
  return {
    mode: "stub" as const,
    reply: stubReply(result),
    adapterId,
    executeError: invoked.error ?? "adapter invoke failed",
    execute,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Summary pickup is opt-in per request: body `"pickup": true` (or "1"/"true"),
// a `?pickup=true|1` query flag, or the literal text `/summary`. Only stub
// replies are amended, so executed adapter replies stay untouched.
function chatPickupRequested(
  raw: Record<string, unknown>,
  url: URL,
  text: string | null,
): boolean {
  const flag = raw.pickup === true || raw.pickup === "true" || raw.pickup === "1";
  const query = url.searchParams.get("pickup");
  return flag || query === "true" || query === "1" || (text ?? "").trim() === "/summary";
}

type ParsedBody =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response };

function payloadTooLarge(): Response {
  return Response.json(
    { ok: false, error: `request body exceeds ${INGRESS_REQUEST_MAX_BYTES} bytes` },
    { status: 413 },
  );
}

// Read the body under a byte ceiling, abandoning the stream the moment the
// budget is blown rather than draining the rest of it. `req.json()` would
// buffer the whole payload first, which is exactly the allocation this bounds;
// `maxRequestBodySize` on `Bun.serve` is the outer layer of the same defense.
async function readBoundedText(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const stream = req.body;
  if (!stream) return { ok: true, text: "" };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

// Three layers bound one unauthenticated request, and none of them is the
// guarantee on its own: the Content-Length precheck here is a fast path that
// refuses a truthful oversized request without reading it, the counted read
// below is what actually bounds memory (a client may omit the header or lie
// about it), and `Bun.serve`'s `maxRequestBodySize` rejects declared oversize
// before the handler is entered at all.
async function parseJsonObject(req: Request): Promise<ParsedBody> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > INGRESS_REQUEST_MAX_BYTES) {
    return { ok: false, response: payloadTooLarge() };
  }
  const read = await readBoundedText(req, INGRESS_REQUEST_MAX_BYTES);
  if (!read.ok) return { ok: false, response: payloadTooLarge() };

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { ok: false, response: Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }) };
  }
  if (!isRecord(parsed)) {
    return { ok: false, response: Response.json({ ok: false, error: "expected JSON object" }, { status: 400 }) };
  }
  return { ok: true, body: parsed };
}

function recordOr(
  value: unknown,
  missing: Record<string, unknown>,
): Record<string, unknown> | null {
  if (value == null) return missing;
  return isRecord(value) ? value : null;
}

function matrixShape(raw: Record<string, unknown>): boolean {
  return recordOr(raw.content, {}) !== null;
}

function telegramShape(raw: Record<string, unknown>): boolean {
  const message = recordOr(raw.message, raw);
  if (!message) return false;
  return recordOr(message.chat, {}) !== null && recordOr(message.from, {}) !== null;
}

function badPayload(): Response {
  return Response.json({ ok: false, error: "invalid payload shape" }, { status: 400 });
}

function chatPage(): Response {
  const html = existsSync(CHAT_HTML)
    ? readFileSync(CHAT_HTML, "utf8")
    : "<!doctype html><title>Harness chat</title><p>missing src/static/chat.html</p>";
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function lastIngress(): IngressEvent | null {
  return readJsonFile<IngressEvent | null>(LAST_INGRESS_FILE, null);
}

// `/status` is unauthenticated, so it answers with a projection instead of the
// stored event: every field the chat page reads (`at`, `source`, `taskId`,
// `text`), enough routing context to see what arrived, and the truncation flags
// so a capped payload is visibly capped rather than quietly short. Operators who
// need the whole event read it locally via `harness summary --json`, which is
// served from disk and is not exposed on this route.
function projectEvent(event: IngressEvent | null): Record<string, unknown> | null {
  if (!event) return null;
  const projection: Record<string, unknown> = {
    at: event.at,
    source: event.source,
    taskId: event.taskId,
    channel: event.channel,
    sender: event.sender,
    freeform: event.freeform,
    text: event.text,
  };
  if (event.textTruncated) {
    projection.textTruncated = true;
    projection.textBytes = event.textBytes;
  }
  if (event.bodyTruncated) {
    projection.bodyTruncated = true;
    projection.bodyBytes = event.bodyBytes;
  }
  if (event.senderTruncated) {
    projection.senderTruncated = true;
    projection.senderBytes = event.senderBytes;
  }
  if (event.channelTruncated) {
    projection.channelTruncated = true;
    projection.channelBytes = event.channelBytes;
  }
  if (event.taskIdTruncated) {
    projection.taskIdTruncated = true;
    projection.taskIdBytes = event.taskIdBytes;
  }
  return projection;
}

export async function handleGatewayRequest(req: Request, bind: ReturnType<typeof gatewayBind>): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/chat")) {
    return chatPage();
  }
  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({ ok: true, service: "harness-gateway", version: VERSION, bind });
  }
  if (req.method === "POST" && url.pathname === "/chat") {
    const parsed = await parseJsonObject(req);
    if (!parsed.ok) return parsed.response;
    const result = handleIngress("chat", parsed.body);
    const reply = await chatReply(result, parsed.body, req, bind);
    const body: Record<string, unknown> = {
      ok: true,
      ...reply,
      task: result.task,
      route: result.route,
      lastEvent: result.lastEvent,
      queued: result.queued,
    };
    if (reply.mode === "stub" && chatPickupRequested(parsed.body, url, result.task.text)) {
      const delivery = lastDelivery();
      body.lastSummary = delivery
        ? { at: delivery.at, path: delivery.summaryPath, excerpt: delivery.excerpt }
        : null;
      if (delivery) {
        body.reply = `${reply.reply}\n\nlast summary (${delivery.at}):\n${delivery.excerpt}`;
      }
    }
    return Response.json(body);
  }
  if (req.method === "GET" && url.pathname === "/status") {
    return Response.json({
      ok: true,
      listening: true,
      version: VERSION,
      bind,
      lastEvent: projectEvent(lastIngress()),
      lastDelivery: lastDelivery(),
    });
  }
  if (req.method === "POST" && url.pathname === "/ingress/matrix") {
    const parsed = await parseJsonObject(req);
    if (!parsed.ok) return parsed.response;
    if (!matrixShape(parsed.body)) return badPayload();
    const result = handleIngress("matrix", parsed.body);
    return Response.json(result, { status: 202 });
  }
  if (req.method === "POST" && url.pathname === "/ingress/telegram") {
    const parsed = await parseJsonObject(req);
    if (!parsed.ok) return parsed.response;
    if (!telegramShape(parsed.body)) return badPayload();
    const result = handleIngress("telegram", parsed.body);
    return Response.json(result, { status: 202 });
  }
  if (req.method === "POST" && url.pathname === "/ingress/sentry") {
    const parsed = await parseJsonObject(req);
    if (!parsed.ok) return parsed.response;
    const draft = ingestErrorEvent("sentry", parsed.body);
    return Response.json({ ok: true, source: "sentry", queued: true, draft }, { status: 202 });
  }
  if (req.method === "POST" && url.pathname === "/ingress/bugsink") {
    const parsed = await parseJsonObject(req);
    if (!parsed.ok) return parsed.response;
    const draft = ingestErrorEvent("bugsink", parsed.body);
    return Response.json({ ok: true, source: "bugsink", queued: true, draft }, { status: 202 });
  }
  return Response.json({ ok: false, error: "not found" }, { status: 404 });
}

export function startGatewayServer() {
  const bind = gatewayBind();
  const server = Bun.serve({
    hostname: bind.hostname,
    port: bind.port,
    // Matches the ceiling parseJsonObject enforces, so a request declaring an
    // oversized body is refused by the server before the handler is reached.
    maxRequestBodySize: INGRESS_REQUEST_MAX_BYTES,
    fetch(req) {
      return handleGatewayRequest(req, bind);
    },
  });
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    GATEWAY_META_FILE,
    `${JSON.stringify({ pid: process.pid, bind: { hostname: server.hostname, port: server.port }, version: VERSION }, null, 2)}\n`,
  );
  console.error(`harness gateway listening on http://${server.hostname}:${server.port}`);
  return server;
}

if (import.meta.main) {
  startGatewayServer();
}
