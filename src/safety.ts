import { appendFileSync } from "node:fs";

/**
 * The write guard. Sending reaches a real person from the user's own account
 * and cannot be unsent, so every send waits for `confirm: true`, and
 * `IMESSAGE_READ_ONLY=1` takes the sending tools away altogether. `inbox`
 * stays in read-only mode: the only thing it writes is its own place on disk.
 *
 * Read at call time, not import time, so a test or a long-lived process sees
 * the environment it has now.
 */
export const SENDING_TOOLS = new Set(["send_message", "send_file", "speak"]);

export function readOnly(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.IMESSAGE_READ_ONLY ?? "");
}

/**
 * One JSON line per attempted send, allowed or blocked, to the file
 * `IMESSAGE_AUDIT_LOG` names. The recipient and the size, never the words:
 * the log should not become a second copy of your messages.
 */
export function audit(tool: string, to: unknown, outcome: string, size?: number): void {
  const file = process.env.IMESSAGE_AUDIT_LOG;
  if (!file) return;
  const entry = { at: new Date().toISOString(), tool, to: typeof to === "string" ? to : null, ...(size === undefined ? {} : { chars: size }), outcome };
  try {
    appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    // A log that cannot be written must not stop the send it describes.
  }
}

/** The refusal an agent reads, naming exactly what would have gone out. */
export function needsConfirm(tool: string, about: string): string {
  return `${tool} can't be unsent, so it will not run without confirm: true. About to: ${about}. Call again with confirm: true only if the person asked for this exact message.`;
}
