import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { open, CHAT_DB } from "./db.js";
import { search, listConversations, attachmentsFor, render, type Rendered } from "./query.js";
import { findContacts, nameFor, allContacts } from "./contacts.js";
import { sendText, sendFile } from "./send.js";
import { transcribe, speak, haveTool, provider, transcriptionReady, PROVIDERS, type Provider } from "./voice.js";
import { loadState, saveState, advanceCursor, STATE_DIR } from "./state.js";
import { SENDING_TOOLS, readOnly, audit, needsConfirm } from "./safety.js";
import { SELECT_MESSAGE, type MessageRow } from "./db.js";

export const VERSION = "0.3.1";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

function line(m: Rendered): string {
  const when = m.at.replace("T", " ").slice(0, 16);
  const att = m.hasAttachments ? " [attachment]" : "";
  return `[${m.rowid}] ${when}  ${m.from} → ${m.chat}${att}\n    ${m.text || "(no text)"}`;
}

/**
 * What each tool does to the world, so an MCP app can show it before a call
 * and the CLI can mark it. Sending cannot be recalled, and `speak` sends when
 * it is given a recipient. `inbox` moves its own cursor on disk, which is a
 * write to this machine, not to anyone else.
 */
const ANNOTATIONS: Record<string, { readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint: boolean }> = {
  inbox: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  search_messages: { readOnlyHint: true, openWorldHint: false },
  list_conversations: { readOnlyHint: true, openWorldHint: false },
  get_conversation: { readOnlyHint: true, openWorldHint: false },
  resolve_contact: { readOnlyHint: true, openWorldHint: false },
  send_message: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  send_file: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  transcribe_voice_note: { readOnlyHint: true, openWorldHint: true },
  speak: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  server_status: { readOnlyHint: true, openWorldHint: false },
};

function annotate<T extends { name: string }>(tools: T[]): (T & { annotations?: object })[] {
  return tools.map((tool) => (ANNOTATIONS[tool.name] ? { ...tool, annotations: ANNOTATIONS[tool.name] } : tool));
}

/** The server, with every tool registered. The entry point connects a transport. */
export function buildServer(): Server {
const server = new Server(
  { name: "imessage-mcp", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: annotate([
    {
      name: "inbox",
      description:
        "Messages that have arrived since this tool last ran. The cursor is stored on disk, so anything received while nothing was running is still waiting here rather than lost. Call with peek=true to look without consuming.",
      inputSchema: {
        type: "object",
        properties: {
          peek: { type: "boolean", description: "Read without advancing the cursor." },
          limit: { type: "number", description: "Max messages to return (default 100)." },
          includeFromMe: {
            type: "boolean",
            description: "Include your own sends. Default true, which is what makes note-to-self work.",
          },
        },
      },
    },
    {
      name: "search_messages",
      description:
        "Search message history by text, sender, chat, or date range. Reads bodies from both the text column and the encoded attributedBody blob, so it finds messages that plain SQL cannot.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to look for, case-insensitive." },
          from: { type: "string", description: "Filter by sender handle, partial match." },
          chatId: { type: "string", description: "Restrict to one chat GUID." },
          since: { type: "string", description: "ISO date lower bound." },
          until: { type: "string", description: "ISO date upper bound." },
          limit: { type: "number", description: "Max results (default 50, max 500)." },
        },
      },
    },
    {
      name: "list_conversations",
      description: "List chats by most recent activity, with resolved contact names and participants.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", description: "Default 50." } },
      },
    },
    {
      name: "get_conversation",
      description: "Read one conversation in order, oldest first.",
      inputSchema: {
        type: "object",
        properties: {
          chatId: { type: "string", description: "Chat GUID from list_conversations." },
          limit: { type: "number", description: "Max messages (default 100)." },
        },
        required: ["chatId"],
      },
    },
    {
      name: "resolve_contact",
      description:
        "Look up a person in Contacts by name and return their sendable handles. Use before send_message when you know a name but not a number.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    {
      name: "send_message",
      description:
        "Send a message to a phone number, email, or chat GUID. Waits for Messages to confirm delivery and reports the failure if it did not go through.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Handle (+46...), email, or chat GUID." },
          text: { type: "string" },
          confirm: { type: "boolean", description: "Must be true. A sent message can't be unsent, so pass it only when the person asked for this exact message." },
        },
        required: ["to", "text"],
      },
    },
    {
      name: "send_file",
      description: "Send a file by absolute path. Images and audio render inline in Messages.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          path: { type: "string", description: "Absolute path." },
          confirm: { type: "boolean", description: "Must be true. A sent message can't be unsent, so pass it only when the person asked for this exact message." },
        },
        required: ["to", "path"],
      },
    },
    {
      name: "transcribe_voice_note",
      description:
        "Transcribe an audio attachment to text. Pass a message rowid to transcribe its attachments, or an absolute path. Uses the configured provider: groq by default, or local to keep the audio on this machine.",
      inputSchema: {
        type: "object",
        properties: {
          rowid: { type: "number", description: "Message rowid whose audio attachments to transcribe." },
          path: { type: "string", description: "Absolute path to an audio file." },
          provider: {
            type: "string",
            enum: PROVIDERS,
            description: "Override the configured provider for this one call. 'local' keeps the audio on this machine.",
          },
        },
      },
    },
    {
      name: "speak",
      description:
        "Turn text into speech with ElevenLabs and return the audio file path, optionally sending it. Note that Messages shows script-sent audio as an attachment, not as a native voice-note bubble.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          to: { type: "string", description: "Optional. If given, the audio is sent to this handle or chat." },
          voiceId: { type: "string", description: "Overrides ELEVENLABS_VOICE_ID." },
          confirm: { type: "boolean", description: "Must be true when `to` is given, because the audio is then sent and can't be unsent." },
        },
        required: ["text"],
      },
    },
    {
      name: "server_status",
      description: "Database reachability, cursor position, contact count, and which optional tools are installed.",
      inputSchema: { type: "object", properties: {} },
    },
  ]).filter((tool) => !(readOnly() && SENDING_TOOLS.has(tool.name))),
}));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const a = (req.params.arguments ?? {}) as Record<string, any>;
  const name = req.params.name;

  // The guard, before anything is sent. `speak` with no recipient only makes a file.
  const sends = SENDING_TOOLS.has(name) && (name !== "speak" || Boolean(a.to));
  if (SENDING_TOOLS.has(name) && readOnly()) {
    audit(name, a.to, "blocked: read-only");
    return { ...text(`IMESSAGE_READ_ONLY is on, so ${name} is unavailable. Nothing was sent.`), isError: true };
  }
  if (sends && a.confirm !== true) {
    audit(name, a.to, "blocked: no confirm", typeof a.text === "string" ? a.text.length : undefined);
    const known = nameFor(a.to);
    const who = known === a.to ? String(a.to) : `${known} (${a.to})`;
    const what =
      name === "send_message" ? `send "${String(a.text ?? "").slice(0, 120)}" to ${who}`
      : name === "send_file" ? `send the file ${a.path} to ${who}`
      : `speak "${String(a.text ?? "").slice(0, 120)}" and send the audio to ${who}`;
    return { ...text(needsConfirm(name, what)), isError: true };
  }

  try {
    switch (name) {
      case "inbox": {
        const state = loadState();
        const db = open();
        const limit = Math.min(Math.max(a.limit ?? 100, 1), 500);
        const includeFromMe = a.includeFromMe !== false;

        // A first run with no stored cursor would otherwise dump the entire
        // history, so it starts from the latest message instead.
        if (state.cursor === 0) {
          const max = db.query<{ max: number | null }, []>("SELECT MAX(ROWID) AS max FROM message").get();
          saveState({ cursor: max?.max ?? 0, updatedAt: new Date().toISOString() });
          return text("Inbox initialised at the current end of history. New messages from now on will appear here.");
        }

        const rows = db
          .query<MessageRow, [number]>(
            SELECT_MESSAGE +
              ` WHERE m.ROWID > ?${includeFromMe ? "" : " AND m.is_from_me = 0"} ORDER BY m.ROWID ASC LIMIT ${limit}`,
          )
          .all(state.cursor);

        if (rows.length === 0) return text(`Nothing new. Cursor at ${state.cursor}.`);

        const rendered = rows.map(render).filter(m => m.text || m.hasAttachments);
        if (!a.peek) advanceCursor(rows[rows.length - 1]!.rowid);

        return text(
          `${rendered.length} new message(s)${a.peek ? " (peek, cursor unchanged)" : ""}:\n\n` +
            rendered.map(line).join("\n\n"),
        );
      }

      case "search_messages": {
        const hits = search({
          query: a.query,
          from: a.from,
          chatId: a.chatId,
          since: a.since,
          until: a.until,
          limit: a.limit,
        });
        return hits.length === 0
          ? text("No matches.")
          : text(`${hits.length} match(es):\n\n` + hits.map(line).join("\n\n"));
      }

      case "list_conversations":
        return json(listConversations(a.limit ?? 50));

      case "get_conversation": {
        const hits = search({ chatId: a.chatId, limit: a.limit ?? 100 }).reverse();
        return hits.length === 0
          ? text("No messages in that chat, or unknown chat GUID.")
          : text(hits.map(line).join("\n\n"));
      }

      case "resolve_contact": {
        const found = findContacts(a.name);
        if (found.length === 0) return text(`No contact matching "${a.name}".`);
        if (found.length > 1) {
          return text(
            `${found.length} possible matches, pick one before sending:\n` +
              found.slice(0, 10).map(c => `  ${c.name}: ${c.handles.join(", ")}`).join("\n"),
          );
        }
        return json(found[0]);
      }

      case "send_message": {
        const r = await sendText(a.to, a.text);
        audit(name, a.to, r.ok ? "sent" : "failed", String(a.text ?? "").length);
        return text(r.ok ? `Sent to ${nameFor(a.to)} (${r.detail}).` : `Send failed: ${r.detail}`);
      }

      case "send_file": {
        const r = await sendFile(a.to, a.path);
        audit(name, a.to, r.ok ? "sent" : "failed");
        return text(r.ok ? `File sent to ${nameFor(a.to)} (${r.detail}).` : `Send failed: ${r.detail}`);
      }

      case "transcribe_voice_note": {
        let paths: string[] = [];
        if (a.path) paths = [a.path];
        else if (a.rowid) {
          paths = attachmentsFor(a.rowid)
            .filter(x => (x.mime ?? "").startsWith("audio") || /\.(caf|amr|m4a|mp3|wav|aac)$/i.test(x.path))
            .map(x => x.path);
        }
        if (paths.length === 0) return text("No audio found for that message. Pass an explicit path if needed.");

        const out: string[] = [];
        const via = (a.provider as Provider | undefined) ?? provider();
        for (const p of paths) out.push(`${p} (via ${via}):\n${await transcribe(p, via)}`);
        return text(out.join("\n\n"));
      }

      case "speak": {
        const file = await speak(a.text, { voiceId: a.voiceId });
        if (!a.to) return text(`Audio written to ${file}`);
        const r = await sendFile(a.to, file);
        audit(name, a.to, r.ok ? "sent" : "failed", String(a.text ?? "").length);
        return text(r.ok ? `Voice message sent to ${nameFor(a.to)} (${r.detail}). File: ${file}` : `Send failed: ${r.detail}`);
      }

      case "server_status": {
        const db = open();
        const total = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM message").get()?.n ?? 0;
        const state = loadState();
        return json({
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
        });
      }

      default:
        return { ...text(`Unknown tool: ${req.params.name}`), isError: true };
    }
  } catch (err) {
    return { ...text(err instanceof Error ? err.message : String(err)), isError: true };
  }
});

return server;
}
