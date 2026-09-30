import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";

// End-to-end check that the real `npm run mcp` process still serves every
// pre-existing tool alongside the three new archive-discovery tools, and that
// list/get/lexical-search work without OPENAI_API_KEY or ANTHROPIC_API_KEY in
// the child's environment (proving they make no model call). Same local-DB
// gating as archive-db.test.ts — never runs against production.
const isLocalTestDb = /(^|@)(localhost|127\.0\.0\.1)([:/]|$)/.test(config.DATABASE_URL);
if (/neon\.tech/.test(config.DATABASE_URL) && isLocalTestDb) {
  throw new Error("archive-mcp.test.ts: refusing to run — DATABASE_URL looks like it points at Neon.");
}

describe.skipIf(!isLocalTestDb)("mcp server (spawned process integration)", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    const { OPENAI_API_KEY, ANTHROPIC_API_KEY, ...envWithoutModelKeys } = process.env;
    void OPENAI_API_KEY;
    void ANTHROPIC_API_KEY;

    transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/mcp.ts"],
      cwd: process.cwd(),
      env: { ...envWithoutModelKeys, DATABASE_URL: config.DATABASE_URL, PG_POOL_MAX: "2" } as Record<string, string>,
      stderr: "pipe"
    });
    client = new Client({ name: "archive-mcp-test", version: "0.0.1" });
    await client.connect(transport);
  }, 20_000);

  afterAll(async () => {
    await client?.close();
  });

  it("still lists every pre-existing tool alongside the three new archive tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const existing of [
      "health", "brief", "briefing", "clip", "clips",
      "get_user_config", "update_user_config", "update_collectors", "update_briefing_preferences"
    ]) {
      expect(names).toContain(existing);
    }
    for (const added of ["list_archive_items", "search_archive", "get_archive_items"]) {
      expect(names).toContain(added);
    }
  });

  it("marks the three new tools read-only via annotations", async () => {
    const { tools } = await client.listTools();
    for (const name of ["list_archive_items", "search_archive", "get_archive_items"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("health still reports a working DB connection", async () => {
    const result = await client.callTool({ name: "health", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { database: string }).database).toBe("connected");
  });

  it("list_archive_items and get_archive_items work end to end with no model keys in the environment", async () => {
    const listResult = await client.callTool({
      name: "list_archive_items",
      arguments: { updatedBefore: "2099-01-01T00:00:00Z", pageSize: 5 }
    });
    expect(listResult.isError).toBeFalsy();
    const listed = listResult.structuredContent as { items: Array<{ id: string }> };
    expect(Array.isArray(listed.items)).toBe(true);

    const getResult = await client.callTool({ name: "get_archive_items", arguments: { ids: ["999999999"] } });
    expect(getResult.isError).toBeFalsy();
    expect((getResult.structuredContent as { missingIds: string[] }).missingIds).toEqual(["999999999"]);
  });

  it("search_archive lexical mode works with no model keys in the environment", async () => {
    const result = await client.callTool({
      name: "search_archive",
      arguments: { query: "briefed integration test marker", mode: "lexical" }
    });
    expect(result.isError).toBeFalsy();
    const parsed = result.structuredContent as { embeddingCallMade: boolean; mode: string };
    expect(parsed.embeddingCallMade).toBe(false);
    expect(parsed.mode).toBe("lexical");
  });
});
