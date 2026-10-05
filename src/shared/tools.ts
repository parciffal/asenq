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
    description: "Read delivered unread direct messages oldest delivery first, exactly once through plain unread reads, and advance this session's durable inbox delivery position. Held or queued messages become unread only when delivered. Filtered or unread_only=false reads do not advance it. Output is capped at 16,000 characters except explicit full-text id lookup.",
    params: {
      id: { type: "string", optional: true, description: "Recover one full, uncapped sent or received message by id; overrides all other filters and never advances the inbox" },
      limit: { type: "integer", optional: true, min: 1, max: 200, description: "Maximum messages (default 20)" },
      since: { type: "string", optional: true, description: "Exclusive newer-than cursor: ISO timestamp, decimal Unix milliseconds, or retained message id" },
      before: { type: "string", optional: true, description: "Exclusive older-than cursor: ISO timestamp, decimal Unix milliseconds, or retained message id" },
      thread: { type: "string", optional: true, description: "Only messages with this exact thread label" },
      from: { type: "string", optional: true, description: "Only messages from this sender name" },
      unread_only: { type: "boolean", optional: true, description: "Only delivered unread messages (default true); false reads recent history newest creation first" },
    },
  },
  {
    name: "asenq_thread_read",
    label: "Asenq Thread Read",
    description: "Read the full retained direct-message thread involving this caller, sent and received, in durable oldest-first order. Does not advance the inbox position.",
    params: {
      thread: { type: "string", description: "Exact thread label" },
      since: { type: "string", optional: true, description: "Exclusive newer-than cursor: ISO timestamp, decimal Unix milliseconds, or retained message id" },
    },
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

function formatInbox(msgs: Msg[], hasMore: boolean, advancing: boolean): string {
  if (msgs.length === 0) return "no messages";
  const more = (id: string): string => advancing
    ? "[more available; call asenq_inbox again to read the next unread messages.]"
    : `[more available; call asenq_inbox with before=${id} and the same filters for older messages.]`;
  const parts: string[] = [];
  let length = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const text = formatMsgs([m], "");
    const separator = parts.length ? 2 : 0;
    const tail = hasMore || i < msgs.length - 1 ? 2 + more(m.id).length : 0;
    if (length + separator + text.length + tail > 16_000) {
      const compact = "[more available]";
      if (length + separator + text.length + 2 + compact.length <= 16_000) {
        parts.push(text, compact);
        return parts.join("\n\n");
      }
      if (parts.length === 0) {
        const recovery = `Full text: asenq_inbox id=${m.id}.`
          + (m.thread ? " Or use asenq_thread_read with this message's thread." : "");
        const marker = `\n\n[truncated message ${m.id}; more available. ${recovery}]`;
        const header = `[${new Date(m.createdAt).toISOString()}] ${m.from} → ${m.to} · ${m.id}\n`;
        const visible = text.length - m.text.length < 16_000 - marker.length ? text : header + m.text;
        let end = Math.min(visible.length, 16_000 - marker.length);
        if (end > 0 && visible.charCodeAt(end - 1) >= 0xD800 && visible.charCodeAt(end - 1) <= 0xDBFF
          && visible.charCodeAt(end) >= 0xDC00 && visible.charCodeAt(end) <= 0xDFFF) end--;
        return visible.slice(0, end) + marker;
      }
      hasMore = true;
      break;
    }
    parts.push(text);
    length += separator + text.length;
  }
  if (hasMore) parts.push(more(msgs[parts.length - 1].id));
  return parts.join("\n\n");
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
        if (args.id !== undefined) {
          const r = await client.request("inbox", { ...who, msgId: args.id });
          return formatMsgs(r.messages as Msg[], "no messages");
        }
        const unreadOnly = args.unread_only ?? true;
        const r = await client.request("inbox", {
          ...who, limit: args.limit, since: args.since, before: args.before, thread: args.thread,
          from: args.from, unread_only: unreadOnly, max_chars: 15_000,
        });
        const advancing = unreadOnly === true && args.since === undefined && args.before === undefined
          && args.thread === undefined && args.from === undefined;
        return formatInbox(r.messages as Msg[], r.hasMore === true, advancing);
      }
      case "asenq_thread_read": {
        const r = await client.request("thread_read", { ...who, thread: args.thread, since: args.since });
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
