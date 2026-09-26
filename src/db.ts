import { Database } from "./sqlite.js";
import { homedir } from "node:os";
import { join } from "node:path";

export const CHAT_DB = process.env.IMESSAGE_DB ?? join(homedir(), "Library/Messages/chat.db");

/** Apple stores dates as nanoseconds since 2001-01-01. */
const APPLE_EPOCH_MS = 978307200000;
export const appleToDate = (ns: number): Date => new Date(ns / 1e6 + APPLE_EPOCH_MS);
export const dateToApple = (d: Date): number => (d.getTime() - APPLE_EPOCH_MS) * 1e6;

let db: Database | null = null;

export function open(): Database {
  if (db) return db;
  // Fail loudly and early if Full Disk Access is missing, rather than on the
  // first real query where the error reads like a corrupt database. Opening
  // can fail the same way, so it sits inside the same check.
  try {
    db = new Database(CHAT_DB, { readonly: true });
    db.query("SELECT ROWID FROM message LIMIT 1").get();
  } catch (err) {
    db = null;
    throw new Error(
      `cannot read ${CHAT_DB}: ${err instanceof Error ? err.message : err}\n` +
        `Grant Full Disk Access to the app launching this server, then restart it.`,
    );
  }
  return db;
}

/**
 * Modern macOS stores message bodies in `attributedBody` (a NeXT `streamtyped`
 * archive) and leaves `text` NULL. The payload is an NSString whose UTF-8 bytes
 * follow a length prefix.
 *
 * Length encoding, verified against real rows rather than assumed:
 *   byte < 0x81          the byte is the length
 *   byte = 0x81          next 2 bytes, little-endian
 *   byte = 0x82          next 4 bytes, little-endian
 *
 * Reading only one byte after 0x81 truncates every message of 256 bytes or
 * more, which is a live bug in more than one published implementation.
 */
export function decodeAttributedBody(blob: Uint8Array | null): string | null {
  if (!blob) return null;
  const buf = Buffer.from(blob);

  let i = buf.indexOf("NSString");
  if (i < 0) return null;
  i += "NSString".length;

  // Class metadata runs until 0x2B, which marks the inline string payload.
  while (i < buf.length && buf[i] !== 0x2b) i++;
  if (i >= buf.length) return null;
  i++;

  if (i >= buf.length) return null;
  let len: number;
  const marker = buf[i++]!;
  if (marker === 0x81) {
    if (i + 2 > buf.length) return null;
    len = buf.readUInt16LE(i);
    i += 2;
  } else if (marker === 0x82) {
    if (i + 4 > buf.length) return null;
    len = buf.readUInt32LE(i);
    i += 4;
  } else {
    len = marker;
  }

  if (len < 0 || i + len > buf.length) return null;
  return buf.toString("utf8", i, i + len);
}

export type MessageRow = {
  rowid: number;
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
  date: number;
  is_from_me: number;
  cache_has_attachments: number;
  service: string | null;
  handle: string | null;
  chat_guid: string | null;
  chat_identifier: string | null;
  chat_style: number | null;
  display_name: string | null;
};

/** The body of a message, whichever column it happens to live in. */
export function bodyOf(r: MessageRow): string {
  return (r.text ?? decodeAttributedBody(r.attributedBody) ?? "").trim();
}

export const SELECT_MESSAGE = `
  SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.date,
         m.is_from_me, m.cache_has_attachments, m.service,
         h.id AS handle,
         c.guid AS chat_guid, c.chat_identifier, c.style AS chat_style, c.display_name
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  LEFT JOIN handle h ON h.ROWID = m.handle_id
`;
