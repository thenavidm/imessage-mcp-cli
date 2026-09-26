import { open, SELECT_MESSAGE, bodyOf, appleToDate, dateToApple, type MessageRow } from "./db.js";
import { nameFor } from "./contacts.js";

export type Rendered = {
  rowid: number;
  at: string;
  from: string;
  fromMe: boolean;
  service: string | null;
  chat: string;
  chatId: string | null;
  text: string;
  hasAttachments: boolean;
};

export function render(r: MessageRow): Rendered {
  return {
    rowid: r.rowid,
    at: appleToDate(r.date).toISOString(),
    from: r.is_from_me ? "me" : nameFor(r.handle),
    fromMe: r.is_from_me === 1,
    service: r.service,
    chat: chatLabel(r),
    chatId: r.chat_guid,
    text: bodyOf(r),
    hasAttachments: r.cache_has_attachments === 1,
  };
}

/** Group chats prefer their display name; DMs prefer the contact's name. */
function chatLabel(r: MessageRow): string {
  if (r.chat_style === 43) return r.display_name?.trim() || "group";
  return nameFor(r.chat_identifier ?? r.handle);
}

export type SearchArgs = {
  query?: string;
  from?: string;
  chatId?: string;
  since?: string;
  until?: string;
  limit?: number;
  includeFromMe?: boolean;
};

/**
 * Bodies live in `text` on older rows and in `attributedBody` on newer ones,
 * and the latter is a binary blob SQL cannot search. Text filtering therefore
 * happens after decode, and the SQL layer narrows by everything else first so
 * the decoded set stays small.
 */
export function search(a: SearchArgs): Rendered[] {
  const db = open();
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (a.chatId) {
    where.push("c.guid = ?");
    params.push(a.chatId);
  }
  if (a.from) {
    where.push("LOWER(h.id) LIKE ?");
    params.push(`%${a.from.toLowerCase()}%`);
  }
  if (a.since) {
    where.push("m.date >= ?");
    params.push(dateToApple(new Date(a.since)));
  }
  if (a.until) {
    where.push("m.date <= ?");
    params.push(dateToApple(new Date(a.until)));
  }
  if (a.includeFromMe === false) where.push("m.is_from_me = 0");

  const limit = Math.min(Math.max(a.limit ?? 50, 1), 500);
  // Over-fetch, because the text filter is applied after decoding.
  const scan = a.query ? Math.min(limit * 40, 8000) : limit;

  const sql =
    SELECT_MESSAGE +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY m.ROWID DESC LIMIT ${scan}`;

  const rows = db.query<MessageRow, any>(sql).all(...params);
  const needle = a.query?.toLowerCase();

  const out: Rendered[] = [];
  for (const r of rows) {
    const rendered = render(r);
    if (needle && !rendered.text.toLowerCase().includes(needle)) continue;
    out.push(rendered);
    if (out.length >= limit) break;
  }
  return out;
}

export type Conversation = {
  chatId: string;
  name: string;
  kind: "dm" | "group";
  service: string | null;
  participants: string[];
  lastAt: string | null;
  messages: number;
};

export function listConversations(limit = 50): Conversation[] {
  const db = open();
  const rows = db
    .query<
      {
        guid: string;
        chat_identifier: string | null;
        display_name: string | null;
        style: number | null;
        service_name: string | null;
        last: number | null;
        n: number;
      },
      [number]
    >(
      `SELECT c.guid, c.chat_identifier, c.display_name, c.style, c.service_name,
              MAX(m.date) AS last, COUNT(m.ROWID) AS n
         FROM chat c
         JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
         JOIN message m ON m.ROWID = cmj.message_id
        GROUP BY c.ROWID
        ORDER BY last DESC
        LIMIT ?`,
    )
    .all(limit);

  const partQ = db.query<{ id: string }, [string]>(
    `SELECT h.id FROM handle h
       JOIN chat_handle_join chj ON chj.handle_id = h.ROWID
       JOIN chat c ON c.ROWID = chj.chat_id
      WHERE c.guid = ?`,
  );

  return rows.map(r => {
    const participants = partQ.all(r.guid).map(p => nameFor(p.id));
    return {
      chatId: r.guid,
      name:
        r.style === 43
          ? r.display_name?.trim() || participants.slice(0, 3).join(", ") || "group"
          : nameFor(r.chat_identifier),
      kind: r.style === 43 ? "group" : "dm",
      service: r.service_name,
      participants,
      lastAt: r.last ? appleToDate(r.last).toISOString() : null,
      messages: r.n,
    };
  });
}

export function attachmentsFor(rowid: number): { path: string; mime: string | null; name: string | null }[] {
  const db = open();
  return db
    .query<{ filename: string | null; mime_type: string | null; transfer_name: string | null }, [number]>(
      `SELECT a.filename, a.mime_type, a.transfer_name
         FROM attachment a
         JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
        WHERE maj.message_id = ?`,
    )
    .all(rowid)
    .filter(a => a.filename)
    .map(a => ({
      path: a.filename!.startsWith("~/")
        ? a.filename!.replace("~", process.env.HOME ?? "")
        : a.filename!,
      mime: a.mime_type,
      name: a.transfer_name,
    }));
}
