import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PROTOCOL, type ChannelSummary, type SessionIdentity, type TailEvent } from "../src/shared/protocol.js";
import { startEnv, type TestEnv } from "./helpers.js";

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

test("protocol constant is 18", () => {
  assert.equal(PROTOCOL, 18);
});

test("channel rename succeeds and updates all stored references", async () => {
  env = await startEnv();
  const human = env.human();
  const w = await env.adapter("omp", "k1", "alpha");
  await human.request("channel_create", { channel: "old-ch" });
  await human.request("channel_add", { channel: "old-ch", name: "alpha" });
  // Post a message to the channel (mention by name, not keyword)
  await human.request("channel_send", { channel: "old-ch", text: "hello @alpha" });
  await w.nextDelivery();

  // Watch for the renamed tail event
  const watcher = await env.watch(
    (e: TailEvent) => e.type === "channel" && e.action === "renamed",
  );

  const r = await human.request("channel_rename", { channel: "old-ch", name: "new-ch" });
  const renamed = r.channel as ChannelSummary;
  assert.equal(renamed.name, "new-ch");

  // Consume the system note delivered to the member
  const note = await w.nextDelivery();
  assert.equal(note.msg.text, "channel old-ch is now new-ch");
  assert.equal(note.msg.from, "asenq");

  // Verify tail event
  const event = await watcher.event;
  assert.equal(event.type, "channel");
  assert.ok(event.type === "channel" && event.action === "renamed");
  assert.ok(event.type === "channel" && event.oldName === "old-ch");
  assert.ok(event.type === "channel" && event.channel.name === "new-ch");

  // Channel members should be on the new name
  const members = (await human.request("channel_members", { channel: "new-ch" })).members as SessionIdentity[];
  assert.equal(members.length, 1);
  assert.equal(members[0].name, "alpha");

  // Old channel should no longer exist
  await assert.rejects(
    human.request("channel_members", { channel: "old-ch" }),
    { code: "unknown_channel" },
  );

  // Channel read on new name returns the old post
  const read = await human.request("channel_read", { channel: "new-ch" });
  assert.ok((read.messages as { text: string }[]).some((m) => m.text === "hello @alpha"));

  // Channel list shows only the new name
  const list = (await human.request("channel_list")).channels as ChannelSummary[];
  assert.ok(list.some((c) => c.name === "new-ch"));
  assert.ok(!list.some((c) => c.name === "old-ch"));
});

test("channel rename refuses if new name is taken", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "alpha" });
  await human.request("channel_create", { channel: "beta" });
  await assert.rejects(
    human.request("channel_rename", { channel: "alpha", name: "beta" }),
    { code: "name_taken" },
  );
});

test("channel rename refuses if old channel does not exist", async () => {
  env = await startEnv();
  const human = env.human();
  await assert.rejects(
    human.request("channel_rename", { channel: "nonexistent", name: "new" }),
    { code: "unknown_channel" },
  );
});

test("channel rename refuses for session (non-human) caller", async () => {
  env = await startEnv();
  const human = env.human();
  const w = await env.adapter("omp", "k1", "alpha");
  await human.request("channel_create", { channel: "owned" });
  await human.request("channel_add", { channel: "owned", name: "alpha" });
  await assert.rejects(
    w.client.request("channel_rename", { channel: "owned", name: "renamed", as: w.session.id }),
    { code: "bad_request" },
  );
});

test("channel rename refuses invalid new name", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "valid" });
  await assert.rejects(
    human.request("channel_rename", { channel: "valid", name: "Invalid Name!" }),
    { code: "invalid_name" },
  );
  // Reserved names
  await assert.rejects(
    human.request("channel_rename", { channel: "valid", name: "human" }),
    { code: "invalid_name" },
  );
});

test("post to old name after rename errors with channel_renamed and names the current name", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "old-name" });
  await human.request("channel_rename", { channel: "old-name", name: "new-name" });

  try {
    await human.request("channel_send", { channel: "old-name", text: "should fail" });
    assert.fail("expected channel_renamed error");
  } catch (e: unknown) {
    const err = e as { code: string; message: string };
    assert.equal(err.code, "channel_renamed");
    assert.equal(err.message, 'channel "old-name" was renamed to "new-name"');
  }
});

test("channel rename chain a->b->c: send to a names c", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "aaa" });
  await human.request("channel_rename", { channel: "aaa", name: "bbb" });
  await human.request("channel_rename", { channel: "bbb", name: "ccc" });

  // Send to "aaa" should error and point at "ccc" (the current name)
  try {
    await human.request("channel_send", { channel: "aaa", text: "should fail" });
    assert.fail("expected channel_renamed error");
  } catch (e: unknown) {
    const err = e as { code: string; message: string };
    assert.equal(err.code, "channel_renamed");
    assert.equal(err.message, 'channel "aaa" was renamed to "ccc"');
  }

  // Send to "bbb" should also error and point at "ccc"
  try {
    await human.request("channel_send", { channel: "bbb", text: "should fail" });
    assert.fail("expected channel_renamed error");
  } catch (e: unknown) {
    const err = e as { code: string; message: string };
    assert.equal(err.code, "channel_renamed");
    assert.equal(err.message, 'channel "bbb" was renamed to "ccc"');
  }
});

test("explicit channel create clears the rename record", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "reusable" });
  await human.request("channel_rename", { channel: "reusable", name: "moved" });

  // Verify old name is blocked
  await assert.rejects(
    human.request("channel_send", { channel: "reusable", text: "blocked" }),
    { code: "channel_renamed" },
  );

  // Explicit create clears the record
  await human.request("channel_create", { channel: "reusable" });

  // Now auto-create path should not reject (channel already exists from explicit create)
  const list = (await human.request("channel_list")).channels as ChannelSummary[];
  assert.ok(list.some((c) => c.name === "reusable"));
  assert.ok(list.some((c) => c.name === "moved"));
});

test("renaming back to the old name clears the rename record", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "original" });
  await human.request("channel_rename", { channel: "original", name: "temporary" });

  // "original" is blocked
  await assert.rejects(
    human.request("channel_send", { channel: "original", text: "blocked" }),
    { code: "channel_renamed" },
  );

  // Rename back
  await human.request("channel_rename", { channel: "temporary", name: "original" });

  // "original" is now the live channel; "temporary" should point to "original"
  const list = (await human.request("channel_list")).channels as ChannelSummary[];
  assert.ok(list.some((c) => c.name === "original"));

  try {
    await human.request("channel_send", { channel: "temporary", text: "blocked" });
    assert.fail("expected channel_renamed error");
  } catch (e: unknown) {
    const err = e as { code: string; message: string };
    assert.equal(err.code, "channel_renamed");
    assert.equal(err.message, 'channel "temporary" was renamed to "original"');
  }
});

test("auto-create of an unrelated new name still works", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "existing" });
  await human.request("channel_rename", { channel: "existing", name: "renamed" });

  // A completely new name (never renamed) auto-creates
  await human.request("channel_send", { channel: "brand-new", text: "auto-created" });
  const list = (await human.request("channel_list")).channels as ChannelSummary[];
  assert.ok(list.some((c) => c.name === "brand-new"));
});

test("send/read to old name fails after rename and old name can be re-created", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "ephemeral" });
  await human.request("channel_rename", { channel: "ephemeral", name: "permanent" });

  // Channel members on old name returns unknown_channel
  await assert.rejects(
    human.request("channel_members", { channel: "ephemeral" }),
    { code: "unknown_channel" },
  );

  // Channel send to old name returns channel_renamed
  await assert.rejects(
    human.request("channel_send", { channel: "ephemeral", text: "should fail" }),
    { code: "channel_renamed" },
  );

  // Old name can be re-created
  await human.request("channel_create", { channel: "ephemeral" });
  const list = (await human.request("channel_list")).channels as ChannelSummary[];
  assert.ok(list.some((c) => c.name === "ephemeral"));
  assert.ok(list.some((c) => c.name === "permanent"));

  // After re-create, sends work again
  await human.request("channel_send", { channel: "ephemeral", text: "works now" });
});

test("members receive system note from asenq on channel rename", async () => {
  env = await startEnv();
  const human = env.human();
  const w1 = await env.adapter("omp", "k1", "alpha");
  const w2 = await env.adapter("omp", "k2", "beta");
  await human.request("channel_create", { channel: "team" });
  await human.request("channel_add", { channel: "team", name: "alpha" });
  await human.request("channel_add", { channel: "team", name: "beta" });

  await human.request("channel_rename", { channel: "team", name: "squad" });

  // Both members should receive the note from asenq
  const d1 = await w1.nextDelivery();
  assert.equal(d1.msg.text, "channel team is now squad");
  assert.equal(d1.msg.from, "asenq");
  const d2 = await w2.nextDelivery();
  assert.equal(d2.msg.text, "channel team is now squad");
  assert.equal(d2.msg.from, "asenq");
});

test("channel rename same name is a no-op", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "stable" });
  const r = await human.request("channel_rename", { channel: "stable", name: "stable" });
  const ch = r.channel as ChannelSummary;
  assert.equal(ch.name, "stable");
});

test("human_read_positions are updated on channel rename", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "reads" });
  // Post a message without a mention (just a channel post)
  await human.request("channel_send", { channel: "reads", text: "hello everyone" });

  // Mark the channel read
  const readState = await human.request("read_state", { scope: "channel", channel: "reads" });
  const state = readState.state as { version: number; position: number };
  await human.request("mark_read", { scope: "channel", channel: "reads", through: state.position, expectedVersion: state.version });

  // Rename the channel
  await human.request("channel_rename", { channel: "reads", name: "reads-new" });

  // Read state should be available on new name
  const newReadState = await human.request("read_state", { scope: "channel", channel: "reads-new" });
  assert.ok(newReadState.state);
});
