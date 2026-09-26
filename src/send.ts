import { run, sleep } from "./proc.js";
import { open, appleToDate } from "./db.js";

export type SendResult = {
  ok: boolean;
  detail: string;
  rowid?: number;
  service?: string | null;
};

/**
 * Text and identifiers are passed through argv rather than interpolated into
 * the script, so quotes, newlines and backslashes in a message cannot alter
 * the AppleScript being run.
 */
const BUDDY_SCRIPT = `on run argv
  set h to item 1 of argv
  set msg to item 2 of argv
  tell application "Messages"
    try
      set svc to 1st service whose service type = iMessage
      send msg to buddy h of svc
    on error
      send msg to buddy h of (1st service whose service type = SMS)
    end try
  end tell
end run`;

const CHAT_SCRIPT = `on run argv
  set cid to item 1 of argv
  set msg to item 2 of argv
  tell application "Messages" to send msg to chat id cid
end run`;

const FILE_SCRIPT = `on run argv
  set target to item 1 of argv
  set p to item 2 of argv
  set f to POSIX file p
  tell application "Messages"
    try
      send f to chat id target
    on error
      set svc to 1st service whose service type = iMessage
      send f to buddy target of svc
    end try
  end tell
end run`;

async function osascript(script: string, args: string[]): Promise<string | null> {
  const { code, stderr } = await run(["osascript", "-e", script, "--", ...args]);
  return code === 0 ? null : stderr.trim() || `osascript exited ${code}`;
}

/**
 * Confirm the message actually left, rather than trusting that AppleScript
 * returned cleanly. Messages writes the row first and resolves `is_sent` and
 * `error` a moment later, so this watches the row briefly.
 */
async function confirm(sentAfter: number, timeoutMs = 6000): Promise<SendResult> {
  const db = open();
  const q = db.query<
    { rowid: number; is_sent: number; error: number; service: string | null; date: number },
    [number]
  >(
    `SELECT ROWID AS rowid, is_sent, error, service, date FROM message
      WHERE is_from_me = 1 AND ROWID > ? ORDER BY ROWID DESC LIMIT 1`,
  );

  const deadline = Date.now() + timeoutMs;
  let last: { rowid: number; is_sent: number; error: number; service: string | null } | null = null;

  while (Date.now() < deadline) {
    const row = q.get(sentAfter);
    if (row) {
      last = row;
      if (row.error && row.error !== 0) {
        return { ok: false, detail: `Messages reported error code ${row.error}`, rowid: row.rowid, service: row.service };
      }
      if (row.is_sent === 1) {
        return {
          ok: true,
          detail: `sent at ${appleToDate(row.date).toLocaleTimeString()}`,
          rowid: row.rowid,
          service: row.service,
        };
      }
    }
    await sleep(250);
  }

  return last
    ? { ok: true, detail: "queued by Messages, delivery not yet confirmed", rowid: last.rowid, service: last.service }
    : { ok: false, detail: "no outgoing row appeared; Messages may not be signed in" };
}

function maxRowid(): number {
  const row = open().query<{ max: number | null }, []>("SELECT MAX(ROWID) AS max FROM message").get();
  return row?.max ?? 0;
}

/** Send text to a handle (phone/email) or an existing chat GUID. */
export async function sendText(target: string, text: string): Promise<SendResult> {
  const before = maxRowid();
  const isChatGuid = target.includes(";");
  const err = await osascript(isChatGuid ? CHAT_SCRIPT : BUDDY_SCRIPT, [target, text]);
  if (err) return { ok: false, detail: err };
  return confirm(before);
}

/** Send a file. Images and audio render inline in Messages; other types attach. */
export async function sendFile(target: string, path: string): Promise<SendResult> {
  const before = maxRowid();
  const err = await osascript(FILE_SCRIPT, [target, path]);
  if (err) return { ok: false, detail: err };
  return confirm(before);
}
