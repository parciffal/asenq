// The subset of @opencode-ai/plugin 1.18.x types asenq uses, copied to avoid its heavy dependency tree.
import type { ZodType } from "zod";

/** hey-api SDK calls resolve `{ data }` on success and `{ error }` on HTTP errors instead of throwing. */
export type SdkResult<T> = { data?: T; error?: unknown };

export type SessionInfo = { id: string; parentID?: string; title?: string; directory?: string };

/** Message info as far as the adapter reads it: a user carries a nested model, an assistant a top-level pair. */
export type OpencodeMessageInfo =
  | { role: "user"; model?: { providerID?: string; modelID?: string } }
  | { role: "assistant"; providerID?: string; modelID?: string };

export type OpencodeMessage = { info: OpencodeMessageInfo };

export type OpencodeClient = {
  session: {
    get(opts: { path: { id: string } }): Promise<SdkResult<SessionInfo>>;
    promptAsync(opts: { path: { id: string }; body: { parts: { type: "text"; text: string }[] } }): Promise<SdkResult<unknown>>;
    /** Optional: only SDK builds that can list history expose it. Used to pick the model for compaction (#39). */
    messages?(opts: { path: { id: string } }): Promise<SdkResult<OpencodeMessage[]>>;
    /** Optional: only SDK builds that can compact expose it. Compaction declares the `compact` cap (#39). */
    summarize?(opts: { path: { id: string }; body: { providerID: string; modelID: string } }): Promise<SdkResult<boolean>>;
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
