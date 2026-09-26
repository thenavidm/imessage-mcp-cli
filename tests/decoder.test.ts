import { describe, expect, test } from "vitest";
import { decodeAttributedBody } from "../src/db.js";

/**
 * Builds a minimal streamtyped payload of the shape Messages writes:
 * ...NSString<class metadata>0x2B<length prefix><utf-8 bytes>...
 */
function blob(text: string): Uint8Array {
  const body = Buffer.from(text, "utf8");
  const len = body.length;

  let prefix: Buffer;
  if (len < 0x81) {
    prefix = Buffer.from([len]);
  } else if (len <= 0xffff) {
    prefix = Buffer.alloc(3);
    prefix[0] = 0x81;
    prefix.writeUInt16LE(len, 1);
  } else {
    prefix = Buffer.alloc(5);
    prefix[0] = 0x82;
    prefix.writeUInt32LE(len, 1);
  }

  return new Uint8Array(
    Buffer.concat([
      Buffer.from("\x04\x0bstreamtyped"),
      Buffer.from("NSString"),
      Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
      prefix,
      body,
      Buffer.from([0x86]),
    ]),
  );
}

describe("decodeAttributedBody", () => {
  test("returns null for no blob", () => {
    expect(decodeAttributedBody(null)).toBeNull();
  });

  test("reads a short string from a single-byte length", () => {
    expect(decodeAttributedBody(blob("Hey"))).toBe("Hey");
  });

  test("reads a string at the single-byte boundary", () => {
    const s = "a".repeat(0x80);
    expect(decodeAttributedBody(blob(s))).toBe(s);
  });

  /**
   * The regression that matters. After a 0x81 marker the length is two bytes,
   * little-endian. Reading one byte returns len & 0xFF, so a 618-byte message
   * decodes as 106 and the rest is silently dropped.
   */
  test("reads a long string from a two-byte length", () => {
    const s = "x".repeat(618);
    const out = decodeAttributedBody(blob(s));
    expect(out).toBe(s);
    expect(out?.length).toBe(618);
    expect(out?.length).not.toBe(618 & 0xff);
  });

  test("does not truncate at any length either side of the boundary", () => {
    for (const n of [127, 128, 255, 256, 257, 512, 707, 4096]) {
      const s = "y".repeat(n);
      expect(decodeAttributedBody(blob(s))?.length).toBe(n);
    }
  });

  test("reads a very long string from a four-byte length", () => {
    const s = "z".repeat(70000);
    expect(decodeAttributedBody(blob(s))?.length).toBe(70000);
  });

  test("round-trips multi-byte utf-8", () => {
    const s = "hej hallå 👋 " + "å".repeat(200);
    expect(decodeAttributedBody(blob(s))).toBe(s);
  });

  test("returns null rather than throwing on a truncated blob", () => {
    const good = blob("hello world");
    expect(decodeAttributedBody(good.slice(0, good.length - 6))).toBeNull();
  });

  test("returns null when there is no NSString marker", () => {
    expect(decodeAttributedBody(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});
