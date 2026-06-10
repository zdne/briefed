import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AnalystAI } from "./ai.js";
import { config } from "./config.js";
import { getDigestForRendering, pool } from "./db.js";
import { createDigest } from "./digest.js";
import { renderDigestMarkdown, renderQueryMarkdown } from "./markdown.js";
import { queryArchive } from "./query.js";

const server = new McpServer({
  name: "brief",
  version: "0.1.0"
});

const queryArchiveInput = {
  question: z.string().trim().min(1).describe("Question to answer from the archived sources."),
  limit: z.number().int().min(1).max(30).optional().describe("Maximum number of sources to retrieve.")
};

const createDigestInput = {
  hours: z.number().int().min(1).optional().describe("Lookback window in hours. Defaults to DIGEST_HOURS."),
  daysAgo: z.number().int().min(0).optional().describe("End the briefing window N days before now.")
};

const latestDigestInput = {
  id: z.number().int().min(1).optional().describe("Stored briefing id. Defaults to the latest stored briefing.")
};

server.registerTool(
  "health",
  {
    title: "Health",
    description: "Check that Brief can connect to the configured Postgres database."
  },
  async () => {
    await pool.query("SELECT 1");
    return jsonToolResult({
      status: "ok",
      database: "connected",
      poolMax: config.PG_POOL_MAX
    });
  }
);

server.registerTool(
  "brief",
  {
    title: "Brief",
    description: "Ask a question over the Brief archive. Returns an answer with citations and source metadata.",
    inputSchema: queryArchiveInput
  },
  async ({ question, limit }) => {
    const result = await queryArchive(question, limit ?? config.QUERY_LIMIT, new AnalystAI(), stderrLogger);
    const createdAt = new Date().toISOString();
    const markdown = renderQueryMarkdown(question, { createdAt, ...result });
    return jsonToolResult({
      createdAt,
      question,
      answer: result.answer,
      sources: result.sources,
      markdown
    }, markdown);
  }
);

server.registerTool(
  "create_briefing",
  {
    title: "Create Briefing",
    description:
      "Create and store a briefing in Brief. This performs embedding and LLM calls, can be slow, and may take 30-60 seconds.",
    inputSchema: createDigestInput
  },
  async ({ hours, daysAgo }) => {
    const digestHours = hours ?? config.DIGEST_HOURS;
    const offsetDays = daysAgo ?? 0;
    const referenceTime = new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000);
    const result = await createDigest(digestHours, new AnalystAI(), stderrLogger, referenceTime);
    const createdAt = new Date();
    const markdown = renderDigestMarkdown(result, createdAt);
    return jsonToolResult({
      createdAt: createdAt.toISOString(),
      hours: digestHours,
      daysAgo: offsetDays,
      id: result.id,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      body: result.body,
      sources: result.sources,
      markdown
    }, markdown);
  }
);

server.registerTool(
  "briefing",
  {
    title: "Briefing",
    description: "Render the latest stored Brief briefing, or a specific stored briefing by id.",
    inputSchema: latestDigestInput
  },
  async ({ id }) => {
    const result = await getDigestForRendering(id);
    if (!result) {
      const message = id === undefined ? "No stored briefings found." : `Briefing ${id} not found.`;
      return jsonToolResult({ error: message }, message, true);
    }
    const createdAt = new Date(result.createdAt);
    const markdown = renderDigestMarkdown(result, createdAt);
    return jsonToolResult({
      id: result.id,
      createdAt: result.createdAt,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      body: result.body,
      sources: result.sources,
      markdown
    }, markdown);
  }
);

function jsonToolResult(data: Record<string, unknown>, text = JSON.stringify(data, null, 2), isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text
      }
    ],
    structuredContent: data,
    isError
  };
}

function stderrLogger(message: string): void {
  console.error(`[${new Date().toISOString()}] ${message}`);
}

const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error(error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});
