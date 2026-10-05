import assert from "node:assert/strict";
import { test } from "node:test";
import { AsenqClient } from "../src/shared/client.js";
import type { ListedSession } from "../src/shared/protocol.js";
import { isSession, startEnv } from "./helpers.js";

async function list(client: AsenqClient, filters: Record<string, unknown> = {}): Promise<ListedSession[]> {
  return (await client.request("list", filters)).sessions as ListedSession[];
}

test("list exposes durable names, current membership, role and real harness resume metadata", async () => {
  const env = await startEnv();
  try {
    const human = env.human();
    const omp = await env.adapter("omp", "omp-session", "original", { cwd: "/project/api" });
    const opencode = await env.adapter("opencode", "opencode-session", "web", { cwd: "/project/web" });
    const claude = (await human.request("claude_hook", {
      event: "start", key: "process-key", sessionId: "claude-session", name: "reviewer", cwd: "/project", busy: false,
    })).session as { id: string; name: string };
    await human.request("rename", { from: "original", name: "renamed" });
    await human.request("set_role", { name: "renamed", role: "worker" });
    await human.request("set_inbound", { name: "renamed", mode: "hold" });
    for (const channel of ["dev", "audit"]) {
      await human.request("channel_create", { channel });
      await human.request("channel_add", { channel, name: "renamed" });
    }
    await human.request("channel_add", { channel: "dev", name: "reviewer" });
    await human.request("channel_remove", { channel: "audit", name: "renamed" });
    const rows = await list(human);
    const renamed = rows.find((row) => row.id === omp.session.id)!;
    assert.deepEqual({
      id: renamed.id, name: renamed.name, previousNames: renamed.previousNames, harness: renamed.harness,
      cwd: renamed.cwd, state: renamed.state, stale: renamed.stale, inbound: renamed.inbound,
      role: renamed.role, channels: renamed.channels, lastSeen: renamed.lastSeen, busy: renamed.busy,
      harnessSessionId: renamed.harnessSessionId, resumeCommand: renamed.resumeCommand, you: renamed.you,
    }, {
      id: omp.session.id, name: "renamed", previousNames: ["original"], harness: "omp", cwd: "/project/api",
      state: "live", stale: false, inbound: "hold", role: "worker", channels: ["dev"],
      lastSeen: 1_700_000_000_000, busy: null, harnessSessionId: "omp-session", resumeCommand: "omp -r omp-session", you: false,
    });
    assert.ok(Object.hasOwn(renamed, "ping"));
    assert.equal(rows.find((row) => row.id === opencode.session.id)?.resumeCommand, "opencode -s opencode-session");
    assert.deepEqual([rows.find((row) => row.id === claude.id)?.resumeCommand, rows.find((row) => row.id === claude.id)?.busy],
      ["claude -r claude-session", false]);
    assert.equal((await list(omp.client)).find((row) => row.you)?.id, omp.session.id);
    assert.deepEqual((await list(human, { channel: "audit" })), []);
    await human.request("channel_add", { channel: "audit", name: "renamed" });
    assert.deepEqual((await list(human, { channel: "audit" })).map((row) => row.id), [omp.session.id]);
  } finally { await env.close(); }
});

test("list filters are literal cwd prefix, exact harness and current channel with AND composition", async () => {
  const env = await startEnv();
  try {
    const human = env.human();
    const api = await env.adapter("omp", "api", "api", { cwd: "/project/api" });
    const web = await env.adapter("opencode", "web", "web", { cwd: "/project/web" });
    await env.adapter("omp", "other", "other", { cwd: "/other/project" });
    await env.adapter("omp", "literal", "literal", { cwd: "/project/[api]" });
    const noCwd = env.human();
    await noCwd.request("register", { harness: "omp", key: "no-cwd", name: "no-cwd" });
    await human.request("channel_create", { channel: "dev" });
    for (const name of ["api", "web", "no-cwd"]) await human.request("channel_add", { channel: "dev", name });
    const names = async (filters: Record<string, unknown>) => (await list(human, filters)).map((row) => row.name).sort();
    assert.deepEqual(await names({ cwd: "/project" }), ["api", "literal", "web"]);
    assert.deepEqual(await names({ harness: "opencode" }), ["web"]);
    assert.deepEqual(await names({ channel: "dev" }), ["api", "no-cwd", "web"]);
    assert.deepEqual(await names({ cwd: "/project", harness: "omp" }), ["api", "literal"]);
    assert.deepEqual(await names({ cwd: "/project", channel: "dev" }), ["api", "web"]);
    assert.deepEqual(await names({ harness: "omp", channel: "dev" }), ["api", "no-cwd"]);
    assert.deepEqual(await names({ cwd: "/project", harness: "omp", channel: "dev" }), ["api"]);
    assert.deepEqual(await names({ cwd: "/project/[" }), ["literal"]);
    assert.deepEqual(await names({ cwd: "" }), ["api", "literal", "other", "web"]);
    assert.deepEqual(await names({ channel: "missing" }), []);
    assert.deepEqual(await names({ cwd: "/project/api", harness: "opencode", channel: "dev" }), []);
    assert.equal((await list(human)).find((row) => row.name === "no-cwd")?.cwd, null);
    await human.request("channel_remove", { channel: "dev", name: "api" });
    assert.deepEqual(await names({ cwd: "/project", harness: "omp", channel: "dev" }), []);
    const gone = await env.watch(isSession("gone", "web"));
    web.client.close();
    await gone.event;
    const disconnected = (await list(human, { channel: "dev", harness: "opencode" }))[0];
    assert.deepEqual([disconnected.id, disconnected.state, disconnected.stale], [web.session.id, "gone", true]);
    assert.equal((await list(human, { cwd: "/project/api" }))[0].id, api.session.id);
    for (const filters of [{ cwd: 1 }, { harness: true }, { channel: [] }, { harness: "unknown" }]) {
      await assert.rejects(human.request("list", filters), { code: "bad_request" });
    }
  } finally { await env.close(); }
});

test("old contact alone does not make a connected unpinged session stale", async () => {
  const env = await startEnv();
  try {
    const human = env.human();
    const adapter = await env.adapter("omp", "quiet", "quiet");
    env.clock.advance(24 * 3_600_000);
    const quiet = (await list(human))[0];
    assert.deepEqual([quiet.id, quiet.state, quiet.stale, quiet.lastSeen],
      [adapter.session.id, "live", false, 1_700_000_000_000]);
  } finally { await env.close(); }
});

test("list staleness follows the last targeted ping, not contact or busy reports", async () => {
  const env = await startEnv();
  const pingSent = Promise.withResolvers<void>();
  const silent = new AsenqClient({
    onPush: (push) => {
      const kind: string = push.push;
      if (kind === "ping") pingSent.resolve();
    },
  });
  const responsive = new AsenqClient({
    onPush: (event) => {
      const kind: string = event.push;
      if (kind === "ping" && "pingId" in event && typeof event.pingId === "string") {
        void responsive.request("pong", { pingId: event.pingId }).catch(() => {});
      }
    },
  });
  try {
    const human = env.human();
    await silent.request("register", { harness: "omp", key: "silent", name: "silent", caps: ["ping"] });
    const alpha = (await responsive.request("register", {
      harness: "opencode", key: "alpha", name: "alpha", caps: ["ping"],
    })).session as { id: string };
    const beta = (await responsive.request("register", {
      harness: "opencode", key: "beta", name: "beta", caps: ["ping"],
    })).session as { id: string };
    await env.adapter("omp", "unknown", "unknown", { pingSupport: false });
    env.clock.advance(10);
    const responding = (await human.request("ping", { sessionId: beta.id })).results as { sessionId: string; ping: string }[];
    assert.deepEqual(responding.map((row) => [row.sessionId, row.ping]), [[beta.id, "responding"]]);
    const beforeTimeout = await list(human);
    assert.deepEqual([beforeTimeout.find((row) => row.id === beta.id)?.state, beforeTimeout.find((row) => row.id === beta.id)?.stale,
      beforeTimeout.find((row) => row.id === beta.id)?.lastSeen], ["live", false, 1_700_000_000_010]);
    assert.equal(beforeTimeout.find((row) => row.id === alpha.id)?.lastSeen, 1_700_000_000_000);
    const unknown = (await human.request("ping", { name: "unknown" })).results as { ping: string }[];
    assert.equal(unknown[0].ping, "unknown");
    const pending = human.request("ping", { name: "silent" });
    await pingSent.promise;
    env.clock.advance(3000);
    env.daemon.sweep();
    assert.equal(((await pending).results as { ping: string }[])[0].ping, "not_responding");
    let rows = await list(human);
    assert.deepEqual([rows.find((row) => row.name === "silent")?.state, rows.find((row) => row.name === "silent")?.stale,
      rows.find((row) => row.name === "silent")?.ping], ["stale", true, "not_responding"]);
    assert.deepEqual([rows.find((row) => row.name === "unknown")?.state, rows.find((row) => row.name === "unknown")?.stale,
      rows.find((row) => row.name === "unknown")?.ping], ["live", false, "unknown"]);
    env.clock.advance(100);
    await silent.request("session_status", { busy: false });
    await silent.request("inbox");
    rows = await list(human);
    assert.deepEqual([rows.find((row) => row.name === "silent")?.state, rows.find((row) => row.name === "silent")?.stale,
      rows.find((row) => row.name === "silent")?.ping, rows.find((row) => row.name === "silent")?.lastSeen,
      rows.find((row) => row.name === "silent")?.busy], ["stale", true, "not_responding", 1_700_000_003_110, false]);
    const gone = await env.watch(isSession("gone", "silent"));
    silent.close();
    await gone.event;
    const disconnected = (await list(human)).find((row) => row.name === "silent")!;
    assert.deepEqual([disconnected.state, disconnected.stale, disconnected.busy], ["gone", true, null]);
  } finally {
    silent.close();
    responsive.close();
    await env.close();
  }
});
