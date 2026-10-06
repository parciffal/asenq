import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isObj, report } from "./jsonfile.js";

/** The skills asenq ships; setup owns their installed copies by these names. */
export const SKILL_NAMES = ["setup-asenq", "asenq-worker", "asenq-orchestrator", "asenq-recover"] as const;
export type SkillName = (typeof SKILL_NAMES)[number];
export type SkillState = "current" | "missing" | "outdated" | "edited" | "unowned";

/** Per-harness record of the skills asenq last wrote and their content hashes. */
const MANIFEST = ".asenq-skills.json";
type Manifest = Record<string, string>;

/** The shipped skills directory: `<package root>/skills`. */
export const skillsSourceDir = (): string => fileURLToPath(new URL("../../../skills", import.meta.url));

const digest = (content: Buffer | string): string => createHash("sha256").update(content).digest("hex");
const skillFile = (skillsDir: string, name: string): string => join(skillsDir, name, "SKILL.md");

export function readSkillManifest(skillsDir: string): Manifest | undefined {
  const path = join(skillsDir, MANIFEST);
  if (!existsSync(path)) return undefined;
  const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return isObj(data) ? (data as Manifest) : {};
}

function writeSkillManifest(skillsDir: string, manifest: Manifest): void {
  const path = join(skillsDir, MANIFEST);
  const text = JSON.stringify(manifest, null, 2) + "\n";
  if (existsSync(path) && readFileSync(path, "utf8") === text) return;
  writeFileSync(path, text);
}

/** Keeps the current on-disk copy at `<file>.asenq-bak`, replacing any earlier backup. */
function keepBackup(path: string): string {
  const backup = path + ".asenq-bak";
  copyFileSync(path, backup);
  return backup;
}

/**
 * Copies the shipped skills into `skillsDir`, overwriting asenq's own copies. A trained copy the
 * user edited is kept at `<SKILL.md>.asenq-bak` first; an unedited copy from an older package is
 * simply replaced.
 */
export function installSkills(skillsDir: string, source = skillsSourceDir()): void {
  const manifest = readSkillManifest(skillsDir) ?? {};
  for (const name of SKILL_NAMES) {
    const dest = skillFile(skillsDir, name);
    const content = readFileSync(join(source, name, "SKILL.md"));
    const hash = digest(content);
    const tracked = manifest[name];
    if (existsSync(dest)) {
      const destHash = digest(readFileSync(dest));
      if (destHash === hash) {
        manifest[name] = hash;
        report("=", `${dest} (unchanged)`);
        continue;
      }
      if (tracked !== undefined && tracked === destHash) {
        writeFileSync(dest, content);
        manifest[name] = hash;
        report("+", `${dest} (updated)`);
        continue;
      }
      const backup = keepBackup(dest);
      writeFileSync(dest, content);
      manifest[name] = hash;
      report("!", `${backup} (kept your copy of ${dest})`);
      continue;
    }
    mkdirSync(join(skillsDir, name), { recursive: true });
    writeFileSync(dest, content);
    manifest[name] = hash;
    report("+", dest);
  }
  writeSkillManifest(skillsDir, manifest);
}

/** Deletes only the skills this install recorded, preserving unrelated files and backups. */
export function removeSkills(skillsDir: string): void {
  const manifest = readSkillManifest(skillsDir);
  if (!manifest) return;
  for (const name of Object.keys(manifest)) {
    const dest = skillFile(skillsDir, name);
    if (!existsSync(dest)) continue;
    if (digest(readFileSync(dest)) !== manifest[name]) {
      report("!", `${keepBackup(dest)} (kept your copy of ${dest})`);
    }
    rmSync(dest);
    report("-", dest);
    const dir = join(skillsDir, name);
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir);
  }
  rmSync(join(skillsDir, MANIFEST));
}

/** Classifies each shipped skill against the installed copy and the ownership manifest. */
export function inspectSkills(skillsDir: string, source = skillsSourceDir()): { name: SkillName; state: SkillState }[] {
  const manifest = readSkillManifest(skillsDir) ?? {};
  return SKILL_NAMES.map((name) => {
    const dest = skillFile(skillsDir, name);
    if (!existsSync(dest)) return { name, state: "missing" as const };
    const shipped = digest(readFileSync(join(source, name, "SKILL.md")));
    const destHash = digest(readFileSync(dest));
    const tracked = manifest[name];
    if (tracked === undefined) return { name, state: "unowned" as const };
    if (destHash === shipped) return { name, state: "current" as const };
    if (destHash === tracked) return { name, state: "outdated" as const };
    return { name, state: "edited" as const };
  });
}
