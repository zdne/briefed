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
  question: z.string().trim().min(1).describe(
    "Natural-language question to answer from the synced Brief archive. Use this for topical, source-specific, or exploratory requests such as \"brief me on recent topics from Twitter\", \"what is happening with MCP?\", or \"any signal on open-source agent frameworks?\""
  ),
  limit: z.number().int().min(1).max(30).optional().describe(
    "Maximum number of archived sources to retrieve for the answer. Increase for broad or multi-topic questions."
  )
};

const createDigestInput = {
  hours: z.number().int().min(1).optional().describe(
    "Lookback window in hours for a new briefing. Defaults to DIGEST_HOURS."
  ),
  daysAgo: z.number().int().min(0).optional().describe(
    "End the new briefing window N days before now. Use 1 for yesterday."
  )
};

const latestDigestInput = {
  id: z.number().int().min(1).optional().describe(
    "Stored briefing id to render. Omit to return the latest stored briefing."
  )
};

server.registerTool(
  "health",
  {
    title: "Health",
    description: "Use to check whether Brief is connected and able to reach the configured Postgres archive."
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
    description:
      "Use for ad hoc questions over the synced Brief archive, including articles, newsletters, Reddit, Hacker News, and Twitter/X sources. Best for prompts like \"brief me on recent topics from Twitter\", \"give me a brief on agentic payments\", \"what do I know about Anthropic's latest moves?\", or \"any signal on open-source agent frameworks this week?\" Returns a cited answer and source metadata. Do not use this just to show the latest saved morning briefing; use briefing for that.",
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
      "Use when the user asks to generate a new briefing for a time window, such as \"create my briefing for the last 48 hours\", \"generate yesterday's briefing\", or \"make a briefing for the past week\". This creates and stores a new briefing, performs embedding and LLM calls, can be slow, and may take 30-60 seconds. Do not use for quick topical questions; use brief instead.",
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
    description:
      "Use to show an already stored briefing, especially for prompts like \"give me my morning briefing\", \"what's my latest briefing?\", \"show me briefing #4\", or \"show the latest saved briefing\". It returns the latest stored briefing by default or a specific briefing by id. Do not use for new topical archive searches; use brief instead.",
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
