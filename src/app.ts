/**
 * The iMessage app: everything Slipway needs to ship the MCP server and the CLI.
 *
 * Mac only. It reads Messages' own database, so the app that launches it needs
 * Full Disk Access, and it sends through Messages with AppleScript, so the first
 * send asks for Automation permission. This file only describes; `index.ts` runs.
 */

import { slipway, type DoctorCheck } from "@thenavidm/slipway";
import { allContacts } from "./contacts.js";
import { CHAT_DB, open } from "./db.js";
import { STATE_DIR, loadState } from "./state.js";
import { TOOLS } from "./tools.js";
import { VERSION } from "./version.js";
import { haveTool, provider, transcriptionReady } from "./voice.js";

const message = (error: unknown): string => (error instanceof Error ? error.message.split("\n")[0]! : String(error));

/** 0.3's doctor: the database must read; contacts, ffmpeg, transcription and speech are optional. */
async function doctor(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  try {
    const n = open().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM message").get()?.n ?? 0;
    checks.push({ name: "chat.db", ok: true, detail: `${CHAT_DB} (${n} messages)` });
  } catch (error) {
    checks.push({
      name: "chat.db",
      ok: false,
      detail: message(error),
      fix: "Full Disk Access is the usual cause: System Settings, Privacy & Security, Full Disk Access. Add the app launching this, then restart it.",
    });
  }
  let contacts = 0;
  try {
    contacts = allContacts().length;
  } catch {
    // Contacts is optional; raw handles still work without it.
  }
  checks.push(contacts > 0 ? { name: "Contacts", ok: true, detail: `${contacts} found` } : { name: "Contacts", ok: true, warn: true, detail: "none found, so handles show as numbers and emails" });
  const state = loadState();
  checks.push({ name: "Cursor", ok: true, detail: `${state.cursor === 0 ? "not initialized" : state.cursor} in ${STATE_DIR}` });
  const ffmpeg = await haveTool("ffmpeg");
  checks.push(ffmpeg ? { name: "ffmpeg", ok: true, detail: "converts Apple audio for any provider" } : { name: "ffmpeg", ok: true, warn: true, detail: "not found, which transcription needs", fix: "brew install ffmpeg" });
  try {
    const p = provider();
    const ready = await transcriptionReady(p);
    const need = p === "local" ? "needs whisper on PATH" : `needs ${p === "elevenlabs" ? "ELEVENLABS" : p.toUpperCase()}_API_KEY`;
    checks.push(ready ? { name: "Transcription", ok: true, detail: `provider "${p}"` } : { name: "Transcription", ok: true, warn: true, detail: `provider "${p}" ${need}` });
  } catch (error) {
    checks.push({ name: "Transcription", ok: true, warn: true, detail: message(error) });
  }
  const speech = Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
  checks.push(speech ? { name: "Speech", ok: true, detail: "ElevenLabs is set up for speak" } : { name: "Speech", ok: true, warn: true, detail: "speak needs ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID" });
  return checks;
}

/**
 * 0.3's CLI spelled every flag in kebab case, `--chat-id`, where Slipway keeps
 * an input's own name, `--chatId`; the old spelling still answers.
 */
function kebabAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const tool of TOOLS) {
    for (const key of Object.keys((tool.jsonSchema.properties as Record<string, unknown> | undefined) ?? {})) {
      const kebab = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
      if (kebab !== key) aliases[kebab] = key;
    }
  }
  return aliases;
}

export function createApp() {
  return slipway<Record<string, never>>({
    name: "imessage",
    title: "iMessage",
    version: VERSION,
    package: "@thenavidm/imessage-mcp-cli",
    envPrefix: "IMESSAGE",
    description: "Read, search and send iMessages on this Mac, with contacts, voice note transcription and speech.",
    context: () => ({}),
    // Nothing to sign in to: doctor says whether this Mac lets it read Messages.
    configured: () => true,
    secrets: () => [process.env.GROQ_API_KEY, process.env.OPENAI_API_KEY, process.env.ELEVENLABS_API_KEY],
    tools: TOOLS,
    flagAliases: kebabAliases(),
    doctor,
    login:
      "There is no sign-in: the server reads Messages' own database on this Mac. Give the app that launches it Full Disk Access (System Settings, Privacy & Security, Full Disk Access), then run imessage-cli doctor. Sending asks Messages through AppleScript, so the first send also asks for Automation permission.",
    settings: [
      { env: "IMESSAGE_DB", description: "Another chat.db, for testing; ~/Library/Messages/chat.db when unset.", tuning: true },
      { env: "IMESSAGE_STATE_DIR", description: "Where inbox keeps its cursor; ~/.imessage-mcp when unset.", tuning: true },
      { env: "IMESSAGE_TRANSCRIBE", description: "Voice note transcription: groq (default), local, openai or elevenlabs." },
      { env: "GROQ_API_KEY", description: "For transcription with Groq, the default.", secret: true },
      { env: "OPENAI_API_KEY", description: "For transcription with OpenAI.", secret: true },
      { env: "ELEVENLABS_API_KEY", description: "For transcription with ElevenLabs, and for speak.", secret: true },
      { env: "ELEVENLABS_VOICE_ID", description: "The voice speak uses." },
      { env: "IMESSAGE_WHISPER_MODEL", description: "The local Whisper model; base when unset.", tuning: true },
      { env: "GROQ_WHISPER_MODEL", description: "Groq's model; whisper-large-v3-turbo when unset.", tuning: true },
      { env: "OPENAI_WHISPER_MODEL", description: "OpenAI's model; whisper-1 when unset.", tuning: true },
      { env: "ELEVENLABS_MODEL_ID", description: "The speech model; eleven_multilingual_v2 when unset.", tuning: true },
      { env: "ELEVENLABS_STT_MODEL", description: "ElevenLabs' transcription model; scribe_v1 when unset.", tuning: true },
    ],
    links: { repository: "https://github.com/thenavidm/imessage-mcp-cli" },
    // 0.3 said where it reads from when it started; a nudge on stderr, never a block.
    onServe: (_ctx, log) => log.info(`imessage ${VERSION} ready (db: ${CHAT_DB})`),
  });
}

export const app = createApp();
