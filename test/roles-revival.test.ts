import assert from "node:assert/strict";
import { test } from "node:test";
import { GRACE_MS } from "../src/shared/protocol.js";
import { isSession, startEnv } from "./helpers.js";

for (const harness of ["omp", "opencode"] as const) {
  test(`${harness} role survives rename, archive and identity revival without following a reused name`, async () => {
    const env = await startEnv();
    try {
      const human = env.human();
      const original = await env.adapter(harness, "durable-role-key", "alpha");
      await human.request("set_role", { name: "alpha", role: "worker" });
      await human.request("rename", { from: "alpha", name: "renamed" });
      const gone = await env.watch(isSession("gone", "renamed"));
      original.client.close();
      await gone.event;
      const queued = (await human.request("send", { to: "renamed", text: "waiting across revival" })).results as { msgId: string; status: string }[];
      assert.equal(queued[0].status, "queued");
      env.clock.advance(GRACE_MS);
      env.daemon.sweep();
      const archived = (await human.sync()).sessions.find((session) => session.id === original.session.id)!;
      assert.deepEqual([archived.state, archived.role], ["removed", "worker"]);
      const replacement = await env.adapter(harness, "replacement-role-key", "renamed");
      const resumed = await env.adapter(harness, "durable-role-key", "ignored-name");
      assert.equal(resumed.session.id, original.session.id);
      assert.notEqual(resumed.session.name, replacement.session.name);
      const snapshot = await human.sync();
      assert.equal(snapshot.sessions.find((session) => session.id === resumed.session.id)?.role, "worker");
      assert.equal(snapshot.sessions.find((session) => session.id === replacement.session.id)?.role, null);
      const delivery = await resumed.nextDelivery();
      assert.equal(delivery.msg.id, queued[0].msgId);
      assert.match(delivery.text.split("\n")[0], /your-role=worker/);
      await human.request("set_role", { name: resumed.session.name, role: null });
      assert.equal((await human.sync()).sessions.find((session) => session.id === resumed.session.id)?.role, null);
    } finally {
      await env.close();
    }
  });
}

test("Claude role survives archive and resume with a changed process key", async () => {
  const env = await startEnv();
  try {
    const human = env.human();
    const first = (await human.request("claude_hook", { event: "start", key: "old-process", sessionId: "durable-claude-id", name: "claude-role", cwd: "/work" })).session as { id: string; name: string };
    await human.request("set_role", { name: first.name, role: "orchestrator" });
    await human.request("rename", { from: first.name, name: "claude-renamed" });
    await human.request("claude_hook", { event: "end", sessionId: "durable-claude-id" });
    assert.equal((await human.sync()).sessions.find((session) => session.id === first.id)?.state, "removed");
    const resumed = (await human.request("claude_hook", { event: "start", key: "new-process", sessionId: "durable-claude-id", name: "ignored", cwd: "/work" })).session as { id: string; name: string };
    assert.deepEqual(resumed, { id: first.id, name: "claude-renamed" });
    assert.equal((await human.sync()).sessions.find((session) => session.id === first.id)?.role, "orchestrator");
    await human.request("send", { to: resumed.name, text: "after Claude revival" });
    const texts = (await human.request("claude_hook", { event: "poll", sessionId: "durable-claude-id" })).texts as string[];
    assert.match(texts[0].split("\n")[0], /your-role=orchestrator/);
  } finally {
    await env.close();
  }
});
