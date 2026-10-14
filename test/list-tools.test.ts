import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ListedSession } from "../src/shared/protocol.js";
import { callTool } from "../src/shared/tools.js";
import { isSession, startEnv, type TestEnv } from "./helpers.js";

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

function listedIds(output: string): string[] {
  return [...output.matchAll(/^  id=(\S+)/gm)].map((match) => match[1]).sort();
}

function sessionBlock(output: string, name: string): string {
  const block = output.split("\n\n").find((row) => row.split("\n")[0] === name || row.split("\n")[0] === `${name} [you]`);
  assert.ok(block, `missing session ${name}: ${output}`);
  return block;
}

test("list exposes identity, availability and known Claude resume metadata without treating quiet DMs as stale", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("claude_hook", { event: "start", key: "sid:claude-resume-id", sessionId: "claude-resume-id", name: "reviewer", cwd: "/work/review" });
  await human.request("set_role", { name: "reviewer", role: "worker" });
  await human.request("set_inbound", { name: "reviewer", mode: "hold" });
  await human.request("channel_create", { channel: "review" });
  await human.request("channel_add", { channel: "review", name: "reviewer" });
  await human.request("rename", { from: "reviewer", name: "renamed-reviewer" });
  env.clock.advance(60 * 60 * 1000);
  await human.request("claude_hook", { event: "poll", sessionId: "claude-resume-id" });
  const rows = (await human.request("list", { harness: "claude" })).sessions as ListedSession[];
  assert.equal(rows[0].state, "live");
  assert.equal(rows[0].stale, false);
  assert.equal(rows[0].lastSeen, env.clock.now());
  const output = sessionBlock(await callTool(human, "asenq_list", { harness: "claude" }), "renamed-reviewer");
  assert.match(output, /former=reviewer/);
  assert.match(output, /harness=claude/);
  assert.match(output, /cwd=\/work\/review/);
  assert.match(output, /role=worker/);
  assert.match(output, /channels=#review/);
  assert.match(output, /inbound=hold/);
  assert.match(output, /state=live/);
  assert.match(output, /stale=no/);
  assert.match(output, /ping=never/);
  assert.match(output, /busy=unknown/);
  assert.match(output, /lastSeen=2023-11-14T23:13:20\.000Z/);
  assert.match(output, /harnessSessionId=claude-resume-id/);
  assert.match(output, /resume=claude -r claude-resume-id/);
  assert.doesNotMatch(output, /\[you\]/);
});

test("reported busy, idle and unknown availability remain distinct and own resume information is visible", async () => {
  env = await startEnv();
  const adapter = await env.adapter("omp", "omp-session-id", "builder");
  const initial = sessionBlock(await callTool(adapter.client, "asenq_list", {}), "builder");
  assert.match(initial, /^builder \[you\]/);
  assert.match(initial, /busy=unknown/);
  assert.match(initial, /harnessSessionId=omp-session-id/);
  assert.match(initial, /resume=omp -r omp-session-id/);
  for (const [busy, expected] of [[true, "busy"], [false, "idle"], [null, "unknown"]] as const) {
    env.clock.advance(1000);
    await adapter.client.request("session_status", { as: adapter.session.id, busy });
    const rows = (await adapter.client.request("list")).sessions as ListedSession[];
    assert.equal(rows[0].busy, busy);
    assert.equal(rows[0].lastSeen, env.clock.now());
    const output = sessionBlock(await callTool(adapter.client, "asenq_list", {}), "builder");
    assert.ok(output.includes(`busy=${expected}`), output);
    assert.match(output, /^builder \[you\]/);
  }
});

test("a Claude registration without a reported harness id never invents a resume command", async () => {
  env = await startEnv();
  const adapter = await env.adapter("claude", "socket-without-session-id", "unknown-id");
  const output = sessionBlock(await callTool(adapter.client, "asenq_list", {}), "unknown-id");
  assert.match(output, /harnessSessionId=unknown/);
  assert.match(output, /busy=unknown/);
  assert.doesNotMatch(output, /resume=/);
  assert.doesNotMatch(output, /claude -r/);
});

test("disconnected sessions remain gone and visibly stale rather than idle", async () => {
  env = await startEnv();
  const human = env.human();
  const adapter = await env.adapter("opencode", "ses_offline", "offline");
  const gone = await env.watch(isSession("gone", "offline"));
  adapter.client.close();
  await gone.event;
  const rows = (await human.request("list")).sessions as ListedSession[];
  assert.equal(rows[0].state, "gone");
  assert.equal(rows[0].stale, true);
  const output = sessionBlock(await callTool(human, "asenq_list", {}), "offline");
  assert.match(output, /state=gone/);
  assert.match(output, /stale=yes/);
  assert.match(output, /busy=unknown/);
  assert.match(output, /harnessSessionId=ses_offline/);
  assert.match(output, /resume=opencode -s ses_offline/);
});

test("list filters intersect current cwd, harness and membership in protocol and tool output", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "alpha-key", "alpha", { cwd: "/repo/app" });
  const beta = await env.adapter("omp", "beta-key", "beta", { cwd: "/repo/pkg" });
  const gamma = await env.adapter("opencode", "gamma-key", "gamma", { cwd: "/repo/app" });
  const delta = await env.adapter("omp", "delta-key", "delta", { cwd: "/other" });
  const epsilon = await env.adapter("claude", "epsilon-key", "epsilon", { cwd: "/repository" });
  await human.request("channel_create", { channel: "focus" });
  for (const name of ["alpha", "gamma", "delta"]) await human.request("channel_add", { channel: "focus", name });
  await alpha.client.request("rename", { name: "renamed" });

  const cases: [Record<string, string>, string[]][] = [
    [{ cwd: "/repo" }, [alpha.session.id, beta.session.id, gamma.session.id, epsilon.session.id]],
    [{ harness: "omp" }, [alpha.session.id, beta.session.id, delta.session.id]],
    [{ harness: "opencode" }, [gamma.session.id]],
    [{ harness: "claude" }, [epsilon.session.id]],
    [{ channel: "focus" }, [alpha.session.id, gamma.session.id, delta.session.id]],
    [{ cwd: "/repo", harness: "omp" }, [alpha.session.id, beta.session.id]],
    [{ cwd: "/repo", channel: "focus" }, [alpha.session.id, gamma.session.id]],
    [{ harness: "omp", channel: "focus" }, [alpha.session.id, delta.session.id]],
    [{ cwd: "/repo", harness: "omp", channel: "focus" }, [alpha.session.id]],
    [{ cwd: "/repo*" }, []],
    [{ channel: "foc" }, []],
    [{ cwd: "/other", harness: "opencode", channel: "focus" }, []],
  ];
  for (const [filters, expected] of cases) {
    const rows = (await human.request("list", filters)).sessions as ListedSession[];
    const output = await callTool(alpha.client, "asenq_list", filters);
    assert.deepEqual(rows.map((row) => row.id).sort(), [...expected].sort(), JSON.stringify(filters));
    assert.deepEqual(listedIds(output), [...expected].sort(), output);
    if (expected.length === 0) assert.match(output, /no sessions.*match.*filters/);
  }

  const renamed = sessionBlock(await callTool(alpha.client, "asenq_list", { channel: "focus" }), "renamed");
  assert.match(renamed, /^renamed \[you\]/);
  assert.match(renamed, /former=alpha/);
  assert.match(renamed, /channels=#focus/);
  await alpha.client.request("register", { harness: "omp", key: "alpha-key", cwd: "/moved" });
  const oldCwd = await callTool(alpha.client, "asenq_list", { cwd: "/repo/app", harness: "omp", channel: "focus" });
  assert.deepEqual(listedIds(oldCwd), []);
  const moved = await callTool(alpha.client, "asenq_list", { cwd: "/moved", harness: "omp", channel: "focus" });
  assert.deepEqual(listedIds(moved), [alpha.session.id]);
  assert.match(sessionBlock(moved, "renamed"), /former=alpha/);
  await human.request("channel_remove", { channel: "focus", name: "alpha" });
  const withoutFormerMember = await callTool(alpha.client, "asenq_list", { cwd: "/moved", harness: "omp", channel: "focus" });
  assert.deepEqual(listedIds(withoutFormerMember), []);
  assert.match(withoutFormerMember, /no sessions.*match.*filters/);
});

test("a selected caller is marked by identity on a shared OpenCode connection", async () => {
  env = await startEnv();
  const first = await env.adapter("opencode", "first-id", "first");
  const second = (await first.client.request("register", { harness: "opencode", key: "second-id", name: "second", cwd: "/other" })).session as { id: string; name: string };
  const output = await callTool(first.client, "asenq_list", { harness: "opencode", as: first.session.id }, second.id);
  assert.match(sessionBlock(output, "second"), /^second \[you\]/);
  assert.doesNotMatch(sessionBlock(output, "first"), /\[you\]/);
  assert.deepEqual(listedIds(output), [first.session.id, second.id].sort());
});

test("an empty unfiltered registry is distinguished from a filter with no matches", async () => {
  env = await startEnv();
  const human = env.human();
  assert.match(await callTool(human, "asenq_list", {}), /no sessions registered/);
  assert.match(await callTool(human, "asenq_list", { cwd: "/missing" }), /no sessions.*match.*filters/);
});
