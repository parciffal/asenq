import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, type DaemonOpts } from "../src/daemon/daemon.js";
import { AsenqClient, type Reply } from "../src/shared/client.js";
import { socketPath } from "../src/shared/paths.js";
import type { Harness, Push, TailEvent, WireMsg } from "../src/shared/protocol.js";
import { openDb, type Db } from "../src/shared/sqlite.js";

export type Delivery = Extract<Push, { push: "deliver" }>;

export type Adapter = {
  client: AsenqClient;
  session: { id: string; name: string };
  deliveries: Delivery[];
  nextDelivery(): Promise<Delivery>;
};

export type TestEnv = {
  home: string;
  daemon: Daemon;
  clock: { now(): number; advance(ms: number): void };
  human(): AsenqClient;
  adapter(harness: Harness, key: string, name?: string, opts?: { cwd?: string; autoAck?: boolean }): Promise<Adapter>;
  /** Subscribes to tail events now; `event` resolves with the first one matching `pred`. */
  watch(pred: (e: TailEvent) => boolean): Promise<{ event: Promise<TailEvent> }>;
  /** Closes clients and reopens the same database with a fresh daemon; the manual clock is retained. */
  restart(): Promise<void>;
  close(): Promise<void>;
};

export type LoggedMsg = WireMsg & { status: string; reason?: string };

/** Starts a daemon in-process on a temp ASENQ_HOME with a manual clock and no background timers. */
export async function startEnv(opts: Partial<DaemonOpts> = {}, seed?: (db: Db) => void): Promise<TestEnv> {
  const home = mkdtempSync(join(tmpdir(), "asenq-"));
  process.env.ASENQ_HOME = home;
  let db = await openDb(join(home, "asenq.db"));
  seed?.(db);
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
  const createDaemon = () => new Daemon({
    socket: socketPath(), replyDir: join(home, "r"), now: clock.now, timers: false, log: () => {}, ...opts, db,
  });
  let daemon = createDaemon();
  await daemon.listen();
  const clients: AsenqClient[] = [];
  const track = (c: AsenqClient): AsenqClient => (clients.push(c), c);

  return {
    home, get daemon() { return daemon; }, clock,
    human: () => track(new AsenqClient()),
    async adapter(harness, key, name, o = {}) {
      const deliveries: Delivery[] = [];
      let waiter: (() => void) | undefined;
      const client: AsenqClient = track(new AsenqClient({
        onPush: (p) => {
          if (p.push !== "deliver") return;
          deliveries.push(p);
          waiter?.();
          if (o.autoAck !== false) void client.request("ack", { msgId: p.msg.id, ok: true }).catch(() => {});
        },
      }));
      const r: Reply = await client.request("register", { harness, key, name, cwd: o.cwd ?? "/work" });
      let seen = 0;
      return {
        client, session: r.session as { id: string; name: string }, deliveries,
        async nextDelivery() {
          if (deliveries.length <= seen) {
            const { promise, resolve } = Promise.withResolvers<void>();
            waiter = resolve;
            await promise;
            waiter = undefined;
          }
          return deliveries[seen++];
        },
      };
    },
    async watch(pred) {
      const { promise, resolve } = Promise.withResolvers<TailEvent>();
      const c = track(new AsenqClient({
        onPush: (p) => {
          if (p.push === "event" && pred(p.event)) resolve(p.event);
        },
      }));
      await c.request("tail");
      return { event: promise };
    },
    async restart() {
      for (const c of clients) c.close();
      clients.length = 0;
      await daemon.close();
      db.close();
      db = await openDb(join(home, "asenq.db"));
      daemon = createDaemon();
      await daemon.listen();
    },
    async close() {
      for (const c of clients) c.close();
      await daemon.close();
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export async function logOf(c: AsenqClient, msgId: string): Promise<LoggedMsg> {
  const r = await c.request("log", { msgId });
  return (r.messages as LoggedMsg[])[0];
}

export const isSession = (action: string, name: string) => (e: TailEvent): boolean =>
  e.type === "session" && e.action === action && e.name === name;

export const isStatus = (msgId: string | undefined, status: string) => (e: TailEvent): boolean =>
  e.type === "message" && e.msg.id === msgId && e.status === status;
