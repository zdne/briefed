import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AnalystAI } from "./ai.js";
import { normalizeClip } from "./clip.js";
import { config } from "./config.js";
import { getDigestForRendering, listClips, pool, retrieveRelevantClips } from "./db.js";
import { createDigest } from "./digest.js";
import { renderDigestMarkdown, renderQueryMarkdown } from "./markdown.js";
import { ingestClip } from "./pipeline.js";
import { queryArchive } from "./query.js";
import {
  briefingPreferencesSchema,
  collectorsSchema,
  loadUserConfig,
  updateBriefingPreferences,
  updateCollectors,
  updateUserConfig,
  userConfigSchema
} from "./user-config.js";

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

const updateUserConfigInput = {
  config: userConfigSchema.describe("Complete replacement briefed.config.json user configuration.")
};

const updateCollectorsInput = {
  collectors: collectorsSchema.describe("Complete replacement collectors section.")
};

const updateBriefingPreferencesInput = {
  briefing: briefingPreferencesSchema.describe("Complete replacement briefing preferences section.")
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

server.registerTool(
  "clip",
  {
    title: "Clip",
    description:
      "Save a URL or text to the Brief archive for later retrieval and briefing. Use for prompts like \"clip this for me: https://...\", \"save this page to my archive\", \"clip this and note it's relevant to agentic payments: https://...\", or \"save this note: [pasted text]\". One of url or text is required. The note is appended to the content before enrichment.",
    inputSchema: {
      url: z.string().url().optional().describe("URL to fetch and store."),
      text: z.string().min(1).optional().describe("Raw text to store directly."),
      title: z.string().optional().describe("Optional title override."),
      note: z.string().optional().describe("Optional note appended to the content before enrichment.")
    }
  },
  async ({ url, text, title, note }) => {
    if (!url && !text) {
      return jsonToolResult({ error: "clip requires url or text" }, "clip requires url or text", true);
    }
    const collectedAt = new Date().toISOString();
    const { entry, fetchBlocked } = await normalizeClip({ url, text, title, note }, collectedAt);
    const result = await ingestClip(entry, new AnalystAI(), stderrLogger);
    const label = entry.title ?? url ?? "text clip";
    const warning = fetchBlocked
      ? ` The page was blocked by a bot-challenge (e.g. Cloudflare) — the URL is stored but no content was fetched. Try re-clipping with the article text, or use web_search to find the content and re-clip with text.`
      : "";
    const message = `${result.isNew ? "Clipped" : "Updated clip"}: ${label}.${warning}`;
    return jsonToolResult({ id: result.id, isNew: result.isNew, title: entry.title, url: entry.canonicalUrl, fetchBlocked, message }, message);
  }
);

server.registerTool(
  "clips",
  {
    title: "Clips",
    description:
      "List or search saved clips. Use for prompts like \"what have I clipped recently?\", \"show me my last 10 clips\", \"find what I clipped about MCP\", or \"have I saved anything on Stripe?\". Omit query for a chronological list; supply query for semantic search over clips.",
    inputSchema: {
      query: z.string().optional().describe("Semantic search query. Omit to list most recent clips."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum clips to return. Defaults to 10.")
    }
  },
  async ({ query, limit = 10 }) => {
    if (query) {
      const ai = new AnalystAI();
      const embedding = await ai.embed(query);
      const results = await retrieveRelevantClips(embedding, limit);
      return jsonToolResult({ query, clips: results });
    }
    const clips = await listClips(limit);
    return jsonToolResult({ clips });
  }
);

server.registerTool(
  "get_user_config",
  {
    title: "Get User Config",
    description:
      "Returns the full non-secret Brief user configuration: collector enablement/selectors and briefing preferences."
  },
  async () => jsonToolResult(await loadUserConfig())
);

server.registerTool(
  "update_user_config",
  {
    title: "Update User Config",
    description:
      "Replaces the full non-secret Brief user configuration after validation. Use this for agent-managed preferences, not secrets or infrastructure.",
    inputSchema: updateUserConfigInput
  },
  async ({ config: nextConfig }) => jsonToolResult(await updateUserConfig(nextConfig))
);

server.registerTool(
  "update_collectors",
  {
    title: "Update Collectors",
    description:
      "Replaces the collectors section of briefed.config.json after validation.",
    inputSchema: updateCollectorsInput
  },
  async ({ collectors }) => jsonToolResult(await updateCollectors(collectors))
);

server.registerTool(
  "update_briefing_preferences",
  {
    title: "Update Briefing Preferences",
    description:
      "Replaces briefing requiredTopics and focusAreas in briefed.config.json after validation.",
    inputSchema: updateBriefingPreferencesInput
  },
  async ({ briefing }) => jsonToolResult(await updateBriefingPreferences(briefing))
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
