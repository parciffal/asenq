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

test("client calls onDisconnect after maxReconnects consecutive failures", async () => {
  const env = await startEnv();
  try {
    let disconnected = false;
    const limited = new AsenqClient({
      maxReconnects: 2,
      onDisconnect: () => { disconnected = true; },
      schedule: (fn) => { setTimeout(fn, 5); },
    });
    await limited.connect();
    await limited.request("hello", { protocol: 1 });
    await env.daemon.close();
    // Wait for reconnects to exhaust (2 * ~5ms each + overhead)
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(disconnected, "onDisconnect was called");
    limited.close();
  } finally {
    await env.close();
  }
});

test("client without maxReconnects does not call onDisconnect", async () => {
  const env = await startEnv();
  try {
    let disconnected = false;
    let attempts = 0;
    const unlimited = new AsenqClient({
      onDisconnect: () => { disconnected = true; },
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
    assert.ok(!disconnected, "onDisconnect not called without maxReconnects");
    assert.ok(attempts >= 2, `made ${attempts} reconnect attempts`);
    unlimited.close();
  } finally {
    await env.close();
  }
});

// --- CLI tail test ---

test("tail prints connected on stderr after successful subscribe", async () => {
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

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error("timeout")); }, 5000);
        child.stderr!.on("data", () => {
          if (stderr.includes("asenq tail: connected")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    } finally {
      child.kill();
      // Wait for the child to exit
      await new Promise<void>((r) => child.on("exit", () => r()));
    }

    assert.ok(stderr.includes("asenq tail: connected"), "connected line on stderr");
  } finally {
    await env.close();
  }
});
