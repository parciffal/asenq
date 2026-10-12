export function sortConversations(list) {
  return [...list].sort((a, b) => b.lastActivity - a.lastActivity || a.title.localeCompare(b.title));
}

export function filterConversations(list, query) {
  const needle = query.trim().toLocaleLowerCase();
  return sortConversations(list).filter((item) => `${item.title}\n${item.preview?.text ?? ""}`.toLocaleLowerCase().includes(needle));
}

export function groupByDay(messages) {
  const groups = [];
  for (const message of messages) {
    const date = new Date(message.createdAt);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, date, messages: [] };
      groups.push(group);
    }
    group.messages.push(message);
  }
  return groups;
}

export function statusMark(status) {
  return ({ queued: "⌛", delivered: "✓", replied: "✓✓", held: "HELD", failed: "✗", expired: "✗", rejected: "✗", dropped: "✗", posted: "•" })[status] ?? status;
}

export function awaitingReply(messages, sessionId) {
  const latest = [...messages].reverse().find((message) => !message.channel
    && (message.fromSessionId === sessionId || message.toSessionId === sessionId));
  return Boolean(latest && latest.toSessionId === sessionId && latest.fromSessionId !== sessionId);
}

export function mentionSuggestions(members, prefix) {
  const needle = prefix.replace(/^@/, "").toLocaleLowerCase();
  const names = [...new Set([...members.map((member) => typeof member === "string" ? member : member.name), "orchestrator", "worker"])];
  return [...names.filter((name) => name.toLocaleLowerCase().startsWith(needle) && name !== "all"), "all"];
}
