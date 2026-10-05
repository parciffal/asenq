import { parseArgs } from "node:util";
import { lockedPid, runDaemon } from "../daemon/main.js";
import { AsenqClient, ensureDaemon } from "../shared/client.js";
import type { ChannelSummary, ControlAction, ListedSession, SendResult, SessionIdentity, TailEvent } from "../shared/protocol.js";
import { formatSendResults, formatSessions } from "../shared/tools.js";

type LoggedMsg = {
  id: string; from: string; to: string; text: string; createdAt: number;
  kind?: string; action?: ControlAction; thread?: string; replyTo?: string; replyToMissing?: boolean; done?: boolean; status: string; reason?: string; sourceChannel?: string;
};

const out = (s: string): void => void process.stdout.write(s + "\n");
const hhmmss = (t: number): string => new Date(t).toTimeString().slice(0, 8);
const oneLine = (s: string, n: number): string => {
  const flat = s.replace(/\r?\n/g, "⏎");
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
};

function msgLine(m: Omit<LoggedMsg, "status"> & { status?: string; reason?: string }): string {
  const status = m.status ? ` (${m.status}${m.reason ? `: ${m.reason}` : ""})` : "";
  return `${hhmmss(m.createdAt)} ${m.id} ${m.from} → ${m.to}${m.sourceChannel ? ` via #${m.sourceChannel}` : ""}${m.kind ? ` [${m.kind}${m.action ? ` action=${m.action}` : ""}]` : ""}${m.replyToMissing && m.replyTo ? ` reply-to=${m.replyTo} (purged message)` : ""} ${oneLine(m.text, 120)}${status}`;
}

function need(args: string[], n: number, usage: string): void {
  if (args.length < n) throw new Error(`missing arguments\n${usage}`);
}

export async function runCommand(cmd: string, argv: string[], usage: string): Promise<number> {
  if (cmd === "daemon") {
    const sub = argv[0];
    if (sub === "run") {
      await runDaemon();
      return -1;
    }
    if (sub === "status") {
      const pid = lockedPid();
      out(pid ? `running pid ${pid}` : "stopped");
      return 0;
    }
    if (sub === "stop") {
      const pid = lockedPid();
      if (!pid) {
        out("stopped");
        return 0;
      }
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 30 && lockedPid(); i++) await new Promise((r) => setTimeout(r, 100));
      out(lockedPid() ? `pid ${pid} did not stop` : `stopped pid ${pid}`);
      return lockedPid() ? 1 : 0;
    }
    if (sub === "start") {
      if (lockedPid()) {
        out(`running pid ${lockedPid()}`);
        return 0;
      }
      ensureDaemon();
      const client = new AsenqClient({ autoStart: true });
      await client.connect();
      client.close();
      out(`running pid ${lockedPid()}`);
      return 0;
    }
    throw new Error(`usage: asenq daemon run|start|stop|status`);
  }

  const client = new AsenqClient({ autoStart: true });
  try {
    return await runClientCommand(client, cmd, argv, usage);
  } finally {
    if (cmd !== "tail") client.close();
  }
}

async function runClientCommand(client: AsenqClient, cmd: string, argv: string[], usage: string): Promise<number> {
  switch (cmd) {
    case "ls": {
      const { values } = parseArgs({
        args: argv, options: { cwd: { type: "string" }, harness: { type: "string" }, channel: { type: "string" } },
      });
      if (values.harness !== undefined && !["claude", "omp", "opencode"].includes(values.harness)) {
        throw new Error("harness must be claude, omp or opencode");
      }
      const r = await client.request("list", values);
      out(formatSessions(r.sessions as ListedSession[], values.cwd !== undefined || values.harness !== undefined || values.channel !== undefined));
      return 0;
    }
    case "send": {
      const { values, positionals } = parseArgs({
        args: argv, allowPositionals: true,
        options: { kind: { type: "string" }, action: { type: "string" }, thread: { type: "string" }, "reply-to": { type: "string" }, done: { type: "boolean" } },
      });
      need(positionals, 2, "usage: asenq send <name|*|human> <text…>");
      const r = await client.request("send", {
        to: positionals[0], text: positionals.slice(1).join(" "),
        kind: values.kind, action: values.action, thread: values.thread, replyTo: values["reply-to"], done: values.done,
      });
      const results = r.results as SendResult[];
      out(formatSendResults(results));
      return results.some((x) => x.status === "rejected" || x.status === "failed" || x.status === "unknown_target") ? 1 : 0;
    }
    case "tail": {
      const tailClient = new AsenqClient({
        autoStart: true,
        onPush: (p) => {
          if (p.push !== "event") return;
          const e: TailEvent = p.event;
          if (e.type === "session") {
            out(`${hhmmss(Date.now())} session ${e.name} (${e.harness}) ${e.action}${e.oldName ? ` from ${e.oldName}` : ""}`);
          } else if (e.type === "channel") {
            out(`${hhmmss(Date.now())} channel #${e.channel.name} ${e.action} (${e.channel.memberIds?.length ?? 0} members)`);
          } else if (e.type === "ping") {
            out(`${hhmmss(Date.now())} ping ${e.sessionId}: ${e.ping}`);
          } else if (e.type === "message") {
            out(msgLine({ ...e.msg, status: e.status, reason: e.reason }));
          } else if (e.type === "retention") {
            out(`${hhmmss(Date.now())} retention pruned older history`);
          } else if (e.type === "read") {
            const stream = e.state.scope.scope === "session" ? e.state.scope.sessionId : `#${e.state.scope.channel}`;
            out(`${hhmmss(Date.now())} read ${stream}: ${e.state.unread} unread`);
          }
        },
        onReconnect: async () => void (await tailClient.request("tail")),
      });
      client.close();
      await tailClient.request("tail");
      process.on("SIGINT", () => {
        tailClient.close();
        process.exit(0);
      });
      return -1;
    }
    case "log": {
      const { values } = parseArgs({
        args: argv, options: { session: { type: "string" }, id: { type: "string" }, limit: { type: "string" } },
      });
      const r = await client.request("log", {
        name: values.session, msgId: values.id, limit: values.limit ? Number(values.limit) : undefined,
      });
      const msgs = r.messages as LoggedMsg[];
      if (values.id) {
        const m = msgs[0];
        out(`${m.id} ${m.from} → ${m.to}${m.sourceChannel ? ` via #${m.sourceChannel}` : ""} ${new Date(m.createdAt).toISOString()} ${m.status}${m.reason ? ` (${m.reason})` : ""}`);
        const meta = [m.kind && `kind=${m.kind}`, m.action && `action=${m.action}`, m.thread && `thread=${m.thread}`, m.replyTo && `reply-to=${m.replyTo}${m.replyToMissing ? " (purged message)" : ""}`, m.done && "done"].filter(Boolean);
        if (meta.length) out(meta.join(" · "));
        out("");
        out(m.text);
        return 0;
      }
      for (const m of msgs) out(msgLine(m));
      return 0;
    }
    case "inbox": {
      const r = await client.request("inbox", { name: "human" });
      const msgs = (r.messages as LoggedMsg[]).reverse();
      if (msgs.length === 0) out("no messages");
      for (const m of msgs) {
        out(`[${new Date(m.createdAt).toISOString()}] ${m.from} · ${m.id}${m.sourceChannel ? ` · via #${m.sourceChannel}` : ""}${m.kind ? ` · kind=${m.kind}` : ""}${m.action ? ` · action=${m.action}` : ""}${m.thread ? ` · thread=${m.thread}` : ""}${m.replyTo ? ` · reply-to=${m.replyTo}${m.replyToMissing ? " (purged message)" : ""}` : ""}${m.done ? " · done" : ""}`);
        out(m.text);
        out("");
      }
      return 0;
    }
    case "close": case "purge": {
      const { values, positionals } = parseArgs({
        args: argv, allowPositionals: true,
        options: cmd === "purge" ? { all: { type: "boolean" } } : {},
      });
      if (values.all ? positionals.length !== 0 : positionals.length !== 1) {
        throw new Error(`usage: asenq ${cmd} <name|identity>${cmd === "purge" ? " | asenq purge --all" : ""}`);
      }
      if (values.all) {
        const reply = await client.request("purge", { all: true });
        const purged = reply.purged as string[];
        out(purged.length ? purged.map((id) => `purged ${id}`).join("\n") : "no archived conversations");
        return 0;
      }
      const target = positionals[0];
      const { sessions } = await client.sync();
      let session = sessions.find((s) => s.id === target);
      if (!session) {
        const matching = sessions.filter((s) => s.name === target);
        const active = matching.filter((s) => s.state !== "removed");
        if (cmd === "purge" && active.length) {
          throw new Error(`cannot purge live or reconnecting name "${target}"; use an archived identity ID`);
        }
        const candidates = cmd === "close" && active.length ? active : matching;
        if (!candidates.length) throw new Error(`unknown current session name or identity "${target}"`);
        if (candidates.length > 1) {
          throw new Error(`ambiguous session name "${target}"; use an identity ID: ${candidates.map((s) => s.id).join(", ")}`);
        }
        session = candidates[0];
      }
      if (cmd === "close") {
        const reply = await client.request("close", { identity: session.id });
        const closed = reply.session as SessionIdentity;
        out(`closed ${closed.name} (${closed.id})`);
      } else {
        const reply = await client.request("purge", { identity: session.id });
        const purged = reply.purged as string[];
        out(purged.length ? purged.map((id) => `purged ${id}`).join("\n") : "no archived conversations purged");
      }
      return 0;
    }
    case "rename": {
      need(argv, 2, "usage: asenq rename <old> <new>");
      const r = await client.request("rename", { from: argv[0], name: argv[1] });
      out(`renamed ${argv[0]} → ${String(r.name)}`);
      return 0;
    }
    case "inbound": {
      need(argv, 2, "usage: asenq inbound <name> accept|hold|refuse");
      await client.request("set_inbound", { name: argv[0], mode: argv[1] });
      out(`${argv[0]} inbound ${argv[1]}`);
      return 0;
    }
    case "role": {
      need(argv, 2, "usage: asenq role <name> orchestrator|worker|unset");
      if (!["orchestrator", "worker", "unset"].includes(argv[1])) throw new Error("role must be orchestrator, worker or unset");
      await client.request("set_role", { name: argv[0], role: argv[1] === "unset" ? null : argv[1] });
      out(`${argv[0]} role ${argv[1]}`);
      return 0;
    }
    case "held": {
      const r = await client.request("held", { name: argv[0] });
      const msgs = r.messages as LoggedMsg[];
      if (msgs.length === 0) out("no held messages");
      for (const m of msgs) out(msgLine(m));
      return 0;
    }
    case "release": {
      need(argv, 1, "usage: asenq release <msgId>");
      const r = await client.request("release", { msgId: argv[0] });
      out(`${argv[0]} ${String(r.status)}`);
      return 0;
    }
    case "drop": {
      need(argv, 1, "usage: asenq drop <msgId>");
      await client.request("drop", { msgId: argv[0] });
      out(`${argv[0]} dropped`);
      return 0;
    }
    case "channels": {
      const r = await client.request("channel_list");
      const rows = r.channels as ChannelSummary[];
      if (rows.length === 0) out("no channels");
      for (const c of rows) out(`#${c.name}  ${c.count ? `${c.count} messages  last ${new Date(c.lastAt).toLocaleString()}` : "no posts"}  ${c.memberIds?.length ?? 0} members`);
      return 0;
    }
    case "channel": {
      const [sub, ch, ...rest] = argv;
      if (sub === "create" && ch && rest.length === 0) {
        await client.request("channel_create", { channel: ch });
        out(`#${ch} created`);
        return 0;
      }
      if (sub === "add" && ch && rest.length === 1) {
        await client.request("channel_add", { channel: ch, name: rest[0] });
        out(`${rest[0]} added to #${ch}`);
        return 0;
      }
      if (sub === "remove" && ch) {
        const { values, positionals } = parseArgs({
          args: rest, allowPositionals: true, options: { "session-id": { type: "string" } },
        });
        const sessionId = values["session-id"];
        if (sessionId ? positionals.length !== 0 : positionals.length !== 1) {
          throw new Error("usage: asenq channel remove <ch> <name> | asenq channel remove <ch> --session-id <id>");
        }
        await client.request("channel_remove", { channel: ch, ...(sessionId ? { sessionId } : { name: positionals[0] }) });
        out(`${sessionId ?? positionals[0]} removed from #${ch}`);
        return 0;
      }
      if (sub === "members" && ch && rest.length === 0) {
        const r = await client.request("channel_members", { channel: ch });
        const members = r.members as SessionIdentity[];
        if (members.length === 0) out(`#${ch} has no members`);
        for (const member of members) out(`${member.name}  ${member.role ?? "unset"}  ${member.state}  ${member.id}`);
        return 0;
      }
      if (sub === "read" && ch) {
        const { values } = parseArgs({ args: rest, options: { limit: { type: "string" } } });
        const r = await client.request("channel_read", { channel: ch, limit: values.limit ? Number(values.limit) : undefined });
        for (const m of r.messages as LoggedMsg[]) out(msgLine(m));
        return 0;
      }
      if (sub === "send" && ch && rest.length) {
        const r = await client.request("channel_send", { channel: ch, text: rest.join(" ") });
        out(`#${ch} ${String(r.msgId)} posted`);
        const results = r.results as SendResult[];
        out(results.length ? formatSendResults(results) : "no mention targets; no direct messages pushed");
        return 0;
      }
      throw new Error("usage: asenq channel create <ch> | add <ch> <name> | remove <ch> <name> | remove <ch> --session-id <id> | members <ch> | read <ch> [--limit n] | send <ch> <text…>");
    }
    default:
      throw new Error(`unknown command "${cmd}"\n${usage}`);
  }
}
