// The subset of @opencode-ai/plugin 1.18.x types asenq uses, copied to avoid its heavy dependency tree.
import type { ZodType } from "zod";

/** hey-api SDK calls resolve `{ data }` on success and `{ error }` on HTTP errors instead of throwing. */
export type SdkResult<T> = { data?: T; error?: unknown };

export type SessionInfo = { id: string; parentID?: string; title?: string; directory?: string };

export type OpencodeClient = {
  session: {
    get(opts: { path: { id: string } }): Promise<SdkResult<SessionInfo>>;
    promptAsync(opts: { path: { id: string }; body: { parts: { type: "text"; text: string }[] } }): Promise<SdkResult<unknown>>;
  };
  app: {
    log(opts: { body: { service: string; level: "debug" | "info" | "warn" | "error"; message: string } }): Promise<unknown>;
  };
};

export type PluginInput = { client: OpencodeClient; directory: string; worktree: string };

export type ToolContext = { sessionID: string; messageID: string; agent: string; directory: string; worktree: string };

export type ToolDefinition = {
  description: string;
  args: Record<string, ZodType>;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<string>;
};

export type OpencodeEvent = { type: string; properties?: Record<string, unknown> };

export type Hooks = {
  tool?: Record<string, ToolDefinition>;
  event?(input: { event: OpencodeEvent }): Promise<void>;
  dispose?(): Promise<void>;
};
