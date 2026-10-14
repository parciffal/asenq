import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CityHost } from "./host.js";
import { startCityServer } from "./server.js";
import type { CityServer } from "./server.js";

export async function runCity(args: string[]): Promise<number> {
  let port = 0;
  let noOpen = false;
  let reducedMotion = false;
  try {
    const { values } = parseArgs({
      args, strict: true, allowPositionals: false,
      options: { port: { type: "string" }, "no-open": { type: "boolean" }, "reduced-motion": { type: "boolean" } },
    });
    if (values.port !== undefined) {
      if (!/^\d+$/.test(values.port)) throw new Error("invalid port");
      port = Number(values.port);
      if (!Number.isInteger(port) || port > 65535) throw new Error("invalid port");
    }
    noOpen = values["no-open"] ?? false;
    reducedMotion = values["reduced-motion"] ?? false;
  } catch {
    process.stderr.write("usage: asenq city [--port n] [--no-open] [--reduced-motion]\n");
    return 1;
  }
  const host = new CityHost({ reducedMotion });
  let server: CityServer;
  try {
    server = await startCityServer(host, {
      port, token: randomBytes(24).toString("base64url"),
      root: fileURLToPath(new URL("../../../web/city/", import.meta.url)),
    });
  } catch (error) {
    host.close();
    process.stderr.write(`asenq city: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const done = Promise.withResolvers<number>();
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    host.close();
    void server.close().then(() => done.resolve(0), done.reject);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    host.start();
    process.stdout.write(`asenq city: ${server.url}\npress Ctrl-C to stop\n`);
    if (!noOpen) {
      const [command, browserArgs] = process.platform === "darwin" ? ["open", [server.url]]
        : process.platform === "win32" ? ["cmd", ["/c", "start", "", server.url]] : ["xdg-open", [server.url]];
      try {
        const browser = spawn(command, browserArgs, { detached: true, stdio: "ignore" });
        browser.on("error", () => {});
        browser.unref();
      } catch { /* Browser launch is optional; the printed URL remains usable. */ }
    }
    return await done.promise;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    host.close();
    await server.close();
  }
}
