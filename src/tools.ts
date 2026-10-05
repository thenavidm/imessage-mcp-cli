/**
 * What the server can do, one definition per tool. Slipway builds the MCP
 * server and the CLI from these, and runs the send guard from each tool's risk:
 * a send reaches a real person from the user's own account and cannot be
 * unsent, so it waits for confirmation, and IMESSAGE_READ_ONLY=1 hides it.
 */

import { ApiError, AuthError, NotConfiguredError, NotFoundError, SlipwayError, defineTool, z, type Risk, type Tool } from "@thenavidm/slipway";
import { CHAT_DB, SELECT_MESSAGE, open, type MessageRow } from "./db.js";
import { allContacts, findContacts, nameFor } from "./contacts.js";
import { attachmentsFor, listConversations, render, search, type Rendered } from "./query.js";
import { sendFile, sendText } from "./send.js";
import { loadState, saveState, advanceCursor, STATE_DIR } from "./state.js";
import { PROVIDERS, haveTool, provider, speak, transcribe, transcriptionReady, type Provider } from "./voice.js";
import { VERSION } from "./version.js";

function line(m: Rendered): string {
  const when = m.at.replace("T", " ").slice(0, 16);
  const att = m.hasAttachments ? " [attachment]" : "";
  return `[${m.rowid}] ${when}  ${m.from} → ${m.chat}${att}\n    ${m.text || "(no text)"}`;
}

/** The recipient as a person reads it: their name and the handle, or the handle alone. */
function who(to: string): string {
  const known = nameFor(to);
  return known === to ? to : `${known} (${to})`;
}

/**
 * A failure as the Slipway error that carries its exit code, as 0.3 gave them:
 * macOS refusing access to the database is 4; a provider's key or a tool that
 * is not set up is 10; a file that is not there is 3; Messages or a provider
 * answering with an error is 5.
 */
export function toSlipway(error: unknown): unknown {
  if (error instanceof SlipwayError || !(error instanceof Error)) return error;
  const m = error.message;
  if (/^cannot read .*\nGrant Full Disk Access/.test(m)) return new AuthError(m.replace(/\n/g, " "));
  if (/is not set, which the|not found\. (brew|pip)|^no voice id|^unknown transcription provider/.test(m)) return new NotConfiguredError(m);
  if (/^no such file: /.test(m)) return new NotFoundError(m);
  if (/^\S+ \d{3}: |^ElevenLabs \d{3}: |^(ffmpeg|whisper) failed: |^Send failed: /.test(m)) return new ApiError(m);
  return error;
}

/** Each tool's handler, with its failures given exit codes. */
function guarded<A>(handler: (args: A) => Promise<unknown> | unknown): (args: A) => Promise<unknown> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      throw toSlipway(error);
    }
  };
}

/** Words for every confirmed call, as 0.3 said them. */
const UNSENT = "can't be unsent";

/** What a person approving a send reads: the words themselves, cut at 1,000 characters. Never logged. */
const words = (text: string): string => `"${text.length > 1000 ? `${text.slice(0, 1000)}…` : text}"`;

export const TOOLS: Tool<Record<string, never>>[] = [
  defineTool({
    name: "inbox",
    title: "Inbox",
    description:
      "Messages that have arrived since this tool last ran. The cursor is stored on disk, so anything received while nothing was running is still waiting here rather than lost. Call with peek=true to look without consuming.",
    input: z.object({
      peek: z.boolean().optional().describe("Read without advancing the cursor."),
      limit: z.number().optional().describe("Max messages to return (default 100)."),
      includeFromMe: z.boolean().optional().describe("Include your own sends. Default true, which is what makes note-to-self work."),
    }),
    // It moves only its own cursor on this machine, so it stays under IMESSAGE_READ_ONLY, as in 0.3.
    risk: "read",
    idempotent: false,
    openWorld: false,
    handler: guarded(({ peek, limit, includeFromMe }) => {
      const state = loadState();
      const db = open();
      const max = Math.min(Math.max(limit ?? 100, 1), 500);
      // A first run with no stored cursor would otherwise dump the entire
      // history, so it starts from the latest message instead.
      if (state.cursor === 0) {
        const latest = db.query<{ max: number | null }, []>("SELECT MAX(ROWID) AS max FROM message").get();
        saveState({ cursor: latest?.max ?? 0, updatedAt: new Date().toISOString() });
        return "Inbox initialized at the current end of history. New messages from now on will appear here.";
      }
      const rows = db
        .query<MessageRow, [number]>(SELECT_MESSAGE + ` WHERE m.ROWID > ?${includeFromMe !== false ? "" : " AND m.is_from_me = 0"} ORDER BY m.ROWID ASC LIMIT ${max}`)
        .all(state.cursor);
      if (rows.length === 0) return `Nothing new. Cursor at ${state.cursor}.`;
      const rendered = rows.map(render).filter((m) => m.text || m.hasAttachments);
      if (!peek) advanceCursor(rows[rows.length - 1]!.rowid);
      return `${rendered.length} new message(s)${peek ? " (peek, cursor unchanged)" : ""}:\n\n` + rendered.map(line).join("\n\n");
    }),
  }),
  defineTool({
    name: "search_messages",
    title: "Search messages",
    description:
      "Search message history by text, sender, chat, or date range. Reads bodies from both the text column and the encoded attributedBody blob, so it finds messages that plain SQL cannot.",
    input: z.object({
      query: z.string().optional().describe("Substring to look for, case-insensitive."),
      from: z.string().optional().describe("Filter by sender handle, partial match."),
      chatId: z.string().optional().describe("Restrict to one chat GUID."),
      since: z.string().optional().describe("ISO date lower bound."),
      until: z.string().optional().describe("ISO date upper bound."),
      limit: z.number().optional().describe("Max results (default 50, max 500)."),
    }),
    risk: "read",
    openWorld: false,
    handler: guarded((args) => {
      const hits = search(args);
      return hits.length === 0 ? "No matches." : `${hits.length} match(es):\n\n` + hits.map(line).join("\n\n");
    }),
  }),
  defineTool({
    name: "list_conversations",
    title: "List conversations",
    description: "List chats by most recent activity, with resolved contact names and participants.",
    input: z.object({ limit: z.number().optional().describe("Default 50.") }),
    risk: "read",
    openWorld: false,
    handler: guarded(({ limit }) => listConversations(limit ?? 50)),
  }),
  defineTool({
    name: "get_conversation",
    title: "Get conversation",
    description: "Read one conversation in order, oldest first.",
    input: z.object({
      chatId: z.string().describe("Chat GUID from list_conversations."),
      limit: z.number().optional().describe("Max messages (default 100)."),
    }),
    risk: "read",
    openWorld: false,
    handler: guarded(({ chatId, limit }) => {
      const hits = search({ chatId, limit: limit ?? 100 }).reverse();
      return hits.length === 0 ? "No messages in that chat, or unknown chat GUID." : hits.map(line).join("\n\n");
    }),
  }),
  defineTool({
    name: "resolve_contact",
    title: "Resolve contact",
    description: "Look up a person in Contacts by name and return their sendable handles. Use before send_message when you know a name but not a number.",
    input: z.object({ name: z.string() }),
    risk: "read",
    openWorld: false,
    handler: guarded(({ name }) => {
      const found = findContacts(name);
      if (found.length === 0) return `No contact matching "${name}".`;
      if (found.length > 1) {
        return `${found.length} possible matches, pick one before sending:\n` + found.slice(0, 10).map((c) => `  ${c.name}: ${c.handles.join(", ")}`).join("\n");
      }
      return found[0];
    }),
  }),
  defineTool({
    name: "send_message",
    title: "Send message",
    description: "Send a message to a phone number, email, or chat GUID. Waits for Messages to confirm delivery and reports the failure if it did not go through.",
    input: z.object({
      to: z.string().describe("Handle (+46...), email, or chat GUID."),
      text: z.string(),
    }),
    risk: "destructive",
    consequence: UNSENT,
    // The recipient and the size, never the words: the audit log should not become a second copy of your messages.
    summary: ({ to, text }) => `send a ${text.length}-character message to ${who(to)}`,
    detail: ({ text }) => words(text),
    handler: guarded(async ({ to, text }) => {
      const r = await sendText(to, text);
      if (!r.ok) throw new Error(`Send failed: ${r.detail}`);
      return `Sent to ${nameFor(to)} (${r.detail}).`;
    }),
  }),
  defineTool({
    name: "send_file",
    title: "Send file",
    description: "Send a file by absolute path. Images and audio render inline in Messages.",
    input: z.object({
      to: z.string(),
      path: z.string().describe("Absolute path."),
    }),
    risk: "destructive",
    consequence: UNSENT,
    summary: ({ to }) => `send a file to ${who(to)}`,
    detail: ({ path }) => path,
    handler: guarded(async ({ to, path }) => {
      const r = await sendFile(to, path);
      if (!r.ok) throw new Error(`Send failed: ${r.detail}`);
      return `File sent to ${nameFor(to)} (${r.detail}).`;
    }),
  }),
  defineTool({
    name: "transcribe_voice_note",
    title: "Transcribe voice note",
    description:
      "Transcribe an audio attachment to text. Pass a message rowid to transcribe its attachments, or an absolute path. Uses the configured provider: groq by default, or local to keep the audio on this machine.",
    input: z.object({
      rowid: z.number().optional().describe("Message rowid whose audio attachments to transcribe."),
      path: z.string().optional().describe("Absolute path to an audio file."),
      provider: z.enum(PROVIDERS as [Provider, ...Provider[]]).optional().describe("Override the configured provider for this one call. 'local' keeps the audio on this machine."),
    }),
    risk: "read",
    handler: guarded(async ({ rowid, path, provider: chosen }) => {
      let paths: string[] = [];
      if (path) paths = [path];
      else if (rowid) {
        paths = attachmentsFor(rowid)
          .filter((x) => (x.mime ?? "").startsWith("audio") || /\.(caf|amr|m4a|mp3|wav|aac)$/i.test(x.path))
          .map((x) => x.path);
      }
      if (paths.length === 0) return "No audio found for that message. Pass an explicit path if needed.";
      const via = chosen ?? provider();
      const out: string[] = [];
      for (const p of paths) out.push(`${p} (via ${via}):\n${await transcribe(p, via)}`);
      return out.join("\n\n");
    }),
  }),
  defineTool({
    name: "speak",
    title: "Speak",
    description:
      "Turn text into speech with ElevenLabs and return the audio file path, optionally sending it. Note that Messages shows script-sent audio as an attachment, not as a native voice-note bubble.",
    input: z.object({
      text: z.string(),
      to: z.string().optional().describe("Optional. If given, the audio is sent to this handle or chat."),
      voiceId: z.string().optional().describe("Overrides ELEVENLABS_VOICE_ID."),
    }),
    // Without a recipient it only writes an audio file; with one it sends.
    risk: "destructive",
    riskFor: ({ to }) => (to ? "destructive" : "write") as Risk,
    consequence: UNSENT,
    summary: ({ text, to }) => (to ? `speak ${text.length} characters and send the audio to ${who(to)}` : `speak ${text.length} characters to a file`),
    detail: ({ text }) => words(text),
    handler: guarded(async ({ text, to, voiceId }) => {
      const file = await speak(text, { voiceId });
      if (!to) return `Audio written to ${file}`;
      const r = await sendFile(to, file);
      if (!r.ok) throw new Error(`Send failed: ${r.detail}`);
      return `Voice message sent to ${nameFor(to)} (${r.detail}). File: ${file}`;
    }),
  }),
  defineTool({
    name: "server_status",
    title: "Server status",
    description: "Database reachability, cursor position, contact count, and which optional tools are installed.",
    risk: "read",
    openWorld: false,
    handler: guarded(async () => {
      const total = open().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM message").get()?.n ?? 0;
      const state = loadState();
      return {
        version: VERSION,
        database: CHAT_DB,
        messages: total,
        contacts: allContacts().length,
        cursor: state.cursor,
        cursorUpdatedAt: state.updatedAt,
        stateDir: STATE_DIR,
        ffmpeg: await haveTool("ffmpeg"),
        transcription: { provider: provider(), ready: await transcriptionReady() },
        speech: Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID),
      };
    }),
  }),
] as Tool<Record<string, never>>[];
