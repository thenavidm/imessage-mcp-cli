#!/usr/bin/env node
/**
 * Both binaries. `imessage-mcp` with no arguments serves MCP over stdio, and
 * any command runs one tool from the shell. The server must stay silent on
 * stdout, which is the protocol channel.
 *
 * Node's compile cache goes on before the app loads, so every launch after the
 * first skips compiling it again. NODE_DISABLE_COMPILE_CACHE=1 turns it off.
 */

import * as nodeModule from "node:module";

nodeModule.enableCompileCache?.();

// Over HTTP this server hands out messages it reads with Full Disk Access, to
// any program that can reach the port, which on this Mac includes programs
// without that access. So it refuses HTTP without a bearer token, even on
// 127.0.0.1, where Slipway would otherwise allow it.
if (process.argv.includes("--http") && !process.env.IMESSAGE_HTTP_TOKEN?.trim()) {
  process.stderr.write(
    "IMESSAGE_HTTP_TOKEN is not set. Over HTTP this server reads your messages for any program that can reach the port, so it refuses to start without a bearer token. Generate one with: openssl rand -hex 32\n",
  );
  process.exit(10);
}

const { app } = await import("./app.js");
await app.main();
