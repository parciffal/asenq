import assert from "node:assert/strict";
import { test } from "node:test";
import { AsenqClient } from "../src/shared/client.js";
import type { ListedSession } from "../src/shared/protocol.js";
import { startEnv } from "./helpers.js";

test("matched pong records contact only for its target, not shared peers or an unvalidated pong", async () => {
  const env = await startEnv({ pingTimeoutMs: 100 });
  const pushed = Promise.withResolvers<string>();
  const shared = new AsenqClient({
    onPush: (event) => {
      if (event.push === "ping") pushed.resolve(event.pingId);
    },
  });
  try {
    const human = env.human();
    const stranger = env.human();
    const alpha = (await shared.request("register", { harness: "opencode", key: "alpha-id", name: "alpha", caps: ["ping"] })).session as { id: string };
    env.clock.advance(5);
    await shared.request("register", { harness: "opencode", key: "beta-id", name: "beta", caps: ["ping"] });
    const contacts = async () => {
      const rows = (await human.request("list")).sessions as ListedSession[];
      return [rows.find((row) => row.name === "alpha")!.lastSeen, rows.find((row) => row.name === "beta")!.lastSeen];
    };
    const pending = human.request("ping", { sessionId: alpha.id });
    const pingId = await pushed.promise;
    env.clock.advance(10);
    // Whether an unmatched pong is ignored or rejected is not the contact contract.
    await stranger.request("pong", { pingId }).catch(() => {});
    assert.deepEqual(await contacts(), [1_700_000_000_000, 1_700_000_000_005]);
    env.clock.advance(10);
    await shared.request("pong", { pingId });
    assert.deepEqual((await pending).results, [{ sessionId: alpha.id, name: "alpha", ping: "responding" }]);
    assert.deepEqual(await contacts(), [1_700_000_000_025, 1_700_000_000_005]);
    env.clock.advance(10);
    await shared.request("pong", { pingId: "unknown-ping" }).catch(() => {});
    assert.deepEqual(await contacts(), [1_700_000_000_025, 1_700_000_000_005]);
  } finally {
    shared.close();
    await env.close();
  }
});
