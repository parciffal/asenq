#!/usr/bin/env node
// Commands load lazily: the version gate below must run before any node:sqlite code, and
// `asenq hook claude` runs on every Claude tool call, so it must not load the MCP SDK or setup code.
const [major, minor] = process.versions.node.split(".").map(Number);
if (!process.versions.bun && (major < 22 || (major === 22 && minor < 13))) {
  process.stderr.write("asenq requires Node >= 22.13 or Bun\n");
  process.exit(1);
}

const USAGE = `usage: asenq <command>

  ls [--cwd prefix] [--harness claude|omp|opencode] [--channel name]  list sessions
  send <name|*|human> <text…>          send as the user [--kind k] [--action pause|resume|cancel] [--thread t] [--reply-to id] [--done]
  tail                                 follow messages, sessions and channel events
  log [--session name] [--id msgId] [--limit n]
  inbox                                messages addressed to "human"
  rename <old> <new>
  close <name|identity>                 terminally archive a session
  purge <name|identity> | purge --all    permanently delete archived conversations
  inbound <name> accept|hold|refuse
  role <name> orchestrator|worker|unset
  held [name] | release <msgId> | drop <msgId>
  channels                             list channels, including those with no posts
  channel create <ch>                   create an empty channel
  channel add <ch> <name>               add a live session
  channel remove <ch> <name>            remove a member by current or former name
  channel remove <ch> --session-id <id> remove a member by stable identity
  channel members <ch>                  list names, roles, states and identity IDs
  channel read <ch> [--limit n] | channel send <ch> <text…>
  daemon run|start|stop|status
  setup [--remove]
  tui                                  interactive human messaging console
  doctor`;

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(USAGE + "\n");
    return cmd ? 0 : 1;
  }
  if (cmd === "--version" || cmd === "-v") {
    const { version } = await import("./shared/version.js");
    process.stdout.write(version() + "\n");
    return 0;
  }
  if (cmd === "hook") {
    const { claudeHook } = await import("./hooks/claude.js");
    return claudeHook(argv[1]);
  }
  if (cmd === "mcp") {
    const { runMcp } = await import("./mcp/claude.js");
    await runMcp();
    return -1;
  }
  if (cmd === "setup") {
    const { setup } = await import("./setup/setup.js");
    return setup(argv.slice(1));
  }
  if (cmd === "doctor") {
    const { doctor } = await import("./doctor.js");
    return doctor();
  }
  if (cmd === "tui") {
    // Lazy by design: hook and MCP invocations must not initialize terminal input or renderer dependencies.
    const { runTui } = await import("./tui/app.js");
    return runTui();
  }
  const { runCommand } = await import("./cli/commands.js");
  return runCommand(cmd, argv.slice(1), USAGE);
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e: unknown) => {
    process.stderr.write(`asenq: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
