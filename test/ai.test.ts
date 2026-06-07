import { describe, expect, it } from "vitest";
import { buildDigestPrompt, normalizeEnrichment } from "../src/ai.js";
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
    expect(prompt).toContain("## Top Items");
    expect(prompt).toContain("Write 3-5 bullets");
    expect(prompt).toContain("Each bullet must be exactly one simple sentence");
    expect(prompt).toContain("Do not explain why it matters");
    expect(prompt).toContain("Report only what the cited source says");
    expect(prompt).toContain("Attribute claims to the source");
    expect(prompt).toContain("Use reporting language, not opinion, analyst filler, or judgements");
    expect(prompt).toContain("Do not write trend adjectives");
    expect(prompt).toContain("Prefer concrete verbs: launched, added, reported");
    expect(prompt).toContain("Each bullet must start with a named actor");
    expect(prompt).toContain("Do not start bullets with abstract topics");
    expect(prompt).toContain("Do not infer adoption, trust, market maturity, or ecosystem momentum");
    expect(prompt).toContain("Do not claim momentum, growth, adoption, or market impact");
    expect(prompt).toContain("adoption metrics, named deployments, transaction volume, or customer usage");
    expect(prompt).toContain("Do not infer importance, sustainability, risk, business impact, or technical maturity");
    expect(prompt).toContain("If sources are weakly related, keep them in separate bullets");
    expect(prompt).toContain("Use at most 2 citations per bullet");
    expect(prompt).toContain("For Reddit, say \"A Reddit user reported\"");
    expect(prompt).toContain("Only include items connected to these configured interests");
    expect(prompt).toContain("Required watchlist: agentic payments");
    expect(prompt).toContain("Focus areas: MCP");
    expect(prompt).toContain("strong recurring theme across multiple supplied sources");
    expect(prompt).toContain("Do not include unrelated general news");
    expect(prompt).toContain("0-3 bullets for source-backed items");
    expect(prompt).toContain("Prioritize selected important-general candidates");
    expect(prompt).toContain("standards/protocol moves");
    expect(prompt).toContain("Bad: Agentic commerce is identified as a key trend in Southeast Asia.");
    expect(prompt).toContain("Better: The Edge Malaysia reported agentic commerce as a payments trend in Southeast Asia.");
    expect(prompt).toContain("Bad: The report highlights the importance of agentic commerce for financial inclusion.");
    expect(prompt).toContain("Better: The Edge Malaysia reported that agentic commerce could support digital payments access in Southeast Asia.");
    expect(prompt).toContain("Bad: AI voice agents are rapidly being adopted globally.");
    expect(prompt).toContain("Better: A Reddit user claimed LuMay and Voxentis.ai are being tested");
    expect(prompt).toContain("Bad: Browser-agent reliability remains a key operational challenge.");
    expect(prompt).toContain("Better: A Reddit user reported token overruns and crashes");
    expect(prompt).not.toContain("AI agents, payments, commerce, developer tooling, APIs");
    expect(prompt).toContain("\"foundational technology\"");
    expect(prompt).toContain("\"transformative effect\"");
    expect(prompt).not.toContain("Write exactly 3 short paragraphs");
    expect(prompt).not.toContain("Prefer synthesis over listing");
    expect(prompt).not.toContain("Sentence 2 states why it matters");
    expect(prompt).toContain("## Required Watchlist");
    expect(prompt).toContain("## Highlighted Focus Areas");
    expect(prompt).toContain("## Other Items");
    expect(prompt).toContain("Required watchlist source candidates:");
    expect(prompt).toContain("Selection: required watchlist / agentic payments");
    expect(prompt).toContain("Important general source candidates:");
    expect(prompt).toContain("Selection: important general");
    expect(prompt).toContain("Treat social, discussion, and link-wrapper sources as signals");
    expect(prompt).toContain("Do not include URL reference sections");
  });
});
