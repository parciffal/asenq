import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AsenqClient } from "../src/shared/client.js";
import { startEnv, type TestEnv } from "./helpers.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

// --- Client unit tests for maxReconnects / onDisconnect ---

test("client reports one disconnect before reconnect attempts exhaust", async () => {
  const env = await startEnv();
  try {
    let disconnects = 0;
    const limited = new AsenqClient({
      maxReconnects: 2,
      onDisconnect: () => { disconnects++; },
      schedule: (fn) => { setTimeout(fn, 5); },
    });
    await limited.connect();
    await limited.request("hello", { protocol: 1 });
    await env.daemon.close();
    // Wait for reconnects to exhaust (2 * ~5ms each + overhead)
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(disconnects, 1, "one callback for the socket drop, not for each failed retry");
    limited.close();
  } finally {
    await env.close();
  }
});

test("client reports disconnect without a retry limit", async () => {
  const env = await startEnv();
  try {
    let disconnects = 0;
    let attempts = 0;
    const unlimited = new AsenqClient({
      onDisconnect: () => { disconnects++; },
      schedule: (fn) => {
        attempts++;
        if (attempts < 4) setTimeout(fn, 5);
        // stop scheduling to let the test finish
      },
    });
    await unlimited.connect();
    await unlimited.request("hello", { protocol: 1 });
    await env.daemon.close();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(disconnects, 1, "callback fires for the socket drop regardless of retry limit");
    assert.ok(attempts >= 2, `made ${attempts} reconnect attempts`);
    unlimited.close();
  } finally {
    await env.close();
  }
});

// --- CLI tail test ---

test("tail reports disconnect before reconnecting", async () => {
  const env = await startEnv();
  try {
    writeFileSync(
      join(env.home, "config.json"),
      JSON.stringify({ runtime: process.execPath, cli, historyDays: 7, queueTtlMs: 60000, claude: { envelope: false } }),
    );

    const child = nodeSpawn(process.execPath, [cli, "tail"], {
      env: { ...process.env, ASENQ_HOME: env.home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
    const count = (line: string) => stderr.split(line).length - 1;
    const waitForCount = async (line: string, expected: number): Promise<void> => {
      if (count(line) >= expected) return;
      await new Promise<void>((resolve, reject) => {
        // Integration test: reconnect uses the child process's real timer, so bound the wait.
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${line} #${expected}`)), 5000);
        const check = () => {
          if (count(line) >= expected) {
            clearTimeout(timer);
            child.stderr!.off("data", check);
            resolve();
          }
        };
        child.stderr!.on("data", check);
      });
    };

    try {
      await waitForCount("asenq tail: connected", 1);
      await env.restart();
      await waitForCount("asenq tail: disconnected", 1);
      await waitForCount("asenq tail: connected", 2);
      assert.equal(count("asenq tail: disconnected"), 1, "one disconnect marker for one socket drop");
    } finally {
      child.kill();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  } finally {
    await env.close();
  }
});
