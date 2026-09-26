import { describe, expect, test } from "vitest";
import { nameFor, findContacts, allContacts } from "../src/contacts.js";

/**
 * These run against the real Contacts database, which differs per machine, so
 * they assert on behavior that holds for any address book rather than on
 * specific people.
 */
describe("contacts", () => {
  test("loads without throwing even when Contacts is empty", () => {
    expect(Array.isArray(allContacts())).toBe(true);
  });

  test("returns the handle unchanged when nobody matches", () => {
    expect(nameFor("+19999999999")).toBe("+19999999999");
  });

  test("handles a null handle", () => {
    expect(nameFor(null)).toBe("unknown");
  });

  test("an empty query matches nobody", () => {
    expect(findContacts("")).toEqual([]);
    expect(findContacts("   ")).toEqual([]);
  });

  test("every contact it returns has at least one sendable handle", () => {
    for (const c of allContacts().slice(0, 50)) {
      expect(c.handles.length).toBeGreaterThan(0);
      expect(c.name.length).toBeGreaterThan(0);
    }
  });

  test("name search is case-insensitive and ranks exact matches first", () => {
    const all = allContacts();
    if (all.length === 0) return; // No contacts on this machine.
    const target = all[0]!.name;
    const hits = findContacts(target.toLowerCase());
    expect(hits[0]?.name).toBe(target);
  });
});
