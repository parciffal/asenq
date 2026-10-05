import type { AsenqClient } from "./client.js";
import { AsenqError, CONTROL_ACTIONS, KINDS, type ChannelSummary, type ControlAction, type MsgStatus, type Role, type SendResult, type SessionIdentity, type WireMsg } from "./protocol.js";
import { renderMessageBody } from "./render.js";

export type ParamSpec = {
  description: string;
  optional?: boolean;
  enum?: readonly string[];
  min?: number;
  max?: number;
} & (
  | { type: "string" | "integer" | "boolean" }
  | { type: "object"; properties: Record<string, ParamSpec> }
);

export type ToolSpec = { name: string; label: string; description: string; params: Record<string, ParamSpec> };

const NAMES_HINT = "Session names come from asenq_list.";

export const TOOLS: ToolSpec[] = [
  {
    name: "asenq_send",
    label: "Asenq Send",
    description:
      "Send a message with text, a file reference, or both to another agent session on this machine (Claude Code, OpenCode or omp) through asenq. " +
      "An idle target starts a new turn; a busy target sees it between tool calls. " +
      `${NAMES_HINT} Use "*" to broadcast to every live session, or "human" to reach the user. ` +
      "Prefer a file reference for anything over ~4,000 characters: use an absolute readable regular-file path and a required summary of at most 500 characters. " +
      "The daemon records path, summary, byte size and a send-time SHA-256 snapshot, never copies contents; the receiver reads on demand with the same OS user's permissions. " +
      "Files can change or disappear; use asenq_file_check to compare the current file with the snapshot. " +
      "Control messages carry urgent pause/resume/cancel labels; asenq only delivers them and never changes session state or inbound policy.",
    params: {
      to: { type: "string", description: 'Target session name, "*" for all live sessions, or "human"' },
      text: { type: "string", optional: true, description: "Message text; required unless file is present. Prefer a file reference for anything over ~4,000 characters." },
      file: {
        type: "object", optional: true, description: "On-demand file reference, not an attachment; contents are never copied.",
        properties: {
          path: { type: "string", description: "Absolute path to a readable regular file on this machine, accessible under the same OS user" },
          summary: { type: "string", description: "Required summary of the file, at most 500 characters" },
        },
      },
      kind: { type: "string", enum: KINDS, optional: true, description: "Message kind: chat, task, result, status or control" },
      action: { type: "string", enum: CONTROL_ACTIONS, optional: true, description: "Required for kind=control: pause, resume or cancel. Invalid on other kinds; asenq labels and delivers, but does not enforce the action." },
      thread: { type: "string", optional: true, description: "Free-form thread label to group related messages" },
      reply_to: { type: "string", optional: true, description: "Id of the message this answers (m_…)" },
      done: { type: "boolean", optional: true, description: "Marks the final message of a task or thread" },
    },
  },
  {
    name: "asenq_file_check",
    label: "Asenq File Check",
    description: "Compare a direct message's referenced file with its send-time SHA-256 snapshot. Returns match, changed or missing. Only the retained message's sender or recipient may check it. A match is not a lock: the file can change before or during your read.",
    params: { id: { type: "string", description: "Id of a retained direct message carrying a file reference (m_…)" } },
  },
  {
    name: "asenq_list",
    label: "Asenq List",
    description: "List agent sessions registered on asenq (name, harness, working directory, role). The human can edit any role; an orchestrator can edit roles only for sessions sharing a channel. Roles are informational for message delivery; asenq does not coordinate work. Your own session is marked [you].",
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
    description: `Rename this session on asenq. Messages to former names still reach this identity under its current name. Returns name_taken if another live or reconnecting session holds the new name as its current or former name. ${NAMES_HINT}`,
    params: { name: { type: "string", description: "New name: lowercase letters, digits, - and _" } },
  },
  {
    name: "asenq_set_role",
    label: "Asenq Set Role",
    description:
      "Set a session's role or unset it. Only the human or an orchestrator sharing a channel with the target may edit its role. " +
      "The human assigns initial orchestrator roles; an orchestrator can create a new channel with itself as first member or join an existing channel. Workers and sessions with an unset role cannot edit roles. " +
      "Roles are informational for message delivery; asenq is a messenger, not a coordinator.",
    params: {
      name: { type: "string", description: `Target session name. ${NAMES_HINT}` },
      role: { type: "string", enum: ["orchestrator", "worker", "unset"], description: "Role to assign, or unset to clear it" },
    },
  },
  {
    name: "asenq_channel_create",
    label: "Asenq Channel Create",
    description:
      "Create an asenq channel. The human or an orchestrator may create it; a new channel created by an orchestrator atomically includes that orchestrator as its first member. " +
      "Creating an existing channel is idempotent and does not join it; an orchestrator can use asenq_channel_add with its own name to join. Workers and sessions with an unset role cannot create channels. " +
      "Roles are informational for message delivery; asenq is a messenger, not a coordinator.",
    params: { channel: { type: "string", description: "Channel name: lowercase letters, digits, - and _" } },
  },
  {
    name: "asenq_channel_add",
    label: "Asenq Channel Add",
    description:
      "Add a live session to an existing channel's roster. The human may add anyone; an orchestrator may add itself to any existing channel, or add other sessions only to channels it belongs to. " +
      "Workers and sessions with an unset role cannot edit rosters. An orchestrator joins a new channel by creating it; posting to an unknown channel creates an empty roster, without joining it. " +
      "Roles are informational for message delivery; roster editing permissions do not make asenq a coordinator.",
    params: {
      channel: { type: "string", description: "Existing channel name" },
      name: { type: "string", description: `Live target session name. ${NAMES_HINT}` },
    },
  },
  {
    name: "asenq_channel_remove",
    label: "Asenq Channel Remove",
    description:
      "Remove a member from an existing channel's roster by its current or former name. Only the human or an orchestrator who is a member of that channel may edit it. " +
      "An orchestrator can create a new channel with itself as first member or join an existing channel. Current member names take precedence over former names; ambiguous names are refused. " +
      "Use asenq_channel_members to inspect candidate identities; only the human can remove by identity id. " +
      "Roles are informational for message delivery; asenq is not a coordinator.",
    params: {
      channel: { type: "string", description: "Existing channel name" },
      name: { type: "string", description: "Member's current or former session name" },
    },
  },
  {
    name: "asenq_channel_members",
    label: "Asenq Channel Members",
    description:
      "Read an existing channel's members with their full name, role or unset, raw state and identity id. Reads are unrestricted. " +
      "The human may edit any roster; an orchestrator can create a new channel with itself as first member or join an existing channel, then edit channels it belongs to. Workers and sessions with an unset role cannot edit rosters. " +
      "Roles are informational for message delivery; asenq does not coordinate work.",
    params: { channel: { type: "string", description: "Existing channel name" } },
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
    description: "List asenq channels with message counts, including channels with no posts.",
    params: {},
  },
];

type Msg = { id: string; from: string; to: string; text: string; file?: WireMsg["file"]; createdAt: number; status?: MsgStatus; kind?: string; action?: ControlAction; thread?: string; replyTo?: string; replyToMissing?: boolean };

export function formatSendResults(results: SendResult[]): string {
  if (results.length === 0) return "no live sessions to send to";
  return results.map((r) => `${r.to} ${r.msgId ?? "-"} ${r.status}${r.reason ? ` (${r.reason})` : ""}`).join("\n");
}

function formatMsgs(msgs: Msg[], empty: string): string {
  if (msgs.length === 0) return empty;
  return msgs
    .map((m) => `[${new Date(m.createdAt).toISOString()}] ${m.from} → ${m.to} · ${m.id}${m.status ? ` · status=${m.status}` : ""}${m.kind ? ` · kind=${m.kind}` : ""}${m.action ? ` · action=${m.action}` : ""}${m.thread ? ` · thread=${m.thread}` : ""}${m.replyToMissing ? ` · reply-to=${m.replyTo} (purged message)` : ""}\n${renderMessageBody(m)}`)
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
        const header = `[${new Date(m.createdAt).toISOString()}] ${m.from} → ${m.to} · ${m.id}${m.status ? ` · status=${m.status}` : ""}${m.kind ? ` · kind=${m.kind}` : ""}${m.action ? ` · action=${m.action}` : ""}\n`;
        const body = renderMessageBody(m);
        const visible = text.length - body.length < 16_000 - marker.length ? text : header + body;
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
          ...who, to: args.to, text: args.text, file: args.file, kind: args.kind, action: args.action, thread: args.thread, replyTo: args.reply_to, done: args.done,
        });
        return formatSendResults(r.results as SendResult[]);
      }
      case "asenq_file_check": {
        const r = await client.request("file_check", { ...who, msgId: args.id });
        return String(r.status);
      }
      case "asenq_list": {
        const r = await client.request("list", who);
        const rows = r.sessions as { name: string; harness: string; cwd: string | null; state: string; role: Role | null; you: boolean }[];
        if (rows.length === 0) return "no sessions registered";
        return rows
          .map((s) => `${s.name} (${s.harness}) ${s.cwd ?? ""}${s.role ? ` · role=${s.role}` : ""}${s.state === "live" ? "" : ` [${s.state}]`}${s.you ? " [you]" : ""}`)
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
      case "asenq_set_role": {
        await client.request("set_role", { ...who, name: args.name, role: args.role === "unset" ? null : args.role });
        return `${String(args.name)} role ${String(args.role)}`;
      }
      case "asenq_channel_create": {
        const r = await client.request("channel_create", { ...who, channel: args.channel });
        return `channel #${(r.channel as ChannelSummary).name} ready`;
      }
      case "asenq_channel_add": {
        const r = await client.request("channel_add", { ...who, channel: args.channel, name: args.name });
        return `added ${String(args.name)} to #${(r.channel as ChannelSummary).name}`;
      }
      case "asenq_channel_remove": {
        const r = await client.request("channel_remove", { ...who, channel: args.channel, name: args.name });
        return `removed ${String(args.name)} from #${(r.channel as ChannelSummary).name}`;
      }
      case "asenq_channel_members": {
        const r = await client.request("channel_members", { ...who, channel: args.channel });
        const members = r.members as SessionIdentity[];
        if (members.length === 0) return `#${String(args.channel)} has no members`;
        return members.map((s) => `${s.name} · role=${s.role ?? "unset"} · state=${s.state} · id=${s.id}`).join("\n");
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
        const rows = r.channels as ChannelSummary[];
        if (rows.length === 0) return "no channels";
        return rows.map((c) => `#${c.name} ${c.count} messages, ${c.lastAt === 0 ? "no posts" : `last ${new Date(c.lastAt).toISOString()}`}`).join("\n");
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
