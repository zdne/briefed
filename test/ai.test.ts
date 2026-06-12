import { describe, expect, it } from "vitest";
import { buildDigestPrompt, buildFriendlyDigestPrompt, normalizeEnrichment } from "../src/ai.js";
import { parseCommaSeparatedList } from "../src/config.js";

describe("normalizeEnrichment", () => {
  it("normalizes, deduplicates, and caps model output", () => {
    const result = normalizeEnrichment({
      summary: "  Summary  ",
      topics: ["AI", " ai ", "", ...Array.from({ length: 12 }, (_, index) => `Topic ${index}`)],
      entities: [
        { name: " OpenAI ", type: " Company " },
        { name: "openai", type: "company" },
        ...Array.from({ length: 35 }, (_, index) => ({
          name: `Entity ${index}`,
          type: "Organization"
        }))
      ]
    });

    expect(result.summary).toBe("Summary");
    expect(result.topics).toHaveLength(10);
    expect(result.topics[0]).toBe("ai");
    expect(result.entities).toHaveLength(30);
    expect(result.entities[0]).toEqual({ name: "OpenAI", type: "company" });
    expect(result.entities.filter((entity) => entity.name.toLowerCase() === "openai")).toHaveLength(1);
  });
});

describe("parseCommaSeparatedList", () => {
  it("trims items and drops empty values", () => {
    expect(parseCommaSeparatedList("agentic payments, , personal memory ,MCP")).toEqual([
      "agentic payments",
      "personal memory",
      "MCP"
    ]);
  });
});

describe("buildDigestPrompt", () => {
  it("uses stable digest sections and grouped source context", () => {
    const prompt = buildDigestPrompt([
      {
        id: "1",
        title: "Payments update",
        canonicalUrl: "https://example.com/payments",
        author: "Analyst",
        publishedAt: "2026-06-05T10:00:00Z",
        summary: "Agentic payments signal.",
        contentText: "",
        score: 0
      },
      {
        id: "2",
        title: "MCP update",
        canonicalUrl: "https://example.com/mcp",
        author: null,
        publishedAt: null,
        summary: "MCP signal.",
        contentText: "",
        score: 0
      }
    ], 24, {
      requiredTopics: ["agentic payments"],
      focusAreas: ["MCP"],
      sourceContexts: [
        { bucket: "required", topic: "agentic payments" },
        { bucket: "important_general" }
      ]
    });

    expect(prompt).toContain("source-grounded report");
    expect(prompt).not.toContain("analyst digest");
    expect(prompt).not.toContain("## Top Items");
    expect(prompt).toContain("## Watchlist");
    expect(prompt).toContain("Allowed bullet forms:");
    expect(prompt).toContain("Report only what the cited source says");
    expect(prompt).toContain("Attribute claims to the source");
    expect(prompt).toContain("Use reporting language, not opinion, analyst filler, or judgements");
    expect(prompt).toContain("Do not write trend adjectives");
    expect(prompt).toContain("Prefer concrete verbs: launched, added, reported");
    expect(prompt).toContain("Each non-social bullet must start with a named actor or publication");
    expect(prompt).toContain("Social-source bullets are noun phrases only");
    expect(prompt).toContain("The platform name (\"Reddit:\", \"Twitter:\", \"Hacker News:\") is a prefix");
    expect(prompt).toContain("not a subject");
    expect(prompt).toContain("For social-source bullets, prefer labels over verbs");
    expect(prompt).toContain("Do not start bullets with abstract topics");
    expect(prompt).toContain("Do not infer adoption, trust, market maturity, or ecosystem momentum");
    expect(prompt).toContain("Do not claim momentum, growth, adoption, or market impact");
    expect(prompt).toContain("adoption metrics, named deployments, transaction volume, or customer usage");
    expect(prompt).toContain("Do not infer importance, sustainability, risk, business impact, or technical maturity");
    expect(prompt).toContain("Treat supplied summaries as input notes, not wording to copy.");
    expect(prompt).toContain("Do not repeat source-summary interpretation");
    expect(prompt).toContain("Prefer the smallest concrete claim");
    expect(prompt).toContain("Each bullet must cite exactly one source.");
    expect(prompt).toContain("Do not put multiple citation numbers in one bullet.");
    expect(prompt).toContain("Do not merge sources into a single bullet.");
    expect(prompt).toContain("If several selected sources cover the same announcement");
    expect(prompt).toContain("do not repeat the event in another Watchlist or Focus Areas subsection");
    expect(prompt).toContain("Do not create separate bullets for outlet variants of the same company announcement.");
    expect(prompt).toContain("If sources are weakly related, keep them in separate bullets");
    expect(prompt).toContain("If multiple sources cover related but distinct facts, write separate bullets or choose the strongest source.");
    expect(prompt).toContain("Do not repeat the same source and same claim across sections.");
    expect(prompt).toContain("Do not repeat the same source in multiple required watchlist or focus-area subsections.");
    expect(prompt).toContain("place it under the most specific matching topic");
    expect(prompt).toContain("Allowed bullet forms:");
    expect(prompt).toContain("<Publication> reported <one concrete claim> [n].");
    expect(prompt).toContain("<Named company, project, or person> launched|published|added|tested|integrated|reported|warned|criticized");
    expect(prompt).toContain("Reddit: <short artifact, project, company, product, or topic label> [n].");
    expect(prompt).toContain("Twitter: <short artifact, project, company, product, or topic label> [n].");
    expect(prompt).toContain("Hacker News: <short artifact, project, company, product, or topic label> [n].");
    expect(prompt).toContain("A source titled \"<title>\" reported|published|claimed <one concrete claim> [n].");
    expect(prompt).toContain("For Reddit sources, start the bullet exactly with \"Reddit:\"");
    expect(prompt).toContain("For Twitter sources, start the bullet exactly with \"Twitter:\"");
    expect(prompt).toContain("For Hacker News sources, start the bullet exactly with \"Hacker News:\"");
    expect(prompt).toContain("attribute only to Reddit, Twitter, or Hacker News; never to usernames or handles");
    expect(prompt).toContain("Never place a username, handle, or \"user\" after \"Reddit:\"");
    expect(prompt).toContain("Do not write social-source bullets in passive voice");
    expect(prompt).toContain("Do not write \"Reddit questioned\", \"Reddit reported\", \"Reddit published\", \"Reddit launched\"");
    expect(prompt).toContain("Do not write \"A Reddit post\", \"Reddit queried\", \"Reddit users\"");
    expect(prompt).toContain("Do not include usernames or handles in the briefing body.");
    expect(prompt).toContain("Do not combine multiple Reddit posts into a plural claim");
    expect(prompt).toContain("Do not write that a Reddit post shows adoption, deployment, market preference, or user preference");
    expect(prompt).toContain("Include selected important-general items when they report named AI companies");
    expect(prompt).toContain("Also prefer items connected to these configured interests");
    expect(prompt).toContain("Do not require an important-general item to match a required watchlist or focus area.");
    expect(prompt).toContain("Required watchlist: agentic payments");
    expect(prompt).toContain("Focus areas: MCP");
    expect(prompt).toContain("3-5 bullets drawn from important-general, strategic-analysis, and high-signal general candidates");
    expect(prompt).toContain("include at least one such item");
    expect(prompt).toContain("AI governance, financing, security, major releases, or widely used technical infrastructure");
    expect(prompt).toContain("Bad: Agentic commerce is identified as a key trend in Southeast Asia.");
    expect(prompt).toContain("Better: The Edge Malaysia reported agentic commerce as a payments trend in Southeast Asia.");
    expect(prompt).toContain("Bad: The report highlights the importance of agentic commerce for financial inclusion.");
    expect(prompt).toContain("Better: The Edge Malaysia reported agentic commerce as a digital-payments model involving human agents in Southeast Asia.");
    expect(prompt).toContain("Bad: AI voice agents are rapidly being adopted globally.");
    expect(prompt).toContain("Better: Reddit: LuMay and Voxentis.ai for real-estate lead qualification");
    expect(prompt).toContain("Bad: Reddit contributors compared AI voice agents based on pricing");
    expect(prompt).toContain("Better: Reddit: LuMay, Voxentis.ai, Vapi, and Retell AI comparison");
    expect(prompt).toContain("Bad: Reddit reported a calculator MCP server providing arithmetic operations.");
    expect(prompt).toContain("Better: Reddit: Calculator MCP server for arithmetic operations.");
    expect(prompt).toContain("Bad: Reddit published a WAHA MCP Server enabling AI assistants to interact with WhatsApp.");
    expect(prompt).toContain("Better: Reddit: WAHA MCP Server for WhatsApp API access.");
    expect(prompt).toContain("Bad: Reddit questioned actual consumer use of agentic commerce protocols.");
    expect(prompt).toContain("Better: Reddit: agentic commerce protocol usage.");
    expect(prompt).toContain("Bad: Reddit launched a tool to simplify MCP server management.");
    expect(prompt).toContain("Better: Reddit: mcp-inator for MCP server management across AI tools.");
    expect(prompt).toContain("Bad: Reddit demonstrated a security issue involving trusted MCP tool outputs.");
    expect(prompt).toContain("Better: Reddit: trusted MCP tool-output security issue.");
    expect(prompt).toContain("Bad: Reddit released an OSS MCP for the OpenAI ChatGPT Ads API.");
    expect(prompt).toContain("Better: Reddit: OSS MCP for the OpenAI ChatGPT Ads API.");
    expect(prompt).toContain("Bad: AI voice agents LuMay and Voxentis.ai are being deployed and assessed");
    expect(prompt).toContain("Bad: Browser-agent reliability remains a key operational challenge.");
    expect(prompt).toContain("Better: Reddit: browser-agent tasks involving tabs");
    expect(prompt).not.toContain("AI agents, payments, commerce, developer tooling, APIs");
    expect(prompt).toContain("\"foundational technology\"");
    expect(prompt).toContain("\"transformative effect\"");
    expect(prompt).toContain("\"could transform\"");
    expect(prompt).toContain("\"poised to\"");
    expect(prompt).toContain("\"reshape\"");
    expect(prompt).toContain("\"enhance accessibility\"");
    expect(prompt).toContain("\"drive adoption\"");
    expect(prompt).toContain("\"indicating\"");
    expect(prompt).not.toContain("Write exactly 3 short paragraphs");
    expect(prompt).not.toContain("Prefer synthesis over listing");
    expect(prompt).not.toContain("Sentence 2 states why it matters");
    expect(prompt).not.toContain("## Top Items");
    expect(prompt).not.toContain("## Required Watchlist");
    expect(prompt).toContain("## Watchlist");
    expect(prompt).toContain("## Focus Areas");
    expect(prompt).toContain("## Other Items");
    expect(prompt).toContain("Do not write \"No meaningful new signal found in this window\" in this section.");
    expect(prompt).toContain("Use only the exact required watchlist subsection headings listed below.");
    expect(prompt).toContain("Use only the exact focus-area subsection headings listed below.");
    expect(prompt).toContain("For each topic, write 0-5 bullets");
    expect(prompt).toContain("If a focus area overlaps a required watchlist topic already covered above");
    expect(prompt).toContain("Include at most 5 focus areas and 1-4 bullets per focus area.");
    expect(prompt).toContain("For every Watchlist subsection, use at most 5 bullets.");
    expect(prompt).toContain("For every Focus Areas subsection, use at most 4 bullets.");
    expect(prompt).toContain("Exact required watchlist subsection headings:");
    expect(prompt).toContain("For every required watchlist topic, include exactly one subsection using the exact heading text above.");
    expect(prompt).toContain("Exact focus-area subsection headings:");
    expect(prompt).toContain("Do not create focus-area subsections with any other heading text.");
    expect(prompt).toContain("Required watchlist source candidates:");
    expect(prompt).toContain("Selection: required watchlist / agentic payments");
    expect(prompt).toContain("Important general source candidates:");
    expect(prompt).toContain("Selection: important general");
    expect(prompt).toContain("Treat social, discussion, and link-wrapper sources as signals");
    expect(prompt).toContain("Do not include URL reference sections");
  });

  it("omits social authors from digest source metadata", () => {
    const sources = [
      {
        id: "1",
        title: "I built a directory-mcp",
        canonicalUrl: "https://reddit.com/r/mcp/comments/example",
        author: "/u/ePaint",
        publishedAt: "2026-06-05T10:00:00Z",
        summary: "Directory-MCP linked to Claude instances.",
        contentText: "",
        score: 0,
        sourceType: "reddit",
        sourceKey: "reddit:r/mcp",
        topicTags: [],
        entities: [],
        rawEntry: {}
      },
      {
        id: "2",
        title: "Article",
        canonicalUrl: "https://example.com/article",
        author: "Reporter",
        publishedAt: "2026-06-05T11:00:00Z",
        summary: "Article summary.",
        contentText: "",
        score: 0,
        sourceType: "article",
        sourceKey: "feedbin:feed:1",
        topicTags: [],
        entities: [],
        rawEntry: {}
      }
    ] as unknown as Parameters<typeof buildDigestPrompt>[0];
    const prompt = buildDigestPrompt(sources, 24);

    expect(prompt).toContain("Source type: reddit");
    expect(prompt).not.toContain("Author: /u/ePaint");
    expect(prompt).not.toContain("/u/ePaint");
    expect(prompt).toContain("Source type: article");
    expect(prompt).toContain("Author: Reporter");
  });

  it("allows important-general AI company items outside configured topics", () => {
    const prompt = buildDigestPrompt([], 24);

    expect(prompt).toContain(
      "Include selected important-general items when they report named AI companies, AI governance, financing, security, major releases, or widely used technical infrastructure."
    );
    expect(prompt).not.toContain("Only include items connected to these configured interests");
  });

  it("labels selected strategic-analysis general sources in the canonical prompt", () => {
    const prompt = buildDigestPrompt([
      {
        id: "1",
        title: "The Substitution Wave in AI",
        canonicalUrl: "https://tomtunguz.com/substitution-wave-ai/",
        author: "Tomasz Tunguz",
        publishedAt: "2026-06-08T10:00:00Z",
        summary: "Analysis of AI pricing, cost, frontier model substitution, and model routing.",
        contentText: "",
        score: 0
      }
    ], 24, {
      sourceContexts: [{ bucket: "important_general", signalLabel: "strategic_analysis" }]
    });

    expect(prompt).toContain("Selection: strategic analysis");
    expect(prompt).toContain("The Substitution Wave in AI");
    expect(prompt).toContain("3-5 bullets drawn from important-general, strategic-analysis, and high-signal general candidates");
    expect(prompt).toContain("high-signal analysis, newsletter, or market-structure article");
  });
});

describe("buildFriendlyDigestPrompt", () => {
  const digest = {
    id: "7",
    periodStart: "2026-06-04T00:00:00.000Z",
    periodEnd: "2026-06-05T00:00:00.000Z",
    createdAt: "2026-06-05T00:10:00.000Z",
    body: "## Watchlist\n- Example Corp reported a model update [1].",
    sources: [
      {
        citation: 1,
        id: "101",
        title: "Example model update",
        url: "https://example.com/model-update",
        author: "Reporter",
        publishedAt: "2026-06-04T10:00:00.000Z",
        summary: "Example Corp reported a model update."
      }
    ]
  };

  it("includes canonical body, source metadata, and direct-link requirements", () => {
    const prompt = buildFriendlyDigestPrompt(
      digest,
      "# Briefing\n\n## Watchlist\n- Example Corp reported a model update [[#Source 1|1]].",
      "plain"
    );

    expect(prompt).toContain("Canonical briefing Markdown:");
    expect(prompt).toContain("Example Corp reported a model update");
    expect(prompt).toContain("Source metadata:");
    expect(prompt).toContain("Title: Example model update");
    expect(prompt).toContain("URL: https://example.com/model-update");
    expect(prompt).toContain("Published: 2026-06-04T10:00:00.000Z");
    expect(prompt).toContain("Summary: Example Corp reported a model update.");
    expect(prompt).toContain("exactly one direct Markdown source link");
    expect(prompt).toContain("[Source title](https://example.com)");
    expect(prompt).toContain("Do not include a source appendix");
    expect(prompt).toContain("Preserve this date range exactly: 2026-06-04T00:00:00.000Z to 2026-06-05T00:00:00.000Z");
    expect(prompt).toContain("Preserve this source count exactly: 1");
    expect(prompt).toContain("Do not preserve Watchlist / Focus Areas / Other Items exactly");
    expect(prompt).toContain("Include a short closing theme summary.");
  });

  it("distinguishes plain and warm style instructions", () => {
    const plain = buildFriendlyDigestPrompt(digest, "# Briefing", "plain");
    const warm = buildFriendlyDigestPrompt(digest, "# Briefing", "warm");

    expect(plain).toContain("Use a concise plain-newsletter tone.");
    expect(plain).toContain("Do not use emoji headings.");
    expect(warm).toContain("Use a slightly warmer newsletter tone.");
    expect(warm).toContain("Emoji headings are allowed");
  });
});
