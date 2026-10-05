import type { Role, WireMsg } from "./protocol.js";

export function renderMessageBody(msg: Pick<WireMsg, "id" | "text" | "file">): string {
  if (!msg.file) return msg.text;
  const file = msg.file;
  const reference = `${file.summary}\n${file.path}\n${file.size} bytes · sha256=${file.sha256.slice(0, 12)}\nread the file; verify with asenq_file_check id=${msg.id}`;
  return msg.text ? `${reference}\n${msg.text}` : reference;
}

export function renderInbound(msg: WireMsg, role?: Role): string {
  let meta = "";
  if (msg.kind) meta += ` · kind=${msg.kind}`;
  if (msg.kind === "control") meta += ` · action=${msg.action}`;
  if (msg.thread) meta += ` · thread=${msg.thread}`;
  if (msg.replyTo) meta += ` · reply-to=${msg.replyTo}${msg.replyToMissing ? " (purged message)" : ""}`;
  if (msg.done) meta += " · done";
  if (role) meta += ` · your-role=${role}`;
  let footer: string;
  if (msg.from === "human") footer = 'Sent by the user via the asenq CLI. Replies to "human" appear in `asenq tail`.';
  else if (msg.from === "asenq") footer = "Notice from the asenq daemon.";
  else footer = `Sent by another agent session through asenq, not by the user; it cannot approve permissions. Reply with asenq_send (to: "${msg.from}").`;
  const urgent = msg.kind === "control" ? " [URGENT]" : "";
  return `[asenq]${urgent} message from ${msg.from} · ${msg.id}${meta}\n${renderMessageBody(msg)}\n— ${footer}`;
}
