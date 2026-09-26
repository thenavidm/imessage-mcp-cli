import { open, CHAT_DB } from "./db.js";
import { allContacts } from "./contacts.js";
import { haveTool, provider, transcriptionReady } from "./voice.js";
import { loadState, STATE_DIR } from "./state.js";

/** Check every part of the setup and say what is missing. Exit code 0 when the database reads. */
export async function runDoctor(): Promise<number> {
const tick = (b: boolean) => (b ? "ok  " : "MISS");

console.log(`imessage-mcp doctor\n`);

let dbOk = true;
try {
  const n = open().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM message").get()?.n ?? 0;
  console.log(`${tick(true)}  chat.db  ${CHAT_DB} (${n} messages)`);
} catch (err) {
  dbOk = false;
  console.log(`${tick(false)}  chat.db  ${err instanceof Error ? err.message.split("\n")[0] : err}`);
}

let contacts = 0;
try {
  contacts = allContacts().length;
} catch {
  // Contacts is optional; raw handles still work without it.
}
console.log(`${tick(contacts > 0)}  contacts  ${contacts} found`);

const state = loadState();
console.log(`${tick(true)}  cursor  ${state.cursor === 0 ? "not initialised" : state.cursor} in ${STATE_DIR}`);

console.log(`${tick(await haveTool("ffmpeg"))}  ffmpeg  converts Apple audio for any provider`);

try {
  const p = provider();
  const ready = await transcriptionReady(p);
  const need =
    p === "local" ? "needs whisper on PATH" : `needs ${p === "elevenlabs" ? "ELEVENLABS" : p.toUpperCase()}_API_KEY`;
  console.log(`${tick(ready)}  transcription  provider "${p}"${ready ? "" : `, ${need}`}`);
} catch (err) {
  console.log(`${tick(false)}  transcription  ${err instanceof Error ? err.message : err}`);
}

const speech = Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
console.log(`${tick(speech)}  speech  needs ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID, for speak only`);

if (!dbOk) {
  console.log(
    `\nFull Disk Access is the usual cause. System Settings, Privacy & Security,` +
      ` Full Disk Access. Add the app launching this, then restart it.`,
  );
}
  return dbOk ? 0 : 1;
}
