/**
 * The send guard, now Slipway's, through the real server over MCP and the CLI.
 * Sending is mocked, so nothing here can reach Messages: the tests prove what
 * reaches the sender, not that a message arrives.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cli, connect } from "@thenavidm/slipway/testing";

const sent = vi.hoisted(() => ({ text: [] as unknown[][], file: [] as unknown[][] }));
vi.mock("../src/send.js", () => ({
  sendText: async (...args: unknown[]) => (sent.text.push(args), { ok: true, detail: "delivered" }),
  sendFile: async (...args: unknown[]) => (sent.file.push(args), { ok: true, detail: "delivered" }),
}));
vi.mock("../src/contacts.js", () => ({ nameFor: () => "Anna", findContacts: () => [], allContacts: () => [] }));

const { app } = await import("../src/app.js");
const textOf = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");

beforeEach(() => {
  sent.text.length = 0;
  sent.file.length = 0;
});

describe("sending asks first", () => {
  it("refuses send_message without confirm, naming the recipient and the size but not the words", async () => {
    const mcp = await connect(app, { env: {} });
    const r = await mcp.callTool("send_message", { to: "+15550100", text: "Running late" });
    await mcp.close();
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("send_message can't be unsent, so it will not run without confirm: true. About to: send a 12-character message to Anna (+15550100).");
    expect(textOf(r)).not.toContain("Running late");
    expect(sent.text).toHaveLength(0);
  });

  it("sends once confirm is true", async () => {
    const mcp = await connect(app, { env: {} });
    const r = await mcp.callTool("send_message", { to: "+15550100", text: "Running late", confirm: true });
    await mcp.close();
    expect(r.isError).toBeFalsy();
    expect(sent.text).toEqual([["+15550100", "Running late"]]);
  });

  it("guards send_file, and speak only when it has a recipient", async () => {
    const mcp = await connect(app, { env: {} });
    const file = await mcp.callTool("send_file", { to: "+15550100", path: "/tmp/x.png" });
    const spoken = await mcp.callTool("speak", { text: "hi", to: "+15550100" });
    await mcp.close();
    expect(file.isError).toBe(true);
    expect(textOf(spoken)).toMatch(/will not run without confirm: true/);
    expect(sent.file).toHaveLength(0);
    // Without a recipient speak only writes a file, so the CLI asks for no --confirm before trying.
    const quiet = await cli(app, ["speak", "--text", "hi", "--agent"], { env: { ELEVENLABS_API_KEY: "" } });
    expect(quiet.stderr).not.toMatch(/--confirm/);
  });

  it("asks for confirm in every sending tool's schema", async () => {
    const mcp = await connect(app, { env: {} });
    const tools = await mcp.listTools();
    await mcp.close();
    for (const name of ["send_message", "send_file", "speak"]) {
      expect(tools.find((t) => t.name === name)?.inputSchema.properties).toHaveProperty("confirm");
    }
  });
});

describe("IMESSAGE_READ_ONLY", () => {
  it("takes the sending tools off the list, keeps inbox, and the CLI names the setting", async () => {
    const mcp = await connect(app, { env: { IMESSAGE_READ_ONLY: "1" } });
    const names = (await mcp.listTools()).map((t) => t.name);
    await mcp.close();
    expect(names).not.toContain("send_message");
    expect(names).not.toContain("send_file");
    expect(names).not.toContain("speak");
    expect(names).toContain("inbox");
    const run = await cli(app, ["send-message", "--to", "+15550100", "--text", "x", "--confirm", "--agent"], { env: { IMESSAGE_READ_ONLY: "1" } });
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stderr).error).toContain("IMESSAGE_READ_ONLY");
    expect(sent.text).toHaveLength(0);
  });
});

describe("IMESSAGE_AUDIT_LOG", () => {
  it("records every attempt with the recipient and size, never the words", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "imessage-audit-")), "audit.log");
    const mcp = await connect(app, { env: { IMESSAGE_AUDIT_LOG: log } });
    await mcp.callTool("send_message", { to: "+15550100", text: "A private thing" });
    await mcp.callTool("send_message", { to: "+15550100", text: "A private thing", confirm: true });
    await mcp.close();
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.outcome)).toEqual(["blocked: no confirm", "allowed", "done"]);
    expect(lines[0]).toMatchObject({ tool: "send_message", summary: "send a 15-character message to Anna (+15550100)" });
    expect(readFileSync(log, "utf8")).not.toContain("private");
  });
});
