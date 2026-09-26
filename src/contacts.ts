import { Database } from "./sqlite.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { globSync } from "node:fs";

/**
 * Contacts lives in one or more AddressBook sqlite files: a top-level one plus
 * a directory of per-account sources (iCloud, Exchange, On My Mac). A handle
 * can appear in any of them, so all are searched.
 */
function addressBookPaths(): string[] {
  const base = join(homedir(), "Library/Application Support/AddressBook");
  const paths = [join(base, "AddressBook-v22.abcddb")];
  try {
    paths.push(...globSync("Sources/*/AddressBook-v22.abcddb", { cwd: base }).map(p => join(base, p)));
  } catch {
    // No sources directory is normal on a Mac with only local contacts.
  }
  return paths;
}

export type Contact = { name: string; handles: string[] };

/** Digits only, so +46 709 52 41 56 and 0709524156 compare equal on the tail. */
const digits = (s: string): string => s.replace(/\D/g, "");

/** Phone numbers are matched on the last 7 digits to survive country-code and
 *  formatting differences between Contacts and Messages. */
const tail = (s: string): string => {
  const d = digits(s);
  return d.length > 7 ? d.slice(-7) : d;
};

let cache: Contact[] | null = null;

export function allContacts(): Contact[] {
  if (cache) return cache;
  const out = new Map<string, Set<string>>();

  for (const path of addressBookPaths()) {
    let db: Database;
    try {
      db = new Database(path, { readonly: true });
    } catch {
      continue; // Source may be absent or locked; the others still count.
    }
    try {
      const rows = db
        .query<{ first: string | null; last: string | null; org: string | null; value: string | null }, []>(
          `SELECT r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, r.ZORGANIZATION AS org, p.ZFULLNUMBER AS value
             FROM ZABCDRECORD r JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
           UNION ALL
           SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, e.ZADDRESS
             FROM ZABCDRECORD r JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK`,
        )
        .all();

      for (const row of rows) {
        if (!row.value) continue;
        const name = [row.first, row.last].filter(Boolean).join(" ").trim() || (row.org ?? "").trim();
        if (!name) continue;
        if (!out.has(name)) out.set(name, new Set());
        out.get(name)!.add(row.value.trim());
      }
    } catch {
      // Schema differs across macOS releases; skip a source we cannot read.
    } finally {
      db.close();
    }
  }

  cache = [...out].map(([name, handles]) => ({ name, handles: [...handles] }));
  return cache;
}

/** Display name for a raw handle, or the handle itself when unknown. */
export function nameFor(handle: string | null): string {
  if (!handle) return "unknown";
  const isEmail = handle.includes("@");
  const key = isEmail ? handle.toLowerCase() : tail(handle);
  if (!key) return handle;

  for (const c of allContacts()) {
    for (const h of c.handles) {
      if (isEmail ? h.toLowerCase() === key : h.includes("@") ? false : tail(h) === key) return c.name;
    }
  }
  return handle;
}

/** Contacts whose name loosely matches a query, best first. */
export function findContacts(query: string): Contact[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = allContacts()
    .map(c => {
      const n = c.name.toLowerCase();
      const score = n === q ? 3 : n.startsWith(q) ? 2 : n.includes(q) ? 1 : 0;
      return { c, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
  return scored.map(x => x.c);
}
