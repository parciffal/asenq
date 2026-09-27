import type { AsenqClient } from "./client.js";
import { AsenqError, KINDS, type SendResult } from "./protocol.js";

export type ParamSpec = {
  type: "string" | "integer" | "boolean";
  description: string;
  optional?: boolean;
  enum?: readonly string[];
  min?: number;
  max?: number;
};

export type ToolSpec = { name: string; label: string; description: string; params: Record<string, ParamSpec> };

const NAMES_HINT = "Session names come from asenq_list.";

export const TOOLS: ToolSpec[] = [
  {
    name: "asenq_send",
    label: "Asenq Send",
    description:
      "Send a text message to another agent session on this machine (Claude Code, OpenCode or omp) through asenq. " +
      "An idle target starts a new turn; a busy target sees it between tool calls. " +
      `${NAMES_HINT} Use "*" to broadcast to every live session, or "human" to reach the user.`,
    params: {
      to: { type: "string", description: 'Target session name, "*" for all live sessions, or "human"' },
      text: { type: "string", description: "Message text" },
      kind: { type: "string", enum: KINDS, optional: true, description: "Message kind: chat, task, result or status" },
      thread: { type: "string", optional: true, description: "Free-form thread label to group related messages" },
      reply_to: { type: "string", optional: true, description: "Id of the message this answers (m_…)" },
      done: { type: "boolean", optional: true, description: "Marks the final message of a task or thread" },
    },
  },
  {
    name: "asenq_list",
    label: "Asenq List",
    description: "List agent sessions registered on asenq (name, harness, working directory). Your own session is marked [you].",
    params: {},
  },
  {
    name: "asenq_inbox",
    label: "Asenq Inbox",
    description: "Show the most recent asenq messages sent to this session, including ones already shown to you.",
    params: {},
  },
  {
    name: "asenq_rename",
    label: "Asenq Rename",
    description: `Rename this session on asenq. Other sessions address you by this name. ${NAMES_HINT}`,
    params: { name: { type: "string", description: "New name: lowercase letters, digits, - and _" } },
  },
  {
    name: "asenq_channel_send",
    label: "Asenq Channel Send",
    description: "Post a message to a named asenq channel. Channels are read on demand and never pushed into sessions.",
    params: {
      channel: { type: "string", description: "Channel name: lowercase letters, digits, - and _" },
      text: { type: "string", description: "Message text" },
    },
  },
  {
    name: "asenq_channel_read",
    label: "Asenq Channel Read",
    description: "Read the most recent messages from an asenq channel, oldest first.",
    params: {
      channel: { type: "string", description: "Channel name" },
      limit: { type: "integer", optional: true, min: 1, max: 100, description: "Number of messages (default 20)" },
    },
  },
  {
    name: "asenq_channel_list",
    label: "Asenq Channel List",
    description: "List asenq channels with message counts.",
    params: {},
  },
];

type Msg = { id: string; from: string; to: string; text: string; createdAt: number; kind?: string; thread?: string };

export function formatSendResults(results: SendResult[]): string {
  if (results.length === 0) return "no live sessions to send to";
  return results.map((r) => `${r.to} ${r.msgId ?? "-"} ${r.status}${r.reason ? ` (${r.reason})` : ""}`).join("\n");
}

function formatMsgs(msgs: Msg[], empty: string): string {
  if (msgs.length === 0) return empty;
  return msgs
    .map((m) => `[${new Date(m.createdAt).toISOString()}] ${m.from} → ${m.to} · ${m.id}${m.kind ? ` · kind=${m.kind}` : ""}${m.thread ? ` · thread=${m.thread}` : ""}\n${m.text}`)
    .join("\n\n");
}

/**
 * Runs one agent tool against the daemon and returns the text shown to the model.
 * `as` selects the caller when one connection hosts several sessions (OpenCode).
 * Failures come back as text starting with `asenq error (code): `.
 */
export async function callTool(client: AsenqClient, name: string, args: Record<string, unknown>, as?: string): Promise<string> {
  const who = as ? { as } : {};
  try {
    switch (name) {
      case "asenq_send": {
        const r = await client.request("send", {
          ...who, to: args.to, text: args.text, kind: args.kind, thread: args.thread, replyTo: args.reply_to, done: args.done,
        });
        return formatSendResults(r.results as SendResult[]);
      }
      case "asenq_list": {
        const r = await client.request("list", who);
        const rows = r.sessions as { name: string; harness: string; cwd: string | null; state: string; you: boolean }[];
        if (rows.length === 0) return "no sessions registered";
        return rows
          .map((s) => `${s.name} (${s.harness}) ${s.cwd ?? ""}${s.state === "live" ? "" : ` [${s.state}]`}${s.you ? " [you]" : ""}`)
          .join("\n");
      }
      case "asenq_inbox": {
        const r = await client.request("inbox", who);
        return formatMsgs(r.messages as Msg[], "no messages");
      }
      case "asenq_rename": {
        const r = await client.request("rename", { ...who, name: args.name });
        return `renamed to ${String(r.name)}`;
      }
      case "asenq_channel_send": {
        const r = await client.request("channel_send", { ...who, channel: args.channel, text: args.text });
        return `posted ${String(r.msgId)} to #${String(args.channel)}`;
      }
      case "asenq_channel_read": {
        const r = await client.request("channel_read", { ...who, channel: args.channel, limit: args.limit });
        return formatMsgs(r.messages as Msg[], `#${String(args.channel)} is empty`);
      }
      case "asenq_channel_list": {
        const r = await client.request("channel_list", who);
        const rows = r.channels as { name: string; count: number; lastAt: number }[];
        if (rows.length === 0) return "no channels";
        return rows.map((c) => `#${c.name} ${c.count} messages, last ${new Date(c.lastAt).toISOString()}`).join("\n");
      }
      default:
        return `asenq error (bad_request): unknown tool ${name}`;
    }
  } catch (e) {
    const code = e instanceof AsenqError ? e.code : "internal";
    return `asenq error (${code}): ${e instanceof Error ? e.message : String(e)}`;
  }
}

export const isToolError = (text: string): boolean => text.startsWith("asenq error (");
