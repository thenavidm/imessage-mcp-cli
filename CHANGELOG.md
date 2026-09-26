# iMessage MCP Server & CLI changelog

| Component | Version | Last Updated |
|-----------|---------|--------------|
| imessage-mcp-cli | 0.2.0 | 2026-09-26 |

---

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
