// omp extension. The factory re-runs inside every subagent session; only main sessions join asenq.
import { AsenqClient } from "../shared/client.js";
import type { Push, ResetResult } from "../shared/protocol.js";
import { zodShape, type Zod } from "../shared/schema.js";
import { callTool, isToolError, TOOLS } from "../shared/tools.js";
import type { ExtensionAPI, ExtensionContext } from "./omp-types.js";

/** Tools the model must see directly: inbound messages tell it to reply with asenq_send. */
const ESSENTIAL: Record<string, true> = { asenq_send: true, asenq_list: true };

/** A direct delivery push; `reset` (parent-owned protocol) asks the adapter to compact first. */
type Delivery = Extract<Push, { push: "deliver" }>;

export default function asenq(pi: ExtensionAPI): void {
  let client: AsenqClient | undefined;
  let ctxRef: ExtensionContext | undefined;
  let binding: { id: string; key: string; name: string } | undefined;
  /** One serial delivery chain per bound asenq session; pings bypass it. */
  const chains = new Map<string, Promise<void>>();

  const warn = (message: string): void => {
    try { pi.logger.warn(`asenq: ${message}`); } catch {}
  };

  const setStatus = (): void => {
    try {
      if (ctxRef?.hasUI) ctxRef.ui.setStatus("asenq", binding ? `asenq: ${binding.name}` : undefined);
    } catch {}
  };

  const register = async (key: string, name: string | undefined): Promise<void> => {
    if (!client || !ctxRef) return;
    const r = await client.request("register", { harness: "omp", key, name, cwd: ctxRef.cwd, caps: ["ping", "compact"] });
    const session = r.session as { id: string; name: string };
    binding = { id: session.id, key, name: session.name };
    setStatus();
  };

  const reportStatus = async (ctx: ExtensionContext, busy: boolean): Promise<void> => {
    if (ctx.agent.kind === "sub" || !client || !binding || binding.key !== ctx.sessionManager.getSessionId()) return;
    try {
      await client.request("session_status", { as: binding.id, busy });
    } catch (e) {
      warn(`session_status: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Runs `task` after every delivery already queued for the same bound session. */
  const enqueue = (session: string, task: () => Promise<void>): void => {
    const previous = chains.get(session) ?? Promise.resolve();
    const next = previous.then(task, task);
    chains.set(session, next);
    const done = (): void => {
      if (chains.get(session) === next) chains.delete(session);
    };
    void next.then(done, done);
  };

  /** Ordinary pushes ack after delivery, exactly as before reset support existed. */
  const ackDelivery = (p: Delivery, ok: boolean, reason?: string): void => {
    client?.request("ack", { as: p.session, msgId: p.msg.id, ok, reason })
      .catch((e: unknown) => warn(`ack ${p.msg.id} failed: ${String(e)}`));
  };

  /** Flagged pushes acknowledge receipt before waiting on the queue or compaction. */
  const ackReceipt = (p: Delivery): Promise<boolean> =>
    client!.request("ack", { as: p.session, msgId: p.msg.id, ok: true, reset: "pending", resetAttempt: p.resetAttempt }).then(
      () => true,
      (e: unknown) => {
        warn(`receipt ack ${p.msg.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      },
    );

  /** Reports the finished reset outcome and this adapter's delivery acceptance separately from receipt. */
  const reportReset = (p: Delivery, reset: ResetResult, ok: boolean, reason?: string): void => {
    client?.request("reset_result", { as: p.session, msgId: p.msg.id, reset, resetAttempt: p.resetAttempt, ok, reason })
      .catch((e: unknown) => warn(`reset_result ${p.msg.id} failed: ${String(e)}`));
  };

  /** Compacts (when flagged) then injects, but only for the session this push was queued for. */
  const deliver = async (p: Delivery, target: ExtensionContext | undefined, targetKey: string | undefined, receipt: Promise<boolean> | undefined): Promise<void> => {
    const flagged = receipt !== undefined;
    // Handle receipt rejection at initiation, not only once this task reaches the queue head.
    if (receipt && !await receipt) return;
    // A push is only ever acted on for the binding it arrived under; a session switch must not leak it.
    const current = (): boolean => client !== undefined && target !== undefined && target === ctxRef
      && targetKey === binding?.key && targetKey === p.key && target.sessionManager.getSessionId() === p.key;
    if (!target || !current()) {
      if (flagged) reportReset(p, "failed", false, "session switched before delivery");
      else ackDelivery(p, false, "session switched before delivery");
      return;
    }
    let reset: ResetResult | undefined;
    if (flagged) {
      if (typeof target.compact !== "function") reset = "unsupported";
      else {
        try {
          await target.compact({ suppressContinuation: true });
          reset = "compacted";
        } catch (e) {
          reset = "failed";
          warn(`compact ${p.msg.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Compaction can outlive a session switch; never inject the task into the replacement session.
      if (!current()) {
        reportReset(p, reset ?? "failed", false, "session switched during compaction");
        return;
      }
    }
    let ok = true;
    let reason: string | undefined;
    try {
      pi.sendUserMessage(p.text, { deliverAs: "aside", attribution: "agent" });
    } catch (e) {
      ok = false;
      reason = e instanceof Error ? e.message : String(e);
    }
    if (flagged) reportReset(p, reset ?? "failed", ok, reason);
    else ackDelivery(p, ok, reason);
  };

  const onPush = (p: Push): void => {
    if (!client) return;
    if (p.push === "ping") {
      client.request("pong", { pingId: p.pingId }).catch((e: unknown) => warn(`pong failed: ${String(e)}`));
      return;
    }
    if (p.push !== "deliver") return;
    const target = ctxRef;
    const targetKey = binding?.key;
    // Initiate the receipt ack immediately, ahead of any queued delivery or compaction.
    const receipt = p.reset === "compact" ? ackReceipt(p) : undefined;
    enqueue(p.session, () => deliver(p, target, targetKey, receipt));
  };

  // omp's zod facade implements the string/number/boolean/enum/object subset zodShape uses.
  const z = pi.zod.z as unknown as Zod;
  for (const t of TOOLS) {
    pi.registerTool({
      name: t.name,
      label: t.label,
      description: t.description,
      parameters: pi.zod.z.object(zodShape(z, t.params)),
      defaultInactive: true,
      loadMode: ESSENTIAL[t.name] ? "essential" : "discoverable",
      approval: "read",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        let text: string;
        if (ctx.agent.kind === "sub") text = "asenq is only available in the main session";
        else if (!client || !binding) text = "asenq error (no_session): this omp session is not registered on asenq";
        else text = await callTool(client, t.name, params);
        return { content: [{ type: "text", text }], ...(ctx.agent.kind === "sub" || isToolError(text) ? { isError: true } : {}) };
      },
    });
  }

  pi.on("session_start", async (_e, ctx) => {
    if (ctx.agent.kind === "sub") return;
    ctxRef = ctx;
    try {
      await pi.setActiveTools([...new Set([...pi.getActiveTools(), ...TOOLS.map((t) => t.name)])]);
      client = new AsenqClient({
        autoStart: true,
        // A raw timer that throws takes down the whole omp session; ctx timers contain throws.
        schedule: (fn, ms) => ctxRef?.setTimeout(fn, ms),
        onPush,
        onReconnect: async () => {
          if (binding) await register(binding.key, binding.name);
        },
      });
      await register(ctx.sessionManager.getSessionId(), process.env.ASENQ_NAME);
    } catch (e) {
      warn(`session_start: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  pi.on("session_switch", async (_e, ctx) => {
    if (ctx.agent.kind === "sub" || !client) return;
    ctxRef = ctx;
    try {
      const name = binding?.name;
      if (binding) await client.request("unregister");
      binding = undefined;
      await register(ctx.sessionManager.getSessionId(), name);
    } catch (e) {
      warn(`session_switch: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  pi.on("agent_start", async (_e, ctx) => {
    await reportStatus(ctx, true);
  });

  pi.on("agent_end", async (event, ctx) => {
    await reportStatus(ctx, event.willContinue === true);
  });

  pi.on("session_shutdown", () => {
    client?.close();
    client = undefined;
    binding = undefined;
    ctxRef = undefined;
  });
}
