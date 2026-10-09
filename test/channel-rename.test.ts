import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { PROTOCOL, type ChannelSummary, type ReadState, type SessionIdentity, type StoredMessage, type TailEvent } from "../src/shared/protocol.js";
import { Store } from "../src/daemon/store.js";
import { openDb } from "../src/shared/sqlite.js";
import { startEnv, type TestEnv } from "./helpers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

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
  await human.request("channel_send", { channel: "old-ch", text: "hello @alpha" });
  await w.nextDelivery();

  const watcher = await env.watch(
    (e: TailEvent) => e.type === "channel" && e.action === "renamed",
  );

  const r = await human.request("channel_rename", { channel: "old-ch", name: "new-ch" });
  const renamed = r.channel as ChannelSummary;
  assert.equal(renamed.name, "new-ch");

  const note = await w.nextDelivery();
  assert.equal(note.msg.text, "channel old-ch is now new-ch");
  assert.equal(note.msg.from, "asenq");

  const event = await watcher.event;
  assert.equal(event.type, "channel");
  assert.ok(event.type === "channel" && event.action === "renamed");
  assert.ok(event.type === "channel" && event.oldName === "old-ch");
  assert.ok(event.type === "channel" && event.channel.name === "new-ch");

  const members = (await human.request("channel_members", { channel: "new-ch" })).members as SessionIdentity[];
  assert.equal(members.length, 1);
  assert.equal(members[0].name, "alpha");

  await assert.rejects(
    human.request("channel_members", { channel: "old-ch" }),
    { code: "channel_renamed" },
  );

  const read = await human.request("channel_read", { channel: "new-ch" });
  const posts = read.messages as { text: string; to: string }[];
  assert.ok(posts.some((m) => m.text === "hello @alpha"));
  assert.ok(posts.every((m) => m.to === "#new-ch"), "to_name should be rewritten");

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
  await assert.rejects(
    human.request("channel_rename", { channel: "valid", name: "human" }),
    { code: "invalid_name" },
  );
});

test("mention to renamed-away channel returns channel_renamed, not unknown_mention", async () => {
  env = await startEnv();
  const human = env.human();
  const w = await env.adapter("omp", "k1", "alpha");
  await human.request("channel_create", { channel: "old" });
  await human.request("channel_add", { channel: "old", name: "alpha" });
  await human.request("channel_rename", { channel: "old", name: "current" });

  try {
    await human.request("channel_send", { channel: "old", text: "@alpha hi" });
    assert.fail("expected channel_renamed error");
  } catch (e: unknown) {
    const err = e as { code: string; message: string };
    assert.equal(err.code, "channel_renamed");
    assert.equal(err.message, 'channel "old" was renamed to "current"');
  }
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

  for (const old of ["aaa", "bbb"]) {
    try {
      await human.request("channel_send", { channel: old, text: "should fail" });
      assert.fail("expected channel_renamed error");
    } catch (e: unknown) {
      const err = e as { code: string; message: string };
      assert.equal(err.code, "channel_renamed");
      assert.equal(err.message, `channel "${old}" was renamed to "ccc"`);
    }
  }
});

test("explicit channel create allows sends to old name again", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "reusable" });
  await human.request("channel_rename", { channel: "reusable", name: "moved" });

  await assert.rejects(
    human.request("channel_send", { channel: "reusable", text: "blocked" }),
    { code: "channel_renamed" },
  );

  await human.request("channel_create", { channel: "reusable" });
  await human.request("channel_send", { channel: "reusable", text: "unblocked" });
});

test("renaming back to the old name clears the rename record", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "original" });
  await human.request("channel_rename", { channel: "original", name: "temporary" });
  await human.request("channel_rename", { channel: "temporary", name: "original" });

  await human.request("channel_send", { channel: "original", text: "unblocked" });
  await assert.rejects(
    human.request("channel_send", { channel: "temporary", text: "blocked" }),
    { code: "channel_renamed", message: 'channel "temporary" was renamed to "original"' },
  );
});

test("auto-create of an unrelated new name still works", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "existing" });
  await human.request("channel_rename", { channel: "existing", name: "renamed" });

  await human.request("channel_send", { channel: "brand-new", text: "auto-created" });
  const list = (await human.request("channel_list")).channels as ChannelSummary[];
  assert.ok(list.some((c) => c.name === "brand-new"));
});

test("send/read to old name fails after rename and old name can be re-created", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "ephemeral" });
  await human.request("channel_rename", { channel: "ephemeral", name: "permanent" });

  await assert.rejects(human.request("channel_members", { channel: "ephemeral" }), { code: "channel_renamed" });
  await assert.rejects(human.request("channel_send", { channel: "ephemeral", text: "fail" }), { code: "channel_renamed" });

  await human.request("channel_create", { channel: "ephemeral" });
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

test("human_read_positions move to new name with correct position", async () => {
  env = await startEnv();
  const human = env.human();
  const poster = await env.adapter("omp", "k1", "poster");
  await human.request("channel_create", { channel: "reads" });
  await human.request("channel_add", { channel: "reads", name: "poster" });
  // Post from a non-human session so there is a non-zero eligible position
  await poster.client.request("channel_send", { channel: "reads", text: "from poster" });

  // Get the initial state and mark through the latest eligible position
  const initial = (await human.request("read_state", { scope: "channel", channel: "reads" })).state as ReadState;
  assert.equal(initial.unread, 1, "one unread message from the poster");
  const latestOrd = env.daemon.store.latestEligible({ scope: "channel", channel: "reads" });
  assert.ok(latestOrd > 0, "latest eligible position should be non-zero");
  await human.request("mark_read", { scope: "channel", channel: "reads", through: latestOrd, expectedVersion: initial.version });

  const marked = (await human.request("read_state", { scope: "channel", channel: "reads" })).state as ReadState;
  assert.equal(marked.position, latestOrd, "position should match after mark_read");

  await human.request("channel_rename", { channel: "reads", name: "reads-new" });

  // Check at store level: new name has the position, old name has no row
  const newRow = env.daemon.store.db.get<{ position: number }>(
    "SELECT position FROM human_read_positions WHERE scope='channel' AND stream_key='reads-new'",
  );
  assert.ok(newRow, "read position row should exist under new name");
  assert.equal(newRow!.position, latestOrd, "position should match the original");

  const oldRow = env.daemon.store.db.get<{ position: number }>(
    "SELECT position FROM human_read_positions WHERE scope='channel' AND stream_key='reads'",
  );
  assert.equal(oldRow, undefined, "no read position row should remain under old name");
});

test("source_channel is rewritten on channel rename", async () => {
  env = await startEnv();
  const human = env.human();
  const w = await env.adapter("omp", "k1", "alpha");
  await human.request("channel_create", { channel: "src-ch" });
  await human.request("channel_add", { channel: "src-ch", name: "alpha" });
  await human.request("channel_send", { channel: "src-ch", text: "@alpha check this" });
  const delivery = await w.nextDelivery();
  assert.equal(delivery.msg.sourceChannel, "src-ch");

  await human.request("channel_rename", { channel: "src-ch", name: "dst-ch" });
  await w.nextDelivery();

  const log = await human.request("log", { msgId: delivery.msg.id });
  const msg = (log.messages as StoredMessage[])[0];
  assert.equal(msg.sourceChannel, "dst-ch");
});

test("to_name of channel posts is rewritten on rename", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "tgt" });
  await human.request("channel_send", { channel: "tgt", text: "post content" });
  await human.request("channel_rename", { channel: "tgt", name: "tgt-new" });

  const read = await human.request("channel_read", { channel: "tgt-new" });
  const posts = read.messages as { to: string }[];
  assert.ok(posts.length > 0);
  assert.ok(posts.every((m) => m.to === "#tgt-new"));
});

test("channel_read and channel_add on renamed-away name return channel_renamed", async () => {
  env = await startEnv();
  const human = env.human();
  const w = await env.adapter("omp", "k1", "alpha");
  await human.request("channel_create", { channel: "old-rw" });
  await human.request("channel_rename", { channel: "old-rw", name: "new-rw" });

  await assert.rejects(human.request("channel_read", { channel: "old-rw" }), { code: "channel_renamed" });
  await assert.rejects(human.request("channel_add", { channel: "old-rw", name: "alpha" }), { code: "channel_renamed" });
});

test("channel_read on a never-existed channel returns empty messages", async () => {
  env = await startEnv();
  const human = env.human();
  const r = await human.request("channel_read", { channel: "imaginary" });
  assert.deepEqual(r.messages, []);
});

test("Store opens an existing DB without channel_renames table and creates it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "asenq-schema-"));
  try {
    const db = await openDb(join(dir, "asenq.db"));
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions(
        id TEXT PRIMARY KEY, harness TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL UNIQUE,
        cwd TEXT, inbound TEXT NOT NULL DEFAULT 'accept', state TEXT NOT NULL,
        gone_at INTEGER, claude_socket TEXT, claude_session_ids TEXT NOT NULL DEFAULT '[]',
        claude_transcript_path TEXT, claude_source TEXT, claude_lineage_state INTEGER NOT NULL DEFAULT 1,
        busy INTEGER, claude_current_session_id TEXT,
        created_at INTEGER NOT NULL, UNIQUE(harness, key));
      CREATE TABLE IF NOT EXISTS messages(
        id TEXT PRIMARY KEY, from_name TEXT NOT NULL, from_session TEXT, to_name TEXT NOT NULL, to_session TEXT,
        channel TEXT, source_channel TEXT, text TEXT NOT NULL, file TEXT, kind TEXT, action TEXT, thread TEXT, reply_to TEXT, reset TEXT, reset_result TEXT,
        done INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, reason TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ord INTEGER, delivery_seq INTEGER);
      CREATE TABLE IF NOT EXISTS session_identities(
        id TEXT PRIMARY KEY, harness TEXT NOT NULL, name TEXT NOT NULL, previous_names TEXT NOT NULL DEFAULT '[]',
        cwd TEXT, inbound TEXT NOT NULL DEFAULT 'accept', state TEXT NOT NULL, role TEXT,
        created_at INTEGER NOT NULL, removed_at INTEGER, closed_at INTEGER, last_direct_at INTEGER,
        inbox_position INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER);
      CREATE TABLE IF NOT EXISTS session_harness_ids(
        harness TEXT NOT NULL, kind TEXT NOT NULL, harness_id TEXT NOT NULL, identity_id TEXT NOT NULL,
        PRIMARY KEY(harness,kind,harness_id));
      CREATE TABLE IF NOT EXISTS claude_lineage(
        fingerprint TEXT NOT NULL, identity_id TEXT NOT NULL, PRIMARY KEY(fingerprint,identity_id));
      CREATE TABLE IF NOT EXISTS channels(name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS channel_members(
        channel TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(channel,session_id));
      CREATE TABLE IF NOT EXISTS human_read_positions(
        scope TEXT NOT NULL, stream_key TEXT NOT NULL, position INTEGER NOT NULL,
        reminder INTEGER, version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(scope, stream_key));
      CREATE TABLE IF NOT EXISTS protocol_events(
        position INTEGER PRIMARY KEY, event_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS protocol_meta(
        key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `);
    const before = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='channel_renames'");
    assert.equal(before.length, 0);
    const store = new Store(db);
    const after = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='channel_renames'");
    assert.equal(after.length, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
