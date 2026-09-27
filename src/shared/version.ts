import { readFileSync } from "node:fs";

let cached: string | undefined;
export function version(): string {
  if (cached) return cached;
  // dist/src/shared/version.js → package.json three levels up
  const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  return (cached = String(pkg.version));
}
