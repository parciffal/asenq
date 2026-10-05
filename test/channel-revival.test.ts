import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { GRACE_MS, type SessionIdentity } from "../src/shared/protocol.js";
import { isSession, startEnv } from "./helpers.js";

for (const harness of ["omp", "opencode"] as const) {
  test(`${harness} multi-channel memberships survive archive and revival without following a reused name`, async () => {
    const env = await startEnv();
    try {
      const human = env.human();
      const original = await env.adapter(harness, "channel-durable-key", "alpha");
      await human.request("set_role", { name: "alpha", role: "worker" });
      for (const channel of ["one", "two"]) {
        await human.request("channel_create", { channel });
        await human.request("channel_add", { channel, name: "alpha" });
      }
      await human.request("rename", { from: "alpha", name: "renamed" });
      const gone = await env.watch(isSession("gone", "renamed"));
      original.client.close();
      await gone.event;
      await assert.rejects(human.request("channel_add", { channel: "one", name: "renamed" }), { code: "not_live" });
      env.clock.advance(GRACE_MS);
      env.daemon.sweep();
      for (const channel of ["one", "two"]) {
        const members = (await human.request("channel_members", { channel })).members as SessionIdentity[];
        assert.deepEqual(members.map((member) => [member.id, member.name, member.role, member.state]), [[original.session.id, "renamed", "worker", "removed"]]);
      }
      const replacement = await env.adapter(harness, "channel-replacement-key", "renamed");
      const revived = await env.adapter(harness, "channel-durable-key", "ignored-name");
      assert.equal(revived.session.id, original.session.id);
      assert.notEqual(revived.session.name, replacement.session.name);
      for (const channel of ["one", "two"]) {
        const members = (await human.request("channel_members", { channel })).members as SessionIdentity[];
        assert.deepEqual(members.map((member) => [member.id, member.name, member.role, member.state]), [[original.session.id, revived.session.name, "worker", "live"]]);
      }
    } finally {
      await env.close();
    }
  });
}

test("Claude membership and role survive archive and resume under a changed process key", async () => {
  const env = await startEnv();
  try {
    const human = env.human();
    const original = (await human.request("claude_hook", { event: "start", key: "old-channel-process", sessionId: "claude-channel-durable", name: "claude-member" })).session as { id: string; name: string };
    await human.request("set_role", { name: original.name, role: "orchestrator" });
    await human.request("channel_create", { channel: "claude-work" });
    await human.request("channel_add", { channel: "claude-work", name: original.name });
    await human.request("rename", { from: original.name, name: "claude-renamed" });
    await human.request("claude_hook", { event: "end", sessionId: "claude-channel-durable" });
    const archived = (await human.request("channel_members", { channel: "claude-work" })).members as SessionIdentity[];
    assert.deepEqual(archived.map((member) => [member.id, member.state, member.role]), [[original.id, "removed", "orchestrator"]]);
    const revived = (await human.request("claude_hook", { event: "start", key: "new-channel-process", sessionId: "claude-channel-durable", name: "ignored-name" })).session as { id: string; name: string };
    assert.deepEqual(revived, { id: original.id, name: "claude-renamed" });
    const members = (await human.request("channel_members", { channel: "claude-work" })).members as SessionIdentity[];
    assert.deepEqual(members.map((member) => [member.id, member.name, member.role, member.state]), [[original.id, "claude-renamed", "orchestrator", "live"]]);
  } finally {
    await env.close();
  }
});

for (const ancestorRole of [null, "orchestrator"] as const) {
  test(`late Claude recognition unions channel rosters and ${ancestorRole ? "preserves ancestor role" : "inherits provisional role"}`, async () => {
    const env = await startEnv();
    try {
      const human = env.human();
      const originalPath = fileURLToPath(new URL("../../test/fixtures/claude-lineage-original.jsonl", import.meta.url));
      const resumedPath = fileURLToPath(new URL("../../test/fixtures/claude-lineage-resumed.jsonl", import.meta.url));
      const ancestor = (await human.request("claude_hook", {
        event: "start", key: "ancestor-process", sessionId: "8dab0f9b-86f5-4bdb-a8d7-d3771dd75179",
        name: "ancestor", transcriptPath: originalPath, source: "startup",
      })).session as { id: string; name: string };
      await human.request("set_role", { name: ancestor.name, role: ancestorRole });
      await human.request("set_inbound", { name: ancestor.name, mode: "hold" });
      await human.request("channel_create", { channel: "shared" });
      await human.request("channel_add", { channel: "shared", name: ancestor.name });
      await human.request("claude_hook", { event: "end", sessionId: "8dab0f9b-86f5-4bdb-a8d7-d3771dd75179" });
      const latePath = join(env.home, "late-membership.jsonl");
      const provisional = (await human.request("claude_hook", {
        event: "start", key: "provisional-process", sessionId: "5caef88d-869b-41cd-990c-83f2032f0856",
        name: "provisional", transcriptPath: latePath, source: "resume",
      })).session as { id: string; name: string };
      assert.notEqual(provisional.id, ancestor.id);
      await human.request("set_role", { name: provisional.name, role: "worker" });
      await human.request("channel_create", { channel: "x" });
      await human.request("channel_add", { channel: "x", name: provisional.name });
      await human.request("channel_add", { channel: "shared", name: provisional.name });
      const updated = await env.watch((event) => event.type === "channel" && event.channel.name === "x"
        && event.channel.memberIds?.includes(ancestor.id) === true);
      writeFileSync(latePath, readFileSync(resumedPath, "utf8"));
      await human.request("claude_hook", {
        event: "reconcile", sessionId: "5caef88d-869b-41cd-990c-83f2032f0856", transcriptPath: latePath,
      });
      for (const channel of ["x", "shared"]) {
        const members = (await human.request("channel_members", { channel })).members as SessionIdentity[];
        assert.deepEqual(members.map((member) => [member.id, member.role, member.state, member.inbound]),
          [[ancestor.id, ancestorRole ?? "worker", "live", "hold"]]);
      }
      const event = await updated.event;
      assert.equal(event.type, "channel");
      if (event.type === "channel") assert.deepEqual(event.channel.memberIds, [ancestor.id]);
      assert.ok(!(await human.sync()).sessions.some((session) => session.id === provisional.id));
    } finally {
      await env.close();
    }
  });
}
