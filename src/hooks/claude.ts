import { AsenqClient } from "../shared/client.js";

type HookInput = {
  hook_event_name?: string;
  session_id?: string;
  session_title?: string;
  agent_id?: string;
  cwd?: string;
  reason?: string;
  transcript_path?: string;
  source?: string;
  stop_hook_active?: boolean;
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function run(): Promise<number> {
  const input = JSON.parse(await readStdin()) as HookInput;
  if (input.agent_id) return 0; // subagents are not on asenq
  const event = input.hook_event_name;
  const sessionId = input.session_id;
  if (!sessionId) return 0;
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET || null;

  if (event === "SessionStart") {
    const client = new AsenqClient({ autoStart: true });
    try {
      await client.request("claude_hook", {
        event: "start", key: socket ?? "sid:" + sessionId, sessionId, socket,
        name: process.env.ASENQ_NAME || input.session_title || undefined, cwd: input.cwd,
        transcriptPath: input.transcript_path, source: input.source, busy: null,
      });
    } finally {
      client.close();
    }
    return 0; // stdout on SessionStart would land in Claude's context
  }

  if (event === "SessionEnd") {
    if (input.reason === "clear" || input.reason === "resume") return 0; // same process continues
    const client = new AsenqClient();
    try {
      await client.request("claude_hook", { event: "end", sessionId });
    } finally {
      client.close();
    }
    return 0;
  }

  if (event === "PostToolUse" || event === "UserPromptSubmit" || event === "Stop") {
    const client = new AsenqClient();
    let texts: string[];
    try {
      const r = await client.request("claude_hook", {
        event: socket || (event === "Stop" && input.stop_hook_active) ? "reconcile" : "poll",
        sessionId, transcriptPath: input.transcript_path,
        ...(event === "UserPromptSubmit" ? { busy: true } : {}),
      });
      texts = (r.texts as string[] | undefined) ?? [];
      if (event === "Stop") {
        try {
          await client.request("claude_hook", {
            event: "reconcile", sessionId, transcriptPath: input.transcript_path, busy: texts.length > 0,
          });
        } catch {
          // A status failure must not discard texts already polled or prevent their continuation.
        }
      }
    } finally {
      client.close();
    }
    if (texts.length === 0) return 0;
    const joined = texts.join("\n\n");
    if (event === "Stop") {
      process.stderr.write(joined + "\n");
      return 2;
    }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: joined } }) + "\n");
    return 0;
  }
  return 0;
}

/** `asenq hook claude`: never fails the Claude hook; any error exits 0 silently. */
export async function claudeHook(harness: string | undefined): Promise<number> {
  if (harness !== "claude") return 0;
  try {
    return await run();
  } catch {
    return 0;
  }
}
