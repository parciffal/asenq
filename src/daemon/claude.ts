import net from "node:net";
import { join } from "node:path";

export type Envelope = { replyAddr: string; fromName: string; uuid: string };

/** Percent-encodes every character outside [A-Za-z0-9:_/.-]. */
export function pct(s: string): string {
  return Array.from(new TextEncoder().encode(s), (b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9:_/.\-]/.test(c) ? c : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }).join("");
}

export function replyAddr(replyDir: string, senderId: string): string {
  return "uds:" + pct(join(replyDir, senderId + ".sock"));
}

function sanitizeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/["<>\r\n\u0000-\u001f\u007f]/g, "").trim();
  return Array.from(clean).slice(0, 64).join("");
}

/**
 * One NDJSON line for Claude's messaging socket.
 * Plain: a user message, which Claude injects like its own inbox messages.
 * Envelope (opt-in, private format of Claude 2.1.278–2.1.283): a cross-session message with a reply address.
 */
export function claudeFrame(rendered: string, envelope?: Envelope): string {
  if (!envelope) return JSON.stringify({ type: "user", message: { role: "user", content: rendered } });
  const body = rendered.replaceAll("</cross-session-message", "<\\/cross-session-message");
  const content =
    `<cross-session-message from="${envelope.replyAddr}" from-name="${sanitizeName(envelope.fromName)}">\n` +
    `${body}\n</cross-session-message>`;
  return JSON.stringify({
    msgV: 1, msg_id: envelope.uuid, type: "user", message: { role: "user", content },
    priority: "next", from: envelope.replyAddr,
  });
}

export type SocketResult = "ok" | "dead" | "error";

function socketError(e: unknown): SocketResult {
  const code = e && typeof e === "object" && "code" in e ? e.code : undefined;
  return code === "ENOENT" || code === "ECONNREFUSED" ? "dead" : "error";
}

/** Writes one line, waits 150 ms, closes. Claude writes nothing back. */
export function writeLine(path: string, line: string): Promise<SocketResult> {
  const { promise, resolve } = Promise.withResolvers<SocketResult>();
  const s = net.createConnection(path);
  s.once("error", (e) => { s.destroy(); resolve(socketError(e)); });
  s.once("connect", () => {
    s.write(line + "\n", () => setTimeout(() => { s.end(); resolve("ok"); }, 150));
  });
  return promise;
}

export function probe(path: string): Promise<SocketResult> {
  const { promise, resolve } = Promise.withResolvers<SocketResult>();
  const s = net.createConnection(path);
  s.once("error", (e) => { s.destroy(); resolve(socketError(e)); });
  s.once("connect", () => { s.end(); resolve("ok"); });
  return promise;
}

export type EnvelopeReply = { fromSocket: string; body: string };

/** Extracts the sender socket and body from a `<cross-session-message>` Claude sent to a reply listener. */
export function parseEnvelopeReply(frame: Record<string, unknown>): EnvelopeReply | undefined {
  const message = frame.message as { content?: unknown } | undefined;
  let content = message?.content;
  if (Array.isArray(content)) {
    content = content
      .map((b) => (b && typeof b === "object" && "text" in b && typeof b.text === "string" ? b.text : ""))
      .join("");
  }
  if (typeof content !== "string") return undefined;
  const m = /<cross-session-message\s+from="([^"]*)"[^>]*>\n?([\s\S]*?)\n?<\/cross-session-message>/.exec(content);
  if (!m) return undefined;
  const addr = decodeURIComponent(m[1]);
  if (!addr.startsWith("uds:")) return undefined;
  return { fromSocket: addr.slice(4), body: m[2].replaceAll("<\\/cross-session-message", "</cross-session-message") };
}
