#!/usr/bin/env node
/**
 * Entry point.
 *
 * `imessage-mcp`          stdio, which is what MCP clients launch
 * `imessage-mcp doctor`   check Full Disk Access, contacts and the voice tools
 * `imessage-cli`          every tool as a shell command
 *
 * One entry point, two programs. `imessage-mcp` is the server and must stay
 * silent on stdout, which is the protocol channel. The CLI is picked by the
 * name it was invoked as, or by a first argument that names a tool.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { isCliCommand, runCli, toolNames } from "./cli.js";
import { CHAT_DB } from "./db.js";
import { buildServer, VERSION } from "./server.js";

const HELP = `imessage-mcp ${VERSION}

  imessage-mcp                     run over stdio (what an MCP client does)
  imessage-mcp doctor              check Full Disk Access, contacts and the voice tools
  imessage-mcp --version           print the version
  imessage-cli                     every tool as a shell command
  imessage-cli <command> --help    what one command takes

Mac only. The app that runs it needs Full Disk Access to read
~/Library/Messages/chat.db. Sending asks Messages through AppleScript, so the
first send also asks for Automation permission.

Optional:
  IMESSAGE_DB                   another chat.db, for testing
  IMESSAGE_TRANSCRIBE           voice note transcription: groq (default), local, openai or elevenlabs
  GROQ_API_KEY / OPENAI_API_KEY / ELEVENLABS_API_KEY   for that provider
  ELEVENLABS_VOICE_ID           the voice speak uses
`;

/** Invoked as the CLI binary rather than the server one. */
function invokedAsCli(): boolean {
  const name = (process.argv[1] ?? "").split("/").pop() ?? "";
  return name.startsWith("imessage-cli");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  // The CLI: every tool as a command, from the same server an MCP app talks
  // to. Checked first so `<tool> --help` reaches the tool.
  const cli =
    command !== undefined && !command.startsWith("-") && command !== "doctor" && command !== "help"
      ? invokedAsCli() || isCliCommand(argv, await toolNames())
      : invokedAsCli() && argv.length === 0;
  if (cli) {
    process.exitCode = await runCli(argv.length ? argv : ["tools"]);
    return;
  }

  if (argv.includes("--help") || argv.includes("-h") || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "doctor") {
    const { runDoctor } = await import("./doctor.js");
    process.exitCode = await runDoctor();
    return;
  }

  await buildServer().connect(new StdioServerTransport());
  process.stderr.write(`imessage-mcp ${VERSION} ready (db: ${CHAT_DB})\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
