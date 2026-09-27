import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AsenqClient } from "../shared/client.js";
import { zodShape } from "../shared/schema.js";
import { callTool, isToolError, TOOLS } from "../shared/tools.js";
import { version } from "../shared/version.js";

/** `asenq mcp`: stdio MCP server exposing the asenq tools to one Claude Code session. */
export async function runMcp(): Promise<void> {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  let attached: Promise<void> | undefined;
  const client = new AsenqClient({
    autoStart: true,
    onReconnect: async () => {
      if (sessionId) await client.request("claude_attach", { sessionId });
    },
  });
  // Attach lazily: the SessionStart hook may still be registering this session when the server starts.
  const attach = (): Promise<void> => {
    if (!attached) {
      attached = client.request("claude_attach", { sessionId }).then(() => undefined);
      attached.catch(() => { attached = undefined; });
    }
    return attached;
  };

  const server = new McpServer({ name: "asenq", version: version() });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: zodShape(z, tool.params) },
      async (args: Record<string, unknown>) => {
        let text: string;
        if (!sessionId) {
          text = "asenq error (no_session): CLAUDE_CODE_SESSION_ID not set; Claude Code >= 2.1.224 required";
        } else {
          try {
            await attach();
            text = await callTool(client, tool.name, args);
          } catch (e) {
            const code = e && typeof e === "object" && "code" in e ? String(e.code) : "internal";
            text = `asenq error (${code}): ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        return { content: [{ type: "text" as const, text }], ...(isToolError(text) ? { isError: true } : {}) };
      },
    );
  }
  await server.connect(new StdioServerTransport());
}
