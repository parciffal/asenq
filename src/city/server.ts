import { timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { AsenqError, CONTROL_ACTIONS, INBOUND, KINDS } from "../shared/protocol.js";
import type { HistoryScope, ReadScope, SendOptions } from "../shared/protocol.js";
import type { CityHost, ManageOp } from "./host.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const BODY_MAX = 1024 * 1024;
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
function failure(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AsenqError) {
    const status = error.code === "unknown_target" || error.code === "unknown_channel" || error.code === "no_session" ? 404
      : error.code === "name_taken" ? 409 : error.code === "not_permitted" ? 403 : 400;
    json(res, status, { error: error.code, message });
  } else json(res, 502, { error: "daemon_unavailable", message });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readScope(value: unknown): value is ReadScope {
  return record(value) && (value.scope === "session"
    ? typeof value.sessionId === "string" && !!value.sessionId.trim() && Object.keys(value).every((key) => key === "scope" || key === "sessionId")
    : value.scope === "channel" && typeof value.channel === "string" && !!value.channel.trim()
      && Object.keys(value).every((key) => key === "scope" || key === "channel"));
}

function manageOperation(value: unknown): ManageOp {
  if (!record(value)) throw new AsenqError("bad_request", "management operation is required");
  const strings = (keys: string[]): boolean => keys.every((key) => {
    const field = value[key];
    return typeof field === "string" && !!field.trim();
  });
  let fields: string[];
  let valid: boolean;
  switch (value.op) {
    case "session.rename": fields = ["id", "name"]; valid = strings(fields); break;
    case "session.role":
      fields = ["id", "role"]; valid = strings(["id"]) && (value.role === null || value.role === "orchestrator" || value.role === "worker"); break;
    case "session.inbound":
      fields = ["id", "mode"]; valid = strings(["id"]) && INBOUND.some((mode) => mode === value.mode); break;
    case "session.ping": fields = ["id"]; valid = strings(fields); break;
    case "session.close": fields = ["id", "terminate"]; valid = strings(["id"]) && typeof value.terminate === "boolean"; break;
    case "session.closeStale": fields = []; valid = true; break;
    case "session.replace": fields = ["fromId", "toId"]; valid = strings(fields); break;
    case "session.purge":
      fields = value.all === true ? ["all"] : ["id"]; valid = value.all === true || strings(["id"]); break;
    case "channel.create":
    case "channel.delete": fields = ["name"]; valid = strings(fields); break;
    case "channel.rename": fields = ["name", "to"]; valid = strings(fields); break;
    case "channel.add":
    case "channel.remove": fields = ["name", "id"]; valid = strings(fields); break;
    case "held.release":
    case "held.drop": fields = ["msgId"]; valid = strings(fields); break;
    case "process.kill": fields = ["pid"]; valid = Number.isSafeInteger(value.pid) && (value.pid as number) > 0; break;
    case "read.mark":
      fields = ["scope", "state"]; valid = readScope(value.scope) && (value.state === "read" || value.state === "unread"); break;
    default: throw new AsenqError("bad_request", "unknown management operation");
  }
  if (!valid || Object.keys(value).some((key) => key !== "op" && !fields.includes(key))) {
    throw new AsenqError("bad_request", `invalid parameters for ${value.op}`);
  }
  return value as ManageOp;
}

function sendOptions(value: unknown): SendOptions {
  if (!record(value) || Object.keys(value).some((key) => !["kind", "action", "thread", "replyTo", "done"].includes(key))
    || (value.kind !== undefined && !KINDS.some((kind) => kind === value.kind))
    || (value.action !== undefined && (value.kind !== "control" || !CONTROL_ACTIONS.some((action) => action === value.action)))
    || (value.thread !== undefined && (typeof value.thread !== "string" || value.thread.length > 200))
    || (value.replyTo !== undefined && (typeof value.replyTo !== "string" || value.replyTo.length > 200))
    || (value.done !== undefined && typeof value.done !== "boolean")) {
    throw new AsenqError("bad_request", "invalid send options");
  }
  return value as SendOptions;
}

export type CityServer = { url: string; port: number; close(): Promise<void> };

/** Loopback-only browser transport; the daemon remains the authority for identity and delivery. */
export async function startCityServer(host: CityHost, options: { port: number; token: string; root: string }): Promise<CityServer> {
  const root = resolve(options.root);
  const expectedToken = Buffer.from(options.token);
  const streams = new Set<() => void>();
  let port = options.port;
  const authorized = (token: string | undefined | null): boolean => {
    if (token === undefined || token === null) return false;
    const received = Buffer.from(token);
    return received.length === expectedToken.length && timingSafeEqual(received, expectedToken);
  };

  async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
    if (req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      json(res, 415, { error: "unsupported_media_type" }); return;
    }
    if (req.headers.origin !== `http://127.0.0.1:${port}` && req.headers.origin !== `http://localhost:${port}`) {
      json(res, 403, { error: "forbidden" }); return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > BODY_MAX) { json(res, 413, { error: "too_large" }); req.resume(); return; }
      chunks.push(chunk);
    }
    try {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (record(body)) return body;
    } catch { /* Malformed JSON is a client error, not a daemon failure. */ }
    json(res, 400, { error: "bad_request", message: "JSON object is required" });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      res.writeHead(421); res.end("misdirected"); return;
    }
    const rawPath = (req.url ?? "/").split("?", 1)[0];
    let path: string;
    try { path = decodeURIComponent(rawPath); } catch { res.writeHead(404); res.end(); return; }
    if (!path.startsWith("/") || path.includes("\0")) { res.writeHead(404); res.end(); return; }
    if (!path.startsWith("/api/")) {
      if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }); res.end(); return; }
      const file = resolve(root, "." + (path === "/" ? "/index.html" : path));
      const type = TYPES[extname(file)];
      if (!file.startsWith(root + sep) || !type) { res.writeHead(404); res.end(); return; }
      try {
        const canonical = await realpath(file);
        const canonicalRoot = await realpath(root);
        if (!canonical.startsWith(canonicalRoot + sep)) { res.writeHead(404); res.end(); return; }
        const data = await readFile(canonical);
        if (extname(file) === ".html") res.setHeader("Content-Security-Policy", CSP);
        res.writeHead(200, { "Content-Type": type }); res.end(data);
      } catch { res.writeHead(404); res.end(); }
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    const query = new URL(req.url!, `http://127.0.0.1:${port}`).searchParams;
    const header = req.headers["x-asenq-token"];
    if (!authorized(path === "/api/events" ? query.get("token") : typeof header === "string" ? header : undefined)) {
      json(res, 401, { error: "unauthorized" }); return;
    }
    if (path === "/api/events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
      res.flushHeaders();
      const unsubscribe = host.subscribe(({ event, data }) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const timer = setInterval(() => res.write(": keepalive\n\n"), 15_000);
      const close = (): void => { clearInterval(timer); unsubscribe(); streams.delete(close); res.end(); };
      streams.add(close);
      res.once("close", close);
      return;
    }
    if (path === "/api/history" && req.method === "GET") {
      const scope = query.get("scope");
      const name = query.get(scope === "channel" ? "channel" : "sessionId");
      const before = query.get("before");
      const allowed = ["scope", scope === "channel" ? "channel" : "sessionId", "before"];
      if ((scope !== "channel" && scope !== "session") || !name?.trim()
        || [...query.keys()].some((key) => !allowed.includes(key) || query.getAll(key).length !== 1)
        || (before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before))))) {
        json(res, 400, { error: "bad_request" }); return;
      }
      const target: HistoryScope = scope === "channel" ? { scope, channel: name } : { scope, sessionId: name };
      try { json(res, 200, await host.history(target, before === null ? undefined : Number(before))); }
      catch (error) { failure(res, error); }
      return;
    }
    if (path === "/api/conversations" && req.method === "GET") {
      try { json(res, 200, { conversations: await host.conversations() }); }
      catch (error) { failure(res, error); }
      return;
    }
    if (path === "/api/held" && req.method === "GET") {
      try { json(res, 200, { messages: await host.held() }); }
      catch (error) { failure(res, error); }
      return;
    }
    if (path === "/api/manage" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      try { json(res, 200, { ok: true, ...await host.manage(manageOperation(body)) }); }
      catch (error) { failure(res, error); }
      return;
    }
    if (path === "/api/send" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      if (typeof body.text !== "string" || !body.text.trim()) {
        json(res, 400, { error: "bad_request", message: "text is required" }); return;
      }
      const target = body.target;
      if (!record(target) || !((target.kind === "session" && typeof target.id === "string" && target.id.trim())
        || (target.kind === "channel" && typeof target.name === "string" && target.name.trim()))) {
        json(res, 400, { error: "bad_request", message: "target is required" }); return;
      }
      const destination = target.kind === "session" ? { kind: "session" as const, id: target.id as string } : { kind: "channel" as const, name: target.name as string };
      try {
        if (body.options !== undefined && destination.kind !== "session") throw new AsenqError("bad_request", "options require a session target");
        const options = body.options === undefined ? undefined : sendOptions(body.options);
        json(res, 200, await host.send(destination, body.text, options));
      }
      catch (error) { failure(res, error); }
      return;
    }
    json(res, 404, { error: "not_found" });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent) failure(res, error);
      else res.destroy();
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(options.port, "127.0.0.1", () => { server.removeListener("error", listening.reject); listening.resolve(); });
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("city listener has no TCP address");
  port = address.port;
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}/#token=${options.token}`, port,
    close(): Promise<void> {
      if (!closing) {
        const done = Promise.withResolvers<void>();
        closing = done.promise;
        server.close((error) => error ? done.reject(error) : done.resolve());
        for (const close of streams) close();
        server.closeAllConnections();
      }
      return closing;
    },
  };
}
