// OpenCode plugin. OpenCode throws "Plugin export is not a function" for any non-function export,
// so this module exports only `server`; helpers stay private.
import { z } from "zod";
import { AsenqClient } from "../shared/client.js";
import type { Push } from "../shared/protocol.js";
import { zodShape } from "../shared/schema.js";
import { callTool, TOOLS } from "../shared/tools.js";
import type { Hooks, OpencodeEvent, PluginInput, SessionInfo, ToolDefinition } from "./opencode-types.js";

/** ASENQ_NAME names the first session registered in this OpenCode process, across plugin instances. */
let envNameUsed = false;

function eventSessionId(e: OpencodeEvent): string | undefined {
  const p = e.properties ?? {};
  const info = p.info as { id?: unknown } | undefined;
  for (const v of [info?.id, p.sessionID, p.sessionId, p.id]) if (typeof v === "string" && v) return v;
  return undefined;
}

export const server = async (ctx: PluginInput): Promise<Hooks> => {
  const log = (level: "info" | "warn" | "error", message: string): void => {
    ctx.client.app.log({ body: { service: "asenq", level, message } }).catch(() => {});
  };

  /** OpenCode session id → asenq binding. */
  const bound = new Map<string, { id: string; name: string }>();
  const registering = new Map<string, Promise<{ id: string; name: string } | undefined>>();
  const children = new Set<string>();

  const client: AsenqClient = new AsenqClient({
    autoStart: true,
    onPush: (p: Push) => void onPush(p),
    onReconnect: async () => {
      for (const [ocId, b] of bound) {
        const r = await client.request("register", { harness: "opencode", key: ocId, name: b.name, cwd: ctx.directory, caps: ["ping"] });
        const s = r.session as { id: string; name: string };
        bound.set(ocId, s);
      }
    },
  });

  async function onPush(p: Push): Promise<void> {
    if (p.push === "ping") {
      try {
        await client.request("pong", { pingId: p.pingId });
      } catch (e) {
        log("warn", `pong failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    if (p.push !== "deliver") return;
    let ok = false;
    let reason: string | undefined;
    try {
      const result = await ctx.client.session.promptAsync({
        path: { id: p.key },
        body: { parts: [{ type: "text", text: p.text }] },
      });
      ok = !!result && !result.error;
      if (!ok) reason = JSON.stringify(result?.error ?? "no result");
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    try {
      await client.request("ack", { as: p.session, msgId: p.msg.id, ok, reason });
    } catch (e) {
      log("warn", `ack ${p.msg.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function register(ocId: string, info?: SessionInfo): Promise<{ id: string; name: string } | undefined> {
    const existing = bound.get(ocId);
    if (existing) return existing;
    if (children.has(ocId)) return undefined;
    let pending = registering.get(ocId);
    if (!pending) {
      pending = (async () => {
        const meta = info ?? (await ctx.client.session.get({ path: { id: ocId } })).data;
        if (!meta) throw new Error(`OpenCode session ${ocId} not found`);
        if (meta.parentID) {
          children.add(ocId);
          return undefined;
        }
        const name = !envNameUsed && process.env.ASENQ_NAME ? process.env.ASENQ_NAME : undefined;
        if (name) envNameUsed = true;
        const r = await client.request("register", { harness: "opencode", key: ocId, name, cwd: ctx.directory, caps: ["ping"] });
        const s = r.session as { id: string; name: string };
        bound.set(ocId, s);
        log("info", `registered session ${ocId} as ${s.name}`);
        return s;
      })();
      registering.set(ocId, pending);
      pending.finally(() => registering.delete(ocId)).catch(() => {});
    }
    return pending;
  }

  const tools: Record<string, ToolDefinition> = {};
  for (const t of TOOLS) {
    tools[t.name] = {
      description: t.description,
      args: zodShape(z, t.params),
      async execute(args, context) {
        let b: { id: string; name: string } | undefined;
        try {
          b = await register(context.sessionID);
        } catch (e) {
          return `asenq error (no_session): ${e instanceof Error ? e.message : String(e)}`;
        }
        if (!b) return "asenq error (no_session): subagent sessions are not on asenq";
        return callTool(client, t.name, args, b.id);
      },
    };
  }

  return {
    tool: tools,
    async event({ event }) {
      try {
        const id = eventSessionId(event);
        if (!id) return;
        if (event.type === "session.created") {
          await register(id, event.properties?.info as SessionInfo | undefined);
        } else if (event.type === "session.deleted") {
          const b = bound.get(id);
          bound.delete(id);
          children.delete(id);
          if (b) await client.request("unregister", { as: b.id });
        } else if (event.type === "session.status") {
          const b = await register(id);
          if (!b) return;
          const status = event.properties?.status as { type?: unknown } | undefined;
          const busy = status?.type === "busy" ? true : status?.type === "idle" ? false : null;
          await client.request("session_status", { as: b.id, busy });
        } else if (event.type === "session.updated" && !bound.has(id) && !children.has(id)) {
          await register(id);
        }
      } catch (e) {
        log("warn", `event ${event.type}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    async dispose() {
      client.close();
    },
  };
};
