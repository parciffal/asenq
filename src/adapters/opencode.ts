// OpenCode plugin. OpenCode throws "Plugin export is not a function" for any non-function export,
// so this module exports only `server`; helpers stay private.
import { z } from "zod";
import { AsenqClient } from "../shared/client.js";
import type { Push } from "../shared/protocol.js";
import { zodShape } from "../shared/schema.js";
import { callTool, TOOLS } from "../shared/tools.js";
import type { Hooks, OpencodeEvent, OpencodeMessage, PluginInput, SessionInfo, ToolDefinition } from "./opencode-types.js";

/** Wire compaction outcome. Mirrors the daemon's terminal reset results; the plugin never sends `pending` here. */
type ResetResult = "compacted" | "unsupported" | "failed";

/** A deliver push plus the top-level compaction flag the daemon sets only for capable connections. */
type DeliveryPush = { push: "deliver"; msg: { id: string }; text: string; session: string; key: string; reset?: "compact" };

type OpencodeModel = { providerID: string; modelID: string };

/** ASENQ_NAME names the first session registered in this OpenCode process, across plugin instances. */
let envNameUsed = false;

function eventSessionId(e: OpencodeEvent): string | undefined {
  const p = e.properties ?? {};
  const info = p.info as { id?: unknown } | undefined;
  for (const v of [info?.id, p.sessionID, p.sessionId, p.id]) if (typeof v === "string" && v) return v;
  return undefined;
}

/** The model behind a message: the user's nested model or the assistant's top-level provider/model pair. */
function messageModel(info: OpencodeMessage["info"] | undefined): OpencodeModel | undefined {
  if (!info) return undefined;
  if (info.role === "user") {
    const m = info.model;
    return m?.providerID && m.modelID ? { providerID: m.providerID, modelID: m.modelID } : undefined;
  }
  return info.providerID && info.modelID ? { providerID: info.providerID, modelID: info.modelID } : undefined;
}

/** Latest chronological usable model across a target session's messages. */
function latestModel(messages: OpencodeMessage[]): OpencodeModel | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const model = messageModel(messages[i]?.info);
    if (model) return model;
  }
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

  const sdk = ctx.client.session;
  /** Compaction needs both history (to pick a model) and summarize; absent, the cap is not declared. */
  const canCompact = typeof sdk.summarize === "function" && typeof sdk.messages === "function";
  const caps = canCompact ? ["ping", "compact"] : ["ping"];

  /** Per-binding delivery chain: one target's delivery never overlaps or overtakes its own earlier work. */
  const delivering = new Map<string, Promise<void>>();

  function serialize(key: string, task: () => Promise<void>): Promise<void> {
    const run = (delivering.get(key) ?? Promise.resolve()).then(task);
    const tail = run.then(() => undefined, () => undefined);
    delivering.set(key, tail);
    void tail.then(() => { if (delivering.get(key) === tail) delivering.delete(key); });
    return tail;
  }

  const client: AsenqClient = new AsenqClient({
    autoStart: true,
    onPush: (p: Push) => void onPush(p),
    onReconnect: async () => {
      for (const [ocId, b] of bound) {
        const r = await client.request("register", { harness: "opencode", key: ocId, name: b.name, cwd: ctx.directory, caps });
        const s = r.session as { id: string; name: string };
        bound.set(ocId, s);
      }
    },
  });

  /** Compaction outcome for a flagged push; never throws and never suppresses the message. */
  async function compact(key: string): Promise<ResetResult> {
    if (!canCompact) return "unsupported";
    try {
      const listed = await sdk.messages!({ path: { id: key } });
      if (listed.error || !listed.data) return "failed";
      const model = latestModel(listed.data);
      if (!model) return "failed";
      const done = await sdk.summarize!({ path: { id: key }, body: model });
      return !done.error && done.data === true ? "compacted" : "failed";
    } catch (e) {
      log("warn", `compact ${key} failed: ${e instanceof Error ? e.message : String(e)}`);
      return "failed";
    }
  }

  /** Ordinary unflagged delivery: inject the message, then acknowledge the attempt. */
  async function deliver(p: DeliveryPush): Promise<void> {
    const b = bound.get(p.key);
    let ok = false;
    let reason: string | undefined;
    if (!b || b.id !== p.session) {
      reason = "session not registered";
    } else {
      try {
        const result = await sdk.promptAsync({
          path: { id: p.key },
          body: { parts: [{ type: "text", text: p.text }] },
        });
        ok = !!result && !result.error;
        if (!ok) reason = JSON.stringify(result?.error ?? "no result");
      } catch (e) {
        reason = e instanceof Error ? e.message : String(e);
      }
    }
    try {
      await client.request("ack", { as: p.session, msgId: p.msg.id, ok, reason });
    } catch (e) {
      log("warn", `ack ${p.msg.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Flagged delivery: compact the target, then inject, reporting the finished outcome via reset_result. */
  async function deliverCompact(p: DeliveryPush): Promise<void> {
    const b = bound.get(p.key);
    let reset: ResetResult;
    let ok = false;
    let reason: string | undefined;
    if (!b || b.id !== p.session) {
      reset = "failed";
      reason = "session not registered";
    } else {
      reset = await compact(p.key);
      try {
        const result = await sdk.promptAsync({
          path: { id: p.key },
          body: { parts: [{ type: "text", text: p.text }] },
        });
        ok = !!result && !result.error;
        if (!ok) reason = JSON.stringify(result?.error ?? "no result");
      } catch (e) {
        reason = e instanceof Error ? e.message : String(e);
      }
    }
    try {
      await client.request("reset_result", { as: p.session, msgId: p.msg.id, reset, ok, reason });
    } catch (e) {
      log("warn", `reset_result ${p.msg.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

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
    // The daemon may attach the compaction flag to a deliver push; the base protocol type does not model it yet.
    const d = p as DeliveryPush;
    if (d.reset === "compact") {
      // Receipt is acknowledged before joining the queue: a slow compaction must not delay acceptance.
      // The queued task waits for that ack and gives up if the daemon did not accept the message.
      const receipt = client.request("ack", { as: d.session, msgId: d.msg.id, ok: true, reset: "pending" }).then(
        () => true,
        (e: unknown) => {
          log("warn", `ack ${d.msg.id} rejected: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        },
      );
      await serialize(d.key, async () => {
        if (await receipt) await deliverCompact(d);
      });
      return;
    }
    await serialize(d.key, () => deliver(d));
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
        const r = await client.request("register", { harness: "opencode", key: ocId, name, cwd: ctx.directory, caps });
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
