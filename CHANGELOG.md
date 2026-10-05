# iMessage MCP Server & CLI changelog

| Component | Version | Last Updated |
|-----------|---------|--------------|
| imessage-mcp-cli | 0.4.0 | 2026-10-05 |
| `@thenavidm/slipway` | 0.1.22 | 2026-10-05 |
| Node | >= 22.13 | 2026-10-05 |

---

## 0.4.0, 2026-10-05

Built on [Slipway](https://github.com/thenavidm/slipway) 0.1.22. The 10 tools keep their names and arguments, and every difference below was measured against 0.3.1, the last version on npm, before release. Every measurement ran with an empty home folder and a stand-in for `osascript`, so none of them read a message, a contact or anything else on this Mac, and none could reach Messages.

- **`which <words>` finds a command**, and `agent-context` describes every command, flag and setting as JSON. In Codex 0.159.3, finding the command that reads one conversation in order, and its flags, took a median of 53,154 input tokens over the CLI instead of 71,239 (five runs each). Every 0.3.1 run read the general help, the command list and then the command's help; every 0.4.0 run read the general help and asked `which`, which answered with the command's help: two commands instead of three, and each one carries the conversation so far.
- **A person approves every send over MCP.** `send_message`, `send_file`, and `speak` with a recipient, still need confirmation. Claude Code (2.1.246 and later) shows its own prompt, and a client that can show forms asks with an approval form that shows the recipient and the words themselves, or the file, and whose one box starts unticked. Approvals are signed, bound to the exact call and work once. Where a client can do neither, the model's `confirm: true` still counts, and `IMESSAGE_CONFIRM=model` makes it enough everywhere. `IMESSAGE_ALLOW_DESTRUCTIVE=0` refuses every send, confirmed or not.
- **The audit log records who approved each send.** Each line has the tool, a summary naming the recipient and the message's length, the outcome and who confirmed it, and a line follows when the send is done or failed. As in 0.3.1, never the words.
- **A provider's key or a tool that is not set up exits 10**, where 0.3.1 exited 5: no `GROQ_API_KEY` for the default transcription, no ElevenLabs voice for `speak`, no ffmpeg or whisper. macOS refusing access still exits 4, a file that is not there 3, and Messages or a provider failing 5. 1 now means an unexpected error.
- **Smaller answers, and failures as JSON.** `server_status` answers in compact JSON, where 0.3.1 indented it, and a failure is JSON with Slipway's `code`, where 0.3.1 sent the message alone.
- **Clients learn more about each tool.** Each one has a title, its annotations say whether it reads, writes or cannot be undone, and the three sends carry the mark that has Claude Code ask a person. `inbox` is marked read-only, since it moves only its own cursor: 0.3.1 already kept it in read-only mode but told clients it wrote. That makes the tool list larger on the wire, 1,637 o200k tokens instead of 1,379, but Claude Code and Codex give the model only each tool's name, description and schema, and with every tool loaded Claude Code 2.1.286 spends 1,750 tokens a message instead of 1,782.
- **Less to install and start.** npx installs 4 packages instead of 94: Slipway brings the MCP SDK's 2.x server package, which carries no web framework. The entry turns on Node's compile cache, and the server spends 158 ms of CPU before its first answer where 0.3.1 spent 165, and answers in 114 ms of wall time instead of 117 (median of 41 runs, taking turns on one Mac).
- **`--http` serves MCP over HTTP**, which 0.3.1 could not, and refuses to start without `IMESSAGE_HTTP_TOKEN`, even on 127.0.0.1: over HTTP the server reads your messages for any program that can reach the port, including programs without Full Disk Access. It also refuses a page from another site unless `IMESSAGE_HTTP_ALLOWED_ORIGINS` lists it.
- **0.3.1's flag spellings still answer**, `--chat-id` as well as `--chatId`. `install <client>` adds the server to Claude Code, Codex, Claude Desktop, Cursor, VS Code or Gemini CLI in each one's own format, and `doctor` runs 0.3.1's checks: the database, Contacts, the cursor, ffmpeg, transcription and speech.
- **Docs.** The README's costs are measured against 0.3.1, where they were 2026-09-27's, and its settings table now lists `OPENAI_WHISPER_MODEL`, `ELEVENLABS_MODEL_ID` and `ELEVENLABS_STT_MODEL`, which 0.3.1 read but never documented, and every setting Slipway adds. `SKILL.md` lists `which` and exit codes 1 and 10, says how a send is approved now, and costs 2,206 tokens in Claude Code instead of 2,235.

### Upgrading

Node 22.13 or later, as before. Over MCP, expect an approval prompt or form before each send; a headless agent that should send with `confirm: true` alone needs `IMESSAGE_CONFIRM=model`. A refusal names the recipient and the message's length and no longer quotes the words, because the same line goes into the audit log. A script that read exit 5 as a missing key should read 10. An error in the terminal is one JSON object with `error`, Slipway's `code` (`usage`, `refused`, `auth`, `not_found`, `timeout`, `api`, `not_configured`) and often a `hint`; over MCP an error is that JSON, where 0.3.1 sent its message as plain text. With `IMESSAGE_READ_ONLY=1`, a client that calls a hidden send gets "tool not found", and that call is not in the audit log; the CLI still names the setting. The audit log's lines carry `summary`, `surface`, `risk` and `confirmed_by` where 0.3.1 wrote `to` and `chars`. Each send's `confirm` argument now reads "Set true only when the user asked for exactly this action." The server now tells clients its name is `imessage`, where 0.3.1 said `imessage-mcp`. A missing argument's error is 15 tokens longer, for its code and a hint.

## 0.3.1, 2026-10-04

- **`npx -y @thenavidm/imessage-mcp-cli` always starts the MCP server.** npx starts whichever binary the npm registry lists first when they share one file, and the registry does not keep the published order, so an MCP client set up with this README's install line could get `imessage-cli` and its command list instead of a server. A third binary named after the package now always starts the server, and npx picks it by name.

## 0.3.0

**Every send asks first.** `send_message`, `send_file` and `speak` with a recipient refuse to run without `confirm: true`, and the refusal names the recipient and the text, so an agent can show you what would go. Before this, sending relied on SKILL.md telling the model to check with you, which is guidance rather than a gate. The CLI says `--confirm`.

**`IMESSAGE_READ_ONLY=1`** takes the 3 sending tools off the list. Reading and the inbox still work.

**`IMESSAGE_AUDIT_LOG`** records every send attempt, allowed or blocked, as one JSON line with the recipient and the length, never the words.

**The README's sections are numbered 1 to 11** again, with no gap before Troubleshooting.

## 0.2.0

**Runs on Node, and ships on npm.** 0.1.0 needed Bun and a git clone. The Bun calls are replaced: `bun:sqlite` by a small shim over Node's built-in `node:sqlite` that keeps every query as it was, and the process and file calls by their Node equivalents. Messages stores dates as nanoseconds since 2001, beyond JavaScript's safe integers: `node:sqlite` refuses those unless it reads BigInts, so the shim reads BigInts and rounds them the way Bun did. Checked against the original on a real library: the conversation list, a search and a conversation come back byte-identical. Node 22.13 or newer.

**A CLI.** `imessage-cli` runs every tool as a shell command, through the same server over the SDK's in-memory transport.

**Tool annotations.** Every tool now says whether it reads, writes or cannot be undone, so an app can show it before a call. Otherwise the tool list is unchanged.

**Full Disk Access is reported when opening fails too**, not only when the first query does.

**The README no longer describes an allowlist.** This server has none: it reads every conversation in the database. The earlier text described a different tool.

**A Claude Desktop extension**, attached to each release.

## 0.1.0

First release. TypeScript on Bun, 10 tools, 21 tests.

Written after reading all three existing iMessage MCP servers in full from
source. carries a file and line reference for every claim.

### The things that were wrong elsewhere

**Truncation.** Message bodies live in an `attributedBody` blob whose length
prefix is one byte for short strings and, after a `0x81` marker, two bytes
little-endian. Anthropic's plugin reads one byte after that marker, so every
message of 256 bytes or more is silently cut. A 618-byte message decodes as
106.

**Note-to-self.** Self-chat rows are written with `is_from_me = 1` and no
received copy. An inbound handler that skips all `is_from_me` rows drops every
message you send yourself, which is the flow that plugin's README tells you to
test with.

**The cursor.** A watermark taken from `MAX(ROWID)` at boot and held in memory
means every message that arrives while nothing is running is skipped, not
queued.

**Unverified sends.** A clean `osascript` exit means Messages accepted the
instruction, not that anything was delivered.

### What is here

Durable on-disk cursor, contact resolution across every AddressBook source,
search that decodes bodies rather than only reading the `text` column, sending
with delivery confirmation, voice-note transcription across four providers
(Groq by default, `local` to keep audio on the machine, OpenAI, ElevenLabs),
and speech through ElevenLabs.

### Known gaps

Voice-note transcription has been verified end to end against an Apple `.caf`
file through Groq, but not yet against a real inbound voice note arriving in
Messages.

Tapbacks, edits and threaded replies are not supported and cannot be without
Apple's private API.
