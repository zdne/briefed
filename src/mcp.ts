import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AnalystAI } from "./ai.js";
import { normalizeClip } from "./clip.js";
import { config } from "./config.js";
import {
  getDigestForRendering,
  listClips,
  markContentClipped,
  pool,
  resolveDigestCitation,
  retrieveRelevantClips
} from "./db.js";
import { renderDigestMarkdown, renderQueryMarkdown } from "./markdown.js";
import { clipUrl, ingestClip } from "./pipeline.js";
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
    const ageHours = (Date.now() - createdAt.getTime()) / 3_600_000;
    const staleWarning = ageHours > 25
      ? `> ⚠️ This briefing is from ${createdAt.toLocaleDateString("en-US", { month: "long", day: "numeric" })} — today's briefing has not been generated yet (sync may have been incomplete).\n\n`
      : "";
    const markdown = staleWarning + renderDigestMarkdown(result, createdAt);
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
      "Save a URL or text to the Brief archive for later retrieval, or mark an existing archive item as clipped. Use for prompts like \"clip this for me: https://...\", \"save this page to my archive\", \"save this note: [pasted text]\". For an item already in the archive — \"clip source 3 from my briefing\", \"save that article about X for later\" — pass citation (the \"Source N\" number, resolved server-side against the actual briefing) rather than guessing any numeric id; a raw id is never accepted. If you already have the item's canonical URL (e.g. from the rendered briefing text), passing url also works and marks it in place without re-fetching. One of url, text, or citation is required.",
    inputSchema: {
      url: z.string().url().optional().describe("URL to fetch and store, or an already-archived URL to mark as clipped in place."),
      text: z.string().min(1).optional().describe("Raw text to store directly."),
      citation: z.number().int().positive().optional().describe("The \"Source N\" citation number from a rendered briefing. Resolved server-side against digestId (or the latest briefing) to the real archive item — use this instead of guessing a numeric id."),
      digestId: z.number().int().positive().optional().describe("Digest id to resolve citation against. Omit to use the latest briefing."),
      title: z.string().optional().describe("Optional title override."),
      note: z.string().optional().describe("Optional note appended to the content before enrichment, or attached to the marked item.")
    }
  },
  async ({ url, text, citation, digestId, title, note }) => {
    if (citation !== undefined) {
      const resolved = await resolveDigestCitation(citation, digestId);
      if (!resolved) {
        const where = digestId ? `digest ${digestId}` : "the latest digest";
        return jsonToolResult({ error: `No source ${citation} in ${where}` }, `No source ${citation} in ${where}`, true);
      }
      const marked = await markContentClipped(resolved.contentId, note);
      const message = `Marked as clipped: ${marked?.title ?? resolved.title ?? `source ${citation}`}`;
      return jsonToolResult({ ...marked, marked: true, digestId: resolved.digestId, citation, message }, message);
    }
    if (url) {
      const result = await clipUrl(url, title, note, new AnalystAI(), stderrLogger);
      const warning = result.fetchBlocked
        ? ` The page was blocked by a bot-challenge (e.g. Cloudflare) — the URL is stored but no content was fetched. Try re-clipping with the article text, or use web_search to find the content and re-clip with text.`
        : "";
      const label = result.title ?? url;
      const message = `${result.marked ? "Marked as clipped" : result.isNew ? "Clipped" : "Updated clip"}: ${label}.${warning}`;
      return jsonToolResult({ ...result, message }, message);
    }
    if (!text) {
      return jsonToolResult({ error: "clip requires url, text, or citation" }, "clip requires url, text, or citation", true);
    }
    const collectedAt = new Date().toISOString();
    const { entry } = await normalizeClip({ text, title, note }, collectedAt);
    const result = await ingestClip(entry, new AnalystAI(), stderrLogger);
    const message = `${result.isNew ? "Clipped" : "Updated clip"}: ${entry.title ?? "text clip"}.`;
    return jsonToolResult({ id: result.id, isNew: result.isNew, title: entry.title, url: entry.canonicalUrl, fetchBlocked: false, message }, message);
  }
);

server.registerTool(
  "clips",
  {
    title: "Clips",
    description:
      "List or search everything saved to the archive — both freshly clipped URLs/text and existing items marked as clipped. Use for prompts like \"what have I clipped recently?\", \"show me my last 10 clips\", \"find what I clipped about MCP\", or \"have I saved anything on Stripe?\". Omit query for a chronological list (most recently saved first); supply query for semantic search over saved items.",
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
