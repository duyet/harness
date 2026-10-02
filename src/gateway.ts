import { mkdirSync, readFileSync, existsSync } from "node:fs";
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
  writeJsonAtomic,
  type AdapterRoute,
  type LastDelivery,
} from "./shared.ts";
import { ingestErrorEvent, type IssueDraft } from "./issues.ts";
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

// The caller-controlled fields `handleIngress` caps, in one list. Every
// truncation flag on the stored event, on `/status` and on the POST responses is
// produced by walking this list (`capFieldFlags`), so a field added to it is
// flagged on every surface at once. That is the shape plan 030 found missing:
// the flags existed for `text` alone, on a response that silently shortened
// `taskId`, `sender` and `channel` in the same object.
const CAPPED_FIELDS = ["text", "sender", "channel", "taskId"] as const;

// The event/response key names a capped field writes. Derived from the list
// above, so the two cannot drift apart.
type CapField = (typeof CAPPED_FIELDS)[number];

// A discriminated pair rather than three independently-optional fields, so a
// `truncated: true` value is statically known to carry its byte count: the flag
// and the number it describes cannot drift apart at any call site.
type Capped =
  | { value: string | null; truncated?: false; bytes?: undefined }
  | { value: string; truncated: true; bytes: number };
type CappedFields = Record<CapField, Capped>;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

// What shape a state file may hold is a per-file question, so it is answered
// per file. The reader could not answer it before, because `null`, `{}`, `[]`
// and `"x"` all survive `JSON.parse` and every one of them escaped the
// fallback that guards a torn or corrupt file.
function isIngressQueue(value: unknown): value is IngressEvent[] {
  return Array.isArray(value);
}

function isIngressEvent(value: unknown): value is IngressEvent {
  return isRecord(value);
}

// The caller states the shape; the reader owns the fallback. The previous
// `as T` asserted the shape without checking it, so a wrong-shaped file
// arrived at the caller's `.push` / `.filter` as the wrong type. This is the
// same check `lastDelivery` and `readStoredDraft` already do beside their own
// parse — it just lives with the fallback too.
function readJsonFile<T>(path: string, fallback: T, isValid: (v: unknown) => v is T): T {
  if (!existsSync(path)) return fallback;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isValid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
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
// onto the stored event, into the unauthenticated `/status` projection, and onto
// the POST response.
// The two key families are kept apart on purpose: the flag is always `true` and
// the count always lands beside it under `<field>Bytes`, so the key remapping
// names one `boolean` and one `number` and a byte count cannot pass as a
// truncation flag at the event site. Typing both as one `boolean | number`
// union is what let that happen before.
type CapFlags = { [K in CapField as `${K}Truncated`]?: boolean } & {
  [K in CapField as `${K}Bytes`]?: number;
};

// The one place a capped field becomes a visible flag, for every surface. It
// walks `CAPPED_FIELDS` rather than taking a field name, so there is no second
// list for the next capped field to be added to and forgotten in — which is
// exactly how three of the four ended up unflagged on the response alone.
// A field below its cap contributes nothing, so an ordinary event serializes
// exactly as it did before any of this existed.
function capFieldFlags(capped: CappedFields): CapFlags {
  const flags: Record<string, boolean | number> = {};
  for (const field of CAPPED_FIELDS) {
    const value = capped[field];
    if (!value.truncated) continue;
    flags[`${field}Truncated`] = true;
    flags[`${field}Bytes`] = value.bytes;
  }
  return flags as CapFlags;
}

// `text` is what the chat page header and `harness summary` display, so it is
// capped on its own: letting the body budget cut it would truncate it at an
// arbitrary offset chosen by key order. This is the *value* half only — the
// task deliberately still carries the whole text, because the adapter prompt and
// the `/summary` pickup key need it — so the response projection re-derives the
// capped value here and takes the flag from `capFieldFlags` beside it.
function capTextValue(text: string | null): Pick<IngressEvent, "text"> {
  return { text: capString(text, INGRESS_TEXT_MAX_CHARS).value };
}

// The bounds above apply to what is *persisted*; nothing bounded what was
// *returned*, so the same value left the process uncapped in the 202 and — on
// `/chat`, which carries the text twice — again inside the stub `reply`. The
// response is the caller's own bytes, so this is not a disclosure; it is that an
// endpoint documented as bounding ingress must not hand back more than it
// stores. The fields a caller correlates an ingest with (id, adapter, route
// decision, sender, channel) all survive, and the cap is the one the event was
// stored under rather than a new one.
function projectTask(result: ReturnType<typeof handleIngress>) {
  // The cap is spread *over* the task rather than beside it, so `text` keeps the
  // position it already held: an ordinary answer then serializes to exactly the
  // bytes it did before this projection existed. The flags are the second
  // spread, and they arrive already named — `capFieldFlags` built them from the
  // one list, so every capped field on this response is flagged, not just the
  // one this function remembers to check.
  return { ...result.task, ...capTextValue(result.task.text), ...result.taskFlags };
}

// `handleIngress` hands the flags back so `projectTask` has the one list to
// apply; the 202 envelope is that same result with the task projected, so the
// flags are consumed here rather than echoed as a second top-level key beside
// the ones they describe.
function ingressResponse(result: ReturnType<typeof handleIngress>): Response {
  const { taskFlags, ...envelope } = result;
  return Response.json({ ...envelope, task: projectTask(result) }, { status: 202 });
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

// Both files are rewritten on every request, so they go through the shared
// atomic writer — the crash-safety reasoning lives with the helper in
// shared.ts now that every state writer uses it.
function persistIngress(event: IngressEvent) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(LAST_INGRESS_FILE, event);
  const queue = readJsonFile<IngressEvent[]>(INGRESS_QUEUE_FILE, [], isIngressQueue);
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
  // `freeform` is false exactly when `route` is a resolved task, so the adapter
  // and the route handed back to the caller are read here, while that is still
  // known. Re-deriving them after the fact with an `"adapterId" in route` guard
  // asks the same question in a form TypeScript cannot narrow to a value, which
  // is how a `string | undefined` adapter id reached the execute gate.
  let adapterId = defaultAdapter;
  let routeObj: AdapterRoute | null = null;
  if (norm.taskId.value) {
    const resolved = resolveTask(norm.taskId.value);
    if (resolved.error) {
      freeform = true;
      route = { error: resolved.error, defaultAdapter, freeform: true };
    } else {
      route = resolved;
      // `resolveTask` states its failure and its success with one object type,
      // so `task` / `adapterId` / `route` come out as independently-optional
      // fields and read as possibly absent even on this branch, where they were
      // returned together. The fallbacks are the ones `resolveTask` itself
      // applies when it builds them: an adapter with no id runs under the config
      // default, and a task with no route has no route. Making the return type a
      // real discriminated pair is the proper fix, and it reaches every caller
      // of `resolveTask`, so it is filed as a follow-up rather than done here.
      adapterId = resolved.adapterId ?? defaultAdapter;
      routeObj = resolved.route ?? null;
    }
  } else {
    freeform = true;
    route = { error: "freeform intent", defaultAdapter, freeform: true };
  }

  // The four caller-controlled values, capped once and in one place, so the
  // event, `/status` and the response all read the same numbers. The three id /
  // sender / channel values arrived already capped from their normalizers;
  // `text` is capped here because it is left uncapped in the task below.
  const capped: CappedFields = {
    text: capString(norm.text, INGRESS_TEXT_MAX_CHARS),
    sender: norm.sender,
    channel: norm.channel,
    taskId: norm.taskId,
  };
  // One flag set, walked from the one list, reused by the response projection.
  const flags = capFieldFlags(capped);

  const event: IngressEvent = {
    at: new Date().toISOString(),
    source,
    taskId: capped.taskId.value,
    text: capped.text.value,
    sender: capped.sender.value,
    channel: capped.channel.value,
    freeform,
    route,
    ...capBody(raw),
    // The values above were already capped; these make a capped field visibly
    // capped rather than quietly short, here and on the way back out.
    ...flags,
  };
  const saved = persistIngress(event);

  return {
    ok: true,
    source,
    queued: saved.queued,
    task: {
      id: capped.taskId.value,
      // The whole text, deliberately: the adapter prompt and the `/summary`
      // pickup key both read it, and neither is a reflection. The response
      // projection caps its copy.
      text: norm.text,
      sender: capped.sender.value,
      channel: capped.channel.value,
      adapterId,
      freeform,
    },
    taskFlags: flags,
    route: routeObj,
    lastEvent: event.at,
  };
}

function stubReply(result: ReturnType<typeof handleIngress>): string {
  // Through the projection, because the freeform branch below interpolates the
  // caller's own text: capping the task alone would still leave the payload a
  // second time in the same response.
  const t = projectTask(result);
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

// The handler's own refusal of its own ceiling. Note what this is *not*: on a
// real `Bun.serve` with the matching `maxRequestBodySize`, this response does
// not reach the wire. Bun refuses a declared oversize at the socket before the
// handler is entered, and cuts the body stream of an undeclared one mid-read,
// answering both with a bare 413 and no body at all — and discarding whatever
// the handler would have returned. So this stays as the honest answer for the
// two paths that do reach it: a direct call to `handleGatewayRequest` (which is
// what the test fixtures make), and a future where the server ceiling is raised
// above this one. `README.md` says so; a client must not parse the body of a
// 413, because there usually is not one.
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

// Real Matrix / Telegram / Sentry payloads nest about ten deep, so 64 is far
// above any real traffic. Past this depth the only thing a request can do is
// blow the engine's call stack in a `JSON.stringify` downstream — `capBody`
// below and the draft body in `buildDraft` both serialize the parsed value —
// which turns a documented 400 into Bun's HTML 500 page. Bounding it at the one
// gate that already owns the request-shape contract fixes all five POST routes
// at once, and reaches `buildDraft` without touching `src/issues.ts`.
const MAX_JSON_DEPTH = 64;

function isContainer(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

// True when `value` nests containers more than `maxDepth` deep. The top-level
// value counts as depth 1, and only objects and arrays count at all: a scalar
// leaf cannot nest further, so counting it would quietly make the documented
// ceiling mean "63 containers" instead of 64.
function exceedsJsonDepth(value: unknown, maxDepth: number): boolean {
  if (!isContainer(value)) return false;
  let frontier: object[] = [value];
  for (let depth = 1; frontier.length > 0; depth += 1) {
    if (depth > maxDepth) return true;
    const next: object[] = [];
    for (const node of frontier) {
      const children: unknown[] = Array.isArray(node) ? node : Object.values(node);
      for (const child of children) {
        if (isContainer(child)) next.push(child);
      }
    }
    frontier = next;
  }
  return false;
}

// Four layers bound one unauthenticated request, and none of them is the
// guarantee on its own: the Content-Length precheck here is a fast path that
// refuses a truthful oversized request without reading it, the counted read
// below is what actually bounds memory (a client may omit the header or lie
// about it), and `Bun.serve`'s `maxRequestBodySize` — the layer that actually
// answers on a real server, before the handler is entered for a declared
// oversize and mid-stream for an undeclared one — is the outer bound. The
// first two are unreachable through `Bun.serve` as configured and are kept as
// the handler's own contract; see `payloadTooLarge`. None of the three bounds
// depth — 80 KB of 40,000 two-byte levels is well under the byte ceiling and
// still serializes into a `RangeError` — so the walk above is the fourth.
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
  // Checked after the top-level shape and before anything serializes: this is
  // the last point where a refusal is still free of side effects.
  if (exceedsJsonDepth(parsed, MAX_JSON_DEPTH)) {
    return { ok: false, response: Response.json({ ok: false, error: "JSON nesting too deep" }, { status: 400 }) };
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
  return readJsonFile<IngressEvent | null>(LAST_INGRESS_FILE, null, isIngressEvent);
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

// `/status` is unauthenticated here too, and the delivery record names three
// absolute paths under the user's home (`summaryPath`, `summaryJsonPath`,
// `deliveryPath`), each embedding the OS username. No HTTP consumer reads them
// — `src/static/chat.html` reads `lastEvent` only — so the projection keeps
// what identifies a delivery and its size, and drops the filesystem layout.
// The excerpt is already capped at 600 characters on write. Operators who need
// the paths read them locally via `harness gateway status --json` or
// `harness summary --json`, which serve the file from disk.
function projectDelivery(delivery: LastDelivery | null): Record<string, unknown> | null {
  if (!delivery) return null;
  return {
    kind: delivery.kind,
    at: delivery.at,
    bytes: delivery.bytes,
    excerpt: delivery.excerpt,
  };
}

// The draft's `id` and `fingerprint` are the caller's own `event_id` verbatim
// (`fingerprintFor` returns one uncapped, deliberately — it is the draft's
// identity), so projecting them unclipped made a 200 KB POST answer with 400 KB.
// Same bound plan 023 applies to the fingerprint where it enters the issue body:
// 500 characters, two orders of magnitude above a real Sentry or Bugsink id.
// Applied here, on the *reflection* only — the value on disk is untouched, so the
// draft keeps its identity and two long ids sharing a 500-char prefix still
// cannot collapse onto one draft.
const ISSUE_DRAFT_ID_MAX_CHARS = 500;

// A shortened value must never read as a real one, so the `<field>Truncated` /
// `<field>Bytes` pair the stored event and `/status` already carry travels onto
// this projection too. Absent below the cap, so an ordinary draft's answer is
// byte-identical to what it was before.
function flagCapped(projection: Record<string, unknown>, field: string, capped: Capped): void {
  if (!capped.truncated) return;
  projection[`${field}Truncated`] = true;
  projection[`${field}Bytes`] = capped.bytes;
}

// `/ingress/sentry` and `/ingress/bugsink` are unauthenticated, so their 202
// answers a projection the way `/status` does — never the draft. Returning the
// whole draft re-served the entire stored payload, which for a large event is
// megabytes echoed straight back to the POSTer. What survives is what a caller
// needs to correlate the ingest and then go read the file.
//
// The rule `projectDelivery` states is applied here too: the projection keeps
// what identifies a delivery and its size, and drops the filesystem layout. So
// there is no `path` — an absolute path under `$HOME`, embedding the OS
// username, on a route documented as unauthenticated. The draft's filename is
// derived from its fingerprint, so every correlation value a caller had before
// is still in the answer, and `harness issues list --json` still reports the
// path to the local operator who can reach the disk anyway.
function projectIssueDraft(draft: IssueDraft): Record<string, unknown> {
  const id = capString(draft.id, ISSUE_DRAFT_ID_MAX_CHARS);
  const fingerprint = capString(draft.fingerprint, ISSUE_DRAFT_ID_MAX_CHARS);
  const projection: Record<string, unknown> = {
    id: id.value,
    fingerprint: fingerprint.value,
    title: draft.title,
    source: draft.source,
    playbook: draft.playbook,
    labels: draft.labels,
    status: draft.status,
    createdAt: draft.createdAt,
  };
  flagCapped(projection, "id", id);
  flagCapped(projection, "fingerprint", fingerprint);
  if (draft.githubIssueUrl) projection.githubIssueUrl = draft.githubIssueUrl;
  if (draft.githubIssueNumber != null) projection.githubIssueNumber = draft.githubIssueNumber;
  if (draft.bodyTruncated) {
    projection.bodyTruncated = true;
    projection.bodyBytes = draft.bodyBytes;
  }
  if (draft.evicted?.length) projection.evicted = draft.evicted;
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
      task: projectTask(result),
      route: result.route,
      lastEvent: result.lastEvent,
      queued: result.queued,
    };
    // Pickup returns stored operator state the caller did not send — unlike a stub
    // reply, which echoes the caller's own text back. Hold it to the same bind
    // condition as execute, so a request the gate refuses is not also handed the
    // report on the same bind. Deliberately not an Origin check: absent Origin has
    // to keep working for curl and for the chat page.
    const pickupAllowed =
      isLoopbackHostname(bind.hostname) || chatEnvEnabled(CHAT_ALLOW_REMOTE_ENV);
    if (
      reply.mode === "stub" &&
      pickupAllowed &&
      chatPickupRequested(parsed.body, url, result.task.text)
    ) {
      const delivery = lastDelivery();
      body.lastSummary = delivery
        ? { at: delivery.at, excerpt: delivery.excerpt }
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
      lastDelivery: projectDelivery(lastDelivery()),
    });
  }
  if (req.method === "POST" && url.pathname === "/ingress/matrix") {
    const parsed = await parseJsonObject(req);
    if (!parsed.ok) return parsed.response;
    if (!matrixShape(parsed.body)) return badPayload();
    const result = handleIngress("matrix", parsed.body);
    return ingressResponse(result);
  }
  if (req.method === "POST" && url.pathname === "/ingress/telegram") {
    const parsed = await parseJsonObject(req);
    if (!parsed.ok) return parsed.response;
    if (!telegramShape(parsed.body)) return badPayload();
    const result = handleIngress("telegram", parsed.body);
    return ingressResponse(result);
  }
  if (req.method === "POST" && url.pathname === "/ingress/sentry") {
    const parsed = await parseJsonObject(req);
    if (!parsed.ok) return parsed.response;
    const draft = ingestErrorEvent("sentry", parsed.body);
    return Response.json({ ok: true, source: "sentry", queued: true, draft: projectIssueDraft(draft) }, { status: 202 });
  }
  if (req.method === "POST" && url.pathname === "/ingress/bugsink") {
    const parsed = await parseJsonObject(req);
    if (!parsed.ok) return parsed.response;
    const draft = ingestErrorEvent("bugsink", parsed.body);
    return Response.json({ ok: true, source: "bugsink", queued: true, draft: projectIssueDraft(draft) }, { status: 202 });
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
  writeJsonAtomic(GATEWAY_META_FILE, {
    pid: process.pid,
    bind: { hostname: server.hostname, port: server.port },
    version: VERSION,
  });
  console.error(`harness gateway listening on http://${server.hostname}:${server.port}`);
  return server;
}

if (import.meta.main) {
  startGatewayServer();
}
