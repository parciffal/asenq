import { timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { AsenqError } from "../shared/protocol.js";
import type { HistoryScope } from "../shared/protocol.js";
import type { CityHost } from "./host.js";

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
    json(res, error.code === "unknown_target" || error.code === "unknown_channel" ? 404 : 400, { error: error.code, message });
  } else json(res, 502, { error: "daemon_unavailable", message });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    if (path === "/api/send" && req.method === "POST") {
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
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { json(res, 400, { error: "bad_request" }); return; }
      if (!record(body) || typeof body.text !== "string" || !body.text.trim()) {
        json(res, 400, { error: "bad_request", message: "text is required" }); return;
      }
      const target = body.target;
      if (!record(target) || !((target.kind === "session" && typeof target.id === "string" && target.id.trim())
        || (target.kind === "channel" && typeof target.name === "string" && target.name.trim()))) {
        json(res, 400, { error: "bad_request", message: "target is required" }); return;
      }
      const destination = target.kind === "session" ? { kind: "session" as const, id: target.id as string } : { kind: "channel" as const, name: target.name as string };
      try { json(res, 200, await host.send(destination, body.text)); }
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
