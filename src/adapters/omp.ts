// omp extension. The factory re-runs inside every subagent session; only main sessions join asenq.
import { AsenqClient } from "../shared/client.js";
import type { Push } from "../shared/protocol.js";
import { zodShape, type Zod } from "../shared/schema.js";
import { callTool, isToolError, TOOLS } from "../shared/tools.js";
import type { ExtensionAPI, ExtensionContext } from "./omp-types.js";

/** Tools the model must see directly: inbound messages tell it to reply with asenq_send. */
const ESSENTIAL: Record<string, true> = { asenq_send: true, asenq_list: true };

export default function asenq(pi: ExtensionAPI): void {
  let client: AsenqClient | undefined;
  let ctxRef: ExtensionContext | undefined;
  let binding: { key: string; name: string } | undefined;

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
    const r = await client.request("register", { harness: "omp", key, name, cwd: ctxRef.cwd });
    binding = { key, name: (r.session as { name: string }).name };
    setStatus();
  };

  const onPush = (p: Push): void => {
    if (p.push !== "deliver" || !client) return;
    let ok = true;
    let reason: string | undefined;
    try {
      pi.sendUserMessage(p.text, { deliverAs: "aside", attribution: "agent" });
    } catch (e) {
      ok = false;
      reason = e instanceof Error ? e.message : String(e);
    }
    client.request("ack", { msgId: p.msg.id, ok, reason }).catch((e: unknown) => warn(`ack failed: ${String(e)}`));
  };

  // omp's zod facade implements the string/number/boolean/enum subset zodShape uses.
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

  pi.on("session_shutdown", () => {
    client?.close();
    client = undefined;
    binding = undefined;
  });
}
