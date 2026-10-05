/**
 * The CLI, now built by Slipway from the same tools as the MCP server.
 *
 * Parsing, help and output shapes are Slipway's and tested there. These cover
 * what this repo promises: every tool is a command, a task is found by what it
 * does, 0.3's flag spellings still answer, a Mac that cannot read Messages
 * says so with exit 10, and the docs stay in step with the code. The database
 * is a path that does not exist, so nothing here can read a real message.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

process.env.IMESSAGE_DB = "/nonexistent/chat.db";
// Contacts are read from HOME, so an empty one keeps this Mac's address book out of the tests.
process.env.HOME = mkdtempSync(join(tmpdir(), "imessage-home-"));
const { checkApp, cli, connect } = await import("@thenavidm/slipway/testing");
const { app } = await import("../src/app.js");
const { TOOLS } = await import("../src/tools.js");

describe("iMessage CLI on Slipway", () => {
  it("makes all 10 tools commands, the three that send needing confirmation", async () => {
    const context = JSON.parse((await cli(app, ["agent-context", "--brief"], { env: {} })).stdout);
    const commands = context.commands as Array<{ command: string; requires_confirm?: boolean }>;
    expect(commands.map((c) => c.command)).toEqual(TOOLS.map((tool) => tool.name.replace(/_/g, "-")));
    expect(commands.filter((c) => c.requires_confirm).map((c) => c.command).sort()).toEqual(["send-file", "send-message", "speak"]);
  });

  it("finds the command for a task described in words", async () => {
    const first = async (...words: string[]) => (await cli(app, ["which", ...words], { env: {} })).stdout.split("\n")[0];
    expect(await first("send", "a", "text", "message")).toContain("send-message");
    expect(await first("transcribe", "a", "voice", "note")).toContain("transcribe-voice-note");
  });

  it("takes 0.3's kebab-case flags as well as each input's own name", async () => {
    const kebab = await cli(app, ["get-conversation", "--chat-id", "x", "--agent"], { env: {} });
    const own = await cli(app, ["get-conversation", "--chatId", "x", "--agent"], { env: {} });
    // Both get as far as the database, which does not exist here.
    expect(kebab.code).toBe(4);
    expect(own.code).toBe(4);
  });

  it("reports a missing argument by its flag", async () => {
    const run = await cli(app, ["get-conversation", "--agent"], { env: {} });
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stderr).error).toMatch(/--chatId/);
  });

  it("exits 4 when macOS will not let it read Messages, as 0.3 did, and says why", async () => {
    const run = await cli(app, ["search-messages", "--query", "x", "--agent"], { env: {} });
    expect(run.code).toBe(4);
    expect(JSON.parse(run.stderr).error).toMatch(/cannot read \/nonexistent\/chat\.db.*Full Disk Access/);
  });

  it("refuses --http without a bearer token, even on this machine", () => {
    const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    if (!existsSync(entry)) return; // CI builds before it tests; a bare checkout has no dist yet.
    const run = spawnSync(process.execPath, [entry, "--http"], { env: { PATH: process.env.PATH, HOME: "/nonexistent" }, encoding: "utf8" });
    expect(run.status).toBe(10);
    expect(run.stderr).toMatch(/IMESSAGE_HTTP_TOKEN is not set/);
  });

  it("shows the person approving a send its words, and keeps them out of the audit log", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "imessage-audit-")), "audit.jsonl");
    const asked: Array<{ message: string }> = [];
    // The person declines, so nothing is sent.
    const mcp = await connect(app, { env: { IMESSAGE_AUDIT_LOG: log }, elicit: (request: { message: string }) => (asked.push(request), { action: "decline" as const }) });
    const result = await mcp.callTool("send_message", { to: "+15555550100", text: "see you at noon" });
    await mcp.close();
    expect(result.isError).toBe(true);
    expect(asked[0]!.message).toBe('iMessage wants to send a 15-character message to +15555550100.\n\n"see you at noon"\n\nThis can\'t be unsent.');
    expect(readFileSync(log, "utf8")).not.toContain("see you at noon");
  });

  it("passes slipway check", async () => {
    const report = await checkApp(app, { env: {} });
    expect(report.findings.filter((finding: { level: string }) => finding.level === "error")).toEqual([]);
  });
});

describe("documentation stays in step with the code", () => {
  const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf-8");
  const names = (text: string): Set<string> =>
    new Set((text.match(/\b(?:IMESSAGE|GROQ|OPENAI|ELEVENLABS)_[A-Z_]+/g) ?? []).filter((name) => !name.endsWith("_")));
  const source = (dir: string): string =>
    readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? source(`${dir}${entry.name}/`) : entry.name.endsWith(".ts") ? read(`${dir}${entry.name}`) : ""))
      .join("\n");

  const used = async (): Promise<Set<string>> => {
    const context = JSON.parse((await cli(app, ["agent-context"], { env: {} })).stdout);
    // Only this server's names that the code reads from the environment: GROQ_MODEL is a constant, HOME the system's.
    const read = [...source("../src/").matchAll(/process\.env\.((?:IMESSAGE|GROQ|OPENAI|ELEVENLABS)_[A-Z0-9_]+)/g)].map((m) => m[1] as string);
    return new Set([...read, ...context.settings.map((setting: { env: string }) => setting.env)]);
  };

  it("documents every environment variable the code reads", async () => {
    const documented = names(read("../README.md"));
    expect([...(await used())].filter((v) => !documented.has(v))).toEqual([]);
  });

  it.each(["../README.md"])("has no dead in-page anchors in %s", (file) => {
    if (!existsSync(new URL(file, import.meta.url))) return;
    const md = read(file).replace(/```[\s\S]*?```/g, "");
    // GitHub's slug keeps letters, marks, numbers and connector punctuation, so an
    // emoji's variation selector (U+FE0F) stays in the anchor and a link has to carry it.
    const slugs = new Set(
      [...md.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) =>
        (heading as string).trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\s-]/gu, "").replace(/ /g, "-"),
      ),
    );
    const dead = [...md.matchAll(/\[[^\]]+\]\(#([^)]+)\)/g)].map((m) => decodeURIComponent(m[1] as string)).filter((a) => !slugs.has(a));
    expect(dead).toEqual([]);
  });
});
