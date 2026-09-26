import { readFile, writeFile } from "node:fs/promises";
import { run as spawnCapture } from "./proc.js";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";

/**
 * Voice in and voice out.
 *
 * Transcription has four providers. Three of them are the same Whisper model
 * in different places; the only real difference is whose computer runs it and
 * whether the audio leaves this machine.
 */
export type Provider = "groq" | "local" | "openai" | "elevenlabs";

export const PROVIDERS: Provider[] = ["groq", "local", "openai", "elevenlabs"];

export function provider(): Provider {
  const raw = (process.env.IMESSAGE_TRANSCRIBE ?? "groq").toLowerCase();
  if ((PROVIDERS as string[]).includes(raw)) return raw as Provider;
  throw new Error(`unknown transcription provider "${raw}". One of: ${PROVIDERS.join(", ")}`);
}

const WHISPER_MODEL = process.env.IMESSAGE_WHISPER_MODEL ?? "base";
const GROQ_MODEL = process.env.GROQ_WHISPER_MODEL ?? "whisper-large-v3-turbo";

async function run(cmd: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const { code, stdout, stderr } = await spawnCapture(cmd);
  return { ok: code === 0, out: stdout, err: stderr };
}

export async function haveTool(bin: string): Promise<boolean> {
  return (await run(["which", bin])).ok;
}

/**
 * Apple writes voice notes as .caf, and older ones as .amr. No hosted
 * transcription API accepts either, and whisper does not read them directly,
 * so everything is normalized to 16 kHz mono wav first.
 */
async function toWav(path: string): Promise<string> {
  if (!existsSync(path)) throw new Error(`no such file: ${path}`);
  if (!(await haveTool("ffmpeg"))) throw new Error("ffmpeg not found. brew install ffmpeg");

  const wav = join(tmpdir(), `imessage-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  const conv = await run(["ffmpeg", "-nostdin", "-y", "-i", path, "-ar", "16000", "-ac", "1", wav]);
  if (!conv.ok) throw new Error(`ffmpeg failed: ${conv.err.trim().split("\n").slice(-3).join(" ")}`);
  return wav;
}

function requireKey(name: string, p: Provider): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set, which the "${p}" transcription provider needs`);
  return v;
}

/** Groq and OpenAI share the same multipart transcription contract. */
async function transcribeOpenAiCompatible(
  wav: string,
  url: string,
  key: string,
  model: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([await readFile(wav)]), basename(wav));
  form.append("model", model);
  form.append("response_format", "text");

  const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.text()).trim();
}

async function transcribeElevenLabs(wav: string, key: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([await readFile(wav)]), basename(wav));
  form.append("model_id", process.env.ELEVENLABS_STT_MODEL ?? "scribe_v1");

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { text?: string };
  return (body.text ?? "").trim();
}

async function transcribeLocal(wav: string): Promise<string> {
  if (!(await haveTool("whisper"))) throw new Error("whisper not found. pip install -U openai-whisper");

  const outDir = join(tmpdir(), `imessage-mcp-out-${Date.now()}`);
  const tr = await run([
    "whisper", wav,
    "--model", WHISPER_MODEL,
    "--output_format", "txt",
    "--output_dir", outDir,
    "--fp16", "False",
  ]);
  if (!tr.ok) throw new Error(`whisper failed: ${tr.err.trim().split("\n").slice(-3).join(" ")}`);

  const txt = join(outDir, basename(wav).replace(/\.wav$/, ".txt"));
  try {
    return (await readFile(txt, "utf8")).trim();
  } catch {
    return tr.out.trim(); // Older builds print to stdout instead of writing a file.
  }
}

export async function transcribe(path: string, override?: Provider): Promise<string> {
  const p = override ?? provider();
  const wav = await toWav(path);

  switch (p) {
    case "local":
      return transcribeLocal(wav);
    case "groq":
      return transcribeOpenAiCompatible(
        wav,
        "https://api.groq.com/openai/v1/audio/transcriptions",
        requireKey("GROQ_API_KEY", p),
        GROQ_MODEL,
      );
    case "openai":
      return transcribeOpenAiCompatible(
        wav,
        "https://api.openai.com/v1/audio/transcriptions",
        requireKey("OPENAI_API_KEY", p),
        process.env.OPENAI_WHISPER_MODEL ?? "whisper-1",
      );
    case "elevenlabs":
      return transcribeElevenLabs(wav, requireKey("ELEVENLABS_API_KEY", p));
  }
}

/** Whether the configured provider is ready, for doctor and server_status. */
export async function transcriptionReady(p: Provider = provider()): Promise<boolean> {
  if (p === "local") return haveTool("whisper");
  if (p === "groq") return Boolean(process.env.GROQ_API_KEY);
  if (p === "openai") return Boolean(process.env.OPENAI_API_KEY);
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

export type SpeakOptions = { voiceId?: string; modelId?: string };

/**
 * Synthesize speech and return the path to an m4a file.
 *
 * Apple marks true voice notes with an internal `is_audio_message` flag that
 * AppleScript cannot set, so audio sent from a script arrives as a playable
 * attachment rather than the waveform bubble.
 */
export async function speak(text: string, opts: SpeakOptions = {}): Promise<string> {
  const key = requireKey("ELEVENLABS_API_KEY", "elevenlabs");
  const voice = opts.voiceId ?? process.env.ELEVENLABS_VOICE_ID;
  if (!voice) throw new Error("no voice id: pass voiceId or set ELEVENLABS_VOICE_ID");

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: opts.modelId ?? process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2",
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mp3 = join(tmpdir(), `imessage-mcp-tts-${stamp}.mp3`);
  await writeFile(mp3, Buffer.from(await res.arrayBuffer()));

  if (!(await haveTool("ffmpeg"))) return mp3;
  const m4a = join(tmpdir(), `imessage-mcp-tts-${stamp}.m4a`);
  const conv = await run(["ffmpeg", "-nostdin", "-y", "-i", mp3, "-c:a", "aac", "-b:a", "96k", m4a]);
  return conv.ok ? m4a : mp3;
}
