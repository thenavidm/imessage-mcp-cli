/**
 * The write guard, through the real server over MCP. Sending is mocked, so
 * nothing here can reach Messages: the tests prove what reaches the sender,
 * not that a message arrives.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const sent = vi.hoisted(() => ({ text: [] as unknown[][], file: [] as unknown[][] }));
vi.mock("../src/send.js", () => ({
  sendText: async (...args: unknown[]) => (sent.text.push(args), { ok: true, detail: "delivered" }),
  sendFile: async (...args: unknown[]) => (sent.file.push(args), { ok: true, detail: "delivered" }),
}));
vi.mock("../src/contacts.js", () => ({ nameFor: () => "Anna", findContacts: () => [], allContacts: () => [] }));

const { buildServer } = await import("../src/server.js");

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([buildServer().connect(b), client.connect(a)]);
  return client;
}
const textOf = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");

beforeEach(() => {
  sent.text.length = 0;
  sent.file.length = 0;
});
afterEach(() => {
  delete process.env.IMESSAGE_READ_ONLY;
  delete process.env.IMESSAGE_AUDIT_LOG;
});

describe("sending asks first", () => {
  it("refuses send_message without confirm, and names what would have gone", async () => {
    const r: any = await (await connect()).callTool({ name: "send_message", arguments: { to: "+15550100", text: "Running late" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/will not run without confirm: true/);
    expect(textOf(r)).toContain('send "Running late" to Anna (+15550100)');
    expect(sent.text).toHaveLength(0);
  });

  it("sends once confirm is true", async () => {
    const r: any = await (await connect()).callTool({ name: "send_message", arguments: { to: "+15550100", text: "Running late", confirm: true } });
    expect(r.isError).toBeFalsy();
    expect(sent.text).toEqual([["+15550100", "Running late"]]);
  });

  it("guards send_file, and speak only when it has a recipient", async () => {
    const client = await connect();
    const file: any = await client.callTool({ name: "send_file", arguments: { to: "+15550100", path: "/tmp/x.png" } });
    expect(file.isError).toBe(true);
    const spoken: any = await client.callTool({ name: "speak", arguments: { text: "hi", to: "+15550100" } });
    expect(textOf(spoken)).toMatch(/will not run without confirm: true/);
    expect(sent.file).toHaveLength(0);
  });

  it("asks for confirm in every sending tool's schema", async () => {
    const { tools } = await (await connect()).listTools();
    for (const name of ["send_message", "send_file", "speak"]) {
      expect(tools.find((t) => t.name === name)?.inputSchema.properties).toHaveProperty("confirm");
    }
  });
});

describe("IMESSAGE_READ_ONLY", () => {
  it("takes the sending tools off the list and refuses them if called anyway", async () => {
    process.env.IMESSAGE_READ_ONLY = "1";
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("send_message");
    expect(names).not.toContain("send_file");
    expect(names).not.toContain("speak");
    expect(names).toContain("inbox");
    const r: any = await client.callTool({ name: "send_message", arguments: { to: "+15550100", text: "x", confirm: true } });
    expect(textOf(r)).toMatch(/IMESSAGE_READ_ONLY is on/);
    expect(sent.text).toHaveLength(0);
  });
});

describe("IMESSAGE_AUDIT_LOG", () => {
  it("records every attempt with the recipient and size, never the words", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "imessage-audit-")), "audit.log");
    process.env.IMESSAGE_AUDIT_LOG = log;
    const client = await connect();
    await client.callTool({ name: "send_message", arguments: { to: "+15550100", text: "A private thing" } });
    await client.callTool({ name: "send_message", arguments: { to: "+15550100", text: "A private thing", confirm: true } });
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.outcome)).toEqual(["blocked: no confirm", "sent"]);
    expect(lines[0]).toMatchObject({ tool: "send_message", to: "+15550100", chars: 15 });
    expect(readFileSync(log, "utf8")).not.toContain("private");
  });
});
