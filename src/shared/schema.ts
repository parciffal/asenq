import type * as zod from "zod";
import type { ParamSpec } from "./tools.js";

export type Zod = typeof zod.z;

/**
 * Builds a zod raw shape from a tool's params. The zod instance is injected because each
 * harness validates with its own copy (omp exposes `pi.zod`).
 */
export function zodShape(z: Zod, params: Record<string, ParamSpec>): Record<string, zod.ZodType> {
  const shape: Record<string, zod.ZodType> = {};
  for (const [key, p] of Object.entries(params)) {
    let t: zod.ZodType;
    if (p.type === "boolean") t = z.boolean();
    else if (p.type === "object") t = z.object(zodShape(z, p.properties));
    else if (p.type === "integer") {
      let n = z.number().int();
      if (p.min !== undefined) n = n.min(p.min);
      if (p.max !== undefined) n = n.max(p.max);
      t = n;
    } else if (p.enum) t = z.enum(p.enum as [string, ...string[]]);
    else t = z.string();
    t = t.describe(p.description);
    shape[key] = p.optional ? t.optional() : t;
  }
  return shape;
}
