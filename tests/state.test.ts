import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "imessage-mcp-test-"));
  process.env.IMESSAGE_STATE_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.IMESSAGE_STATE_DIR;
});

/** Imported fresh each time so STATE_DIR picks up the temp directory. */
async function state() {
  vi.resetModules();
  return await import("../src/state.js");
}

describe("cursor", () => {
  test("starts empty", async () => {
    const s = await state();
    expect(s.loadState().cursor).toBe(0);
  });

  test("survives being written and read back by a separate load", async () => {
    const s = await state();
    s.saveState({ cursor: 4242, updatedAt: new Date().toISOString() });
    const fresh = await state();
    expect(fresh.loadState().cursor).toBe(4242);
  });

  test("advances forward", async () => {
    const s = await state();
    s.advanceCursor(10);
    s.advanceCursor(20);
    expect(s.loadState().cursor).toBe(20);
  });

  /** Going backwards would replay messages a client has already seen. */
  test("never moves backwards", async () => {
    const s = await state();
    s.advanceCursor(100);
    s.advanceCursor(50);
    expect(s.loadState().cursor).toBe(100);
  });

  test("treats a corrupt state file as empty rather than throwing", async () => {
    writeFileSync(join(dir, "state.json"), "{ not json");
    const s = await state();
    expect(s.loadState().cursor).toBe(0);
  });

  test("rejects a negative cursor from a tampered file", async () => {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ cursor: -5 }));
    const s = await state();
    expect(s.loadState().cursor).toBe(0);
  });
});
