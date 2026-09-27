import { parseArgs } from "node:util";
import { lockedPid, runDaemon } from "../daemon/main.js";
import { AsenqClient, ensureDaemon } from "../shared/client.js";
import type { SendResult, TailEvent } from "../shared/protocol.js";
import { formatSendResults } from "../shared/tools.js";

type LoggedMsg = {
  id: string; from: string; to: string; text: string; createdAt: number;
  kind?: string; thread?: string; replyTo?: string; done?: boolean; status: string; reason?: string;
};

const out = (s: string): void => void process.stdout.write(s + "\n");
const hhmmss = (t: number): string => new Date(t).toTimeString().slice(0, 8);
const oneLine = (s: string, n: number): string => {
  const flat = s.replace(/\r?\n/g, "⏎");
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
};

function msgLine(m: Omit<LoggedMsg, "status"> & { status?: string; reason?: string }): string {
  const status = m.status ? ` (${m.status}${m.reason ? `: ${m.reason}` : ""})` : "";
  return `${hhmmss(m.createdAt)} ${m.id} ${m.from} → ${m.to}${m.kind ? ` [${m.kind}]` : ""} ${oneLine(m.text, 120)}${status}`;
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
      const r = await client.request("list");
      const rows = r.sessions as { name: string; harness: string; cwd: string | null; state: string; inbound: string }[];
      const table = [["NAME", "HARNESS", "STATE", "INBOUND", "CWD"], ...rows.map((s) => [s.name, s.harness, s.state, s.inbound, s.cwd ?? ""])];
      const widths = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
      for (const row of table) out(row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]))).join("  "));
      return 0;
    }
    case "send": {
      const { values, positionals } = parseArgs({
        args: argv, allowPositionals: true,
        options: { kind: { type: "string" }, thread: { type: "string" }, "reply-to": { type: "string" }, done: { type: "boolean" } },
      });
      need(positionals, 2, "usage: asenq send <name|*|human> <text…>");
      const r = await client.request("send", {
        to: positionals[0], text: positionals.slice(1).join(" "),
        kind: values.kind, thread: values.thread, replyTo: values["reply-to"], done: values.done,
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
          } else if (e.type === "message") {
            out(msgLine({ ...e.msg, status: e.status, reason: e.reason }));
          } else if (e.type === "retention") {
            out(`${hhmmss(Date.now())} retention pruned older history`);
          } else {
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
        out(`${m.id} ${m.from} → ${m.to} ${new Date(m.createdAt).toISOString()} ${m.status}${m.reason ? ` (${m.reason})` : ""}`);
        const meta = [m.kind && `kind=${m.kind}`, m.thread && `thread=${m.thread}`, m.replyTo && `reply-to=${m.replyTo}`, m.done && "done"].filter(Boolean);
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
      const msgs = r.messages as LoggedMsg[];
      if (msgs.length === 0) out("no messages");
      for (const m of msgs) {
        out(`[${new Date(m.createdAt).toISOString()}] ${m.from} · ${m.id}${m.kind ? ` · kind=${m.kind}` : ""}${m.thread ? ` · thread=${m.thread}` : ""}${m.replyTo ? ` · reply-to=${m.replyTo}` : ""}${m.done ? " · done" : ""}`);
        out(m.text);
        out("");
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
      const rows = r.channels as { name: string; count: number; lastAt: number }[];
      if (rows.length === 0) out("no channels");
      for (const c of rows) out(`#${c.name}  ${c.count} messages  last ${new Date(c.lastAt).toLocaleString()}`);
      return 0;
    }
    case "channel": {
      const [sub, ch, ...rest] = argv;
      if (sub === "read" && ch) {
        const { values } = parseArgs({ args: rest, options: { limit: { type: "string" } } });
        const r = await client.request("channel_read", { channel: ch, limit: values.limit ? Number(values.limit) : undefined });
        for (const m of r.messages as LoggedMsg[]) out(msgLine(m));
        return 0;
      }
      if (sub === "send" && ch && rest.length) {
        const r = await client.request("channel_send", { channel: ch, text: rest.join(" ") });
        out(`#${ch} ${String(r.msgId)} posted`);
        return 0;
      }
      throw new Error("usage: asenq channel read <ch> [--limit n] | asenq channel send <ch> <text…>");
    }
    default:
      throw new Error(`unknown command "${cmd}"\n${usage}`);
  }
}
