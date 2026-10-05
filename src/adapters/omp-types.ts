// The subset of omp's extension API (pi-coding-agent src/extensibility/extensions/types.ts, omp 18.x)
// asenq uses, copied to avoid depending on @oh-my-pi/pi-coding-agent.

/** omp's zod-compatible facade (`@oh-my-pi/omptype/zod`), not real zod. */
export type OmpZod = { object(shape: Record<string, unknown>): unknown } & Record<string, unknown>;

export type Timer = unknown;

export type ExtensionContext = {
  agent: { kind: "main" | "sub"; id: string; name: string; depth: number; parentId?: string };
  cwd: string;
  hasUI: boolean;
  sessionManager: { getSessionId(): string };
  ui: { setStatus(key: string, text: string | undefined): void };
  setTimeout(callback: () => void, ms?: number): Timer;
  clearTimer(timer: Timer): void;
};

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  defaultInactive?: boolean;
  loadMode?: "essential" | "discoverable";
  approval?: "read" | "write" | "exec";
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ): Promise<ToolResult>;
};

type Handler<E> = (event: E, ctx: ExtensionContext) => Promise<void> | void;

export type ExtensionAPI = {
  on(event: "session_start", handler: Handler<{ type: "session_start" }>): void;
  on(event: "session_switch", handler: Handler<{ type: "session_switch"; reason: "new" | "resume" | "fork" }>): void;
  on(event: "session_shutdown", handler: Handler<{ type: "session_shutdown" }>): void;
  on(event: "agent_start", handler: Handler<{ type: "agent_start" }>): void;
  on(event: "agent_end", handler: Handler<{ type: "agent_end"; messages: unknown[]; willContinue?: boolean }>): void;
  registerTool(tool: ToolDefinition): void;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" | "aside"; attribution?: "user" | "agent" }): void;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): Promise<void>;
  zod: { z: OmpZod };
  logger: { warn(message: string, ...args: unknown[]): void; debug(message: string, ...args: unknown[]): void };
};
