import { describe, expect, it } from "vitest";
import {
  appendSectionSourceLinks,
  cleanDigestBody,
  linkCitations,
  limitDigestCitations,
  renderDigestMarkdown,
  renderQueryMarkdown,
  removeShortUrlReferenceSection,
  sanitizeMarkdownText
} from "../src/markdown.js";

describe("linkCitations", () => {
  it("links bracketed and parenthetical citations without modifying existing or unknown links", () => {
    expect(linkCitations(
      "Known [1], bracket group [1, 3], parenthetical (1), group (1, 3), " +
      "linked [1](https://example.com), unknown [1, 2], unknown (2).",
      [
        { citation: 1, title: "Source", url: null },
        { citation: 3, title: "Another", url: null }
      ]
    )).toBe(
      "Known [[#Source 1|1]], bracket group [[#Source 1|1]], [[#Source 3|3]], " +
      "parenthetical [[#Source 1|1]], group [[#Source 1|1]], [[#Source 3|3]], " +
      "linked [1](https://example.com), unknown [1, 2], unknown (2)."
    );
  });

  it("adds spaces between adjacent citation links", () => {
    expect(linkCitations("Clustered [1][32][148].", [
      { citation: 1, title: "One", url: null },
      { citation: 32, title: "Thirty Two", url: null },
      { citation: 148, title: "One Forty Eight", url: null }
    ])).toBe(
      "Clustered [[#Source 1|1]] [[#Source 32|32]] [[#Source 148|148]]."
    );
  });
});

describe("renderQueryMarkdown", () => {
  it("renders a readable answer with linked source metadata", () => {
    const markdown = renderQueryMarkdown("What changed?", {
      answer: "A useful answer [1].",
      sources: [{
        citation: 1,
        title: "Source",
        url: "https://example.com",
        author: "Author",
        publishedAt: "2026-06-04T10:00:00Z",
        summary: "Source summary.",
        score: 0.87654
      }]
    });

    expect(markdown).toContain("**Question:** What changed?");
    expect(markdown).toContain("type: brief-query");
    expect(markdown).toContain('question: "What changed?"');
    expect(markdown).toContain("A useful answer [[#Source 1|1]].");
    expect(markdown).toContain("### Source 1");
    expect(markdown).toContain("[Source](https://example.com)");
    expect(markdown).toContain("Similarity: 0.877");
    expect(markdown).toContain("Source summary.");
    expect(markdown).not.toContain("Back to writeup");
  });
});

describe("renderDigestMarkdown", () => {
  it("renders Obsidian-compatible frontmatter and sources", () => {
    const markdown = renderDigestMarkdown({
      id: "3",
      periodStart: "2026-06-03T10:00:00.000Z",
      periodEnd: "2026-06-04T10:00:00.000Z",
      body: "## Executive Summary\n\nDigest body [1].\n\n# Short URLs for reference\n\n[1] https://example.com",
      sources: [{ citation: 1, title: "Source", url: "https://example.com" }]
    }, new Date("2026-06-04T10:30:00.000Z"));

    expect(markdown).toContain("type: briefing");
    expect(markdown).toContain("source_count: 1");
    expect(markdown).toContain("# Briefing");
    expect(markdown).toContain("Digest body [[#Source 1|1]].");
    expect(markdown).not.toContain("Sources:\n- [[#Source 1|[1]]] [Source](https://example.com)");
    expect(markdown).not.toContain("Short URLs for reference");
    expect(markdown).toContain("### Source 1");
    expect(markdown).toContain("[Source](https://example.com)");
    expect(markdown).not.toContain("Back to writeup");
  });

  it("sanitizes source summaries so fenced code cannot consume later sources", () => {
    const markdown = renderDigestMarkdown({
      id: "4",
      periodStart: "2026-06-04T10:00:00.000Z",
      periodEnd: "2026-06-05T10:00:00.000Z",
      body: "Digest body [1] [2].",
      sources: [
        {
          citation: 1,
          title: "Unpopular opinion",
          url: "https://example.com",
          summary: "hard-coded ``` _CIRCUIT_BREAKER_THRESHOLD = 3"
        },
        { citation: 2, title: "Next source", url: "https://example.com/2" }
      ]
    });

    expect(markdown).not.toContain("```");
    expect(markdown).toContain("hard-coded ` _CIRCUIT_BREAKER_THRESHOLD = 3");
    expect(markdown).toContain("### Source 2");
  });

  it("renders only sources cited in the final briefing body", () => {
    const markdown = renderDigestMarkdown({
      id: "5",
      periodStart: "2026-06-04T10:00:00.000Z",
      periodEnd: "2026-06-05T10:00:00.000Z",
      body: "## Top Items\n\n- Reported item [2].",
      sources: [
        { citation: 1, title: "Uncited", url: "https://example.com/1" },
        { citation: 2, title: "Cited", url: "https://example.com/2" },
        { citation: 3, title: "Also uncited", url: "https://example.com/3" }
      ]
    });

    expect(markdown).toContain("source_count: 1");
    expect(markdown).toContain("- Reported item [[#Source 2|2]].");
    expect(markdown).toContain("### Source 2");
    expect(markdown).toContain("[Cited](https://example.com/2)");
    expect(markdown).not.toContain("### Source 1");
    expect(markdown).not.toContain("### Source 3");
  });

  it("renders candidate count separately from cited source count", () => {
    const markdown = renderDigestMarkdown({
      id: "5",
      periodStart: "2026-06-04T10:00:00.000Z",
      periodEnd: "2026-06-05T10:00:00.000Z",
      candidateCount: 67,
      body: "## Top Items\n\n- Reported item [2].",
      sources: [
        { citation: 1, title: "Uncited", url: "https://example.com/1" },
        { citation: 2, title: "Cited", url: "https://example.com/2" }
      ]
    });

    expect(markdown).toContain("candidate_count: 67");
    expect(markdown).toContain("source_count: 1");
  });

  it("collapses social digest bullets to source-title labels", () => {
    const markdown = renderDigestMarkdown({
      id: "6",
      periodStart: "2026-06-04T10:00:00.000Z",
      periodEnd: "2026-06-05T10:00:00.000Z",
      body: [
        "## Highlighted Focus Areas",
        "",
        "### MCP",
        "- Reddit: An MCP was created to manage and read skills efficiently [1].",
        "- Reddit: A tool named mcp-inator was published to simplify managing MCP servers [2].",
        "- Reddit: An OSS MCP for the OpenAI ChatGPT Ads API was released [3].",
        "- Reddit contributors shared multiple MCP server implementations [4]."
      ].join("\n"),
      sources: [
        {
          citation: 1,
          title: "a small MCP to manage and read skills efficiently",
          url: "https://www.reddit.com/r/mcp/comments/1"
        },
        {
          citation: 2,
          title: "Tool to manage mcp servers across AI tools",
          url: "https://www.reddit.com/r/mcp/comments/2"
        },
        {
          citation: 3,
          title: "OSS MCP for the OpenAI (ChatGPT) Ads API",
          url: "https://www.reddit.com/r/mcp/comments/3"
        },
        {
          citation: 4,
          title: "How I made a Hetzner MCP that is cost-safe, SSRF-safe, and token-efficient",
          url: "https://www.reddit.com/r/mcp/comments/4"
        }
      ]
    });

    expect(markdown).toContain("- Reddit: small MCP to manage and read skills efficiently [[#Source 1|1]].");
    expect(markdown).toContain("- Reddit: Tool to manage mcp servers across AI tools [[#Source 2|2]].");
    expect(markdown).toContain("- Reddit: OSS MCP for the OpenAI (ChatGPT) Ads API [[#Source 3|3]].");
    expect(markdown).toContain("- Reddit: How I made a Hetzner MCP that is cost-safe, SSRF-safe, and token-efficient [[#Source 4|4]].");
    expect(markdown).not.toContain("An MCP was created");
    expect(markdown).not.toContain("was published");
    expect(markdown).not.toContain("was released");
    expect(markdown).not.toContain("Reddit contributors shared");
  });

  it("renames digest sections and capitalizes digest subheadings", () => {
    const markdown = renderDigestMarkdown({
      id: "7",
      periodStart: "2026-06-04T10:00:00.000Z",
      periodEnd: "2026-06-05T10:00:00.000Z",
      body: [
        "## Required Watchlist",
        "",
        "### agentic payments",
        "- Item [1].",
        "",
        "### agentic B2B",
        "No meaningful new signal found in this window.",
        "",
        "### ai procurement",
        "No meaningful new signal found in this window.",
        "",
        "## Highlighted Focus Areas",
        "",
        "### agentic marketplace",
        "- Focus item [1].",
        "",
        "### agent frameworks",
        "- Framework item [1]."
      ].join("\n"),
      sources: [{ citation: 1, title: "Source", url: "https://example.com" }]
    });

    expect(markdown).toContain("## Watchlist");
    expect(markdown).not.toContain("## Required Watchlist");
    expect(markdown).toContain("## Focus Areas");
    expect(markdown).not.toContain("## Highlighted Focus Areas");
    expect(markdown).toContain("### Agentic Payments");
    expect(markdown).toContain("### Agentic B2B");
    expect(markdown).toContain("### AI Procurement");
    expect(markdown).toContain("### Agentic Marketplace");
    expect(markdown).toContain("### Agent Frameworks");
    expect(markdown).not.toContain("### Ai Procurement");
    expect(markdown).not.toContain("### agent frameworks");
  });

  it("drops an empty Other Items section and trims model-emitted trailing spaces", () => {
    const markdown = renderDigestMarkdown({
      id: "5",
      periodStart: "2026-06-04T10:00:00.000Z",
      periodEnd: "2026-06-05T10:00:00.000Z",
      body: "## Top Items\n- Reported item [1].  \n\n## Other Items\nNo meaningful new signal found in this window.",
      sources: [{ citation: 1, title: "Source", url: "https://example.com" }]
    });

    expect(markdown).toContain("- Reported item [[#Source 1|1]].\n");
    expect(markdown).not.toContain("  \n");
    expect(markdown).not.toContain("## Other Items");
    expect(markdown).not.toContain("No meaningful new signal found in this window");
  });

  it("drops empty focus-area subsections while preserving non-empty focus areas", () => {
    const markdown = renderDigestMarkdown({
      id: "6",
      periodStart: "2026-06-04T10:00:00.000Z",
      periodEnd: "2026-06-05T10:00:00.000Z",
      body: [
        "## Focus Areas",
        "",
        "### MCP",
        "- MCP item [1].",
        "",
        "### agentic marketplace",
        "No meaningful new signal found in this window.",
        "",
        "### agentic contracting",
        ""
      ].join("\n"),
      sources: [{ citation: 1, title: "Source", url: "https://example.com" }]
    });

    expect(markdown).toContain("## Focus Areas");
    expect(markdown).toContain("### MCP");
    expect(markdown).toContain("- MCP item [[#Source 1|1]].");
    expect(markdown).not.toContain("### agentic marketplace");
    expect(markdown).not.toContain("### agentic contracting");
  });
});

describe("appendSectionSourceLinks", () => {
  it("leaves digest sections unchanged", () => {
    expect(appendSectionSourceLinks(
      "Intro without section.\n\n" +
      "## Executive Summary\n\nA paragraph [[#Source 2|2]] [[#Source 1|1]].\n\n" +
      "## Required Watchlist\n\nRequired paragraph [[#Source 1|1]].\n\n" +
      "## Other Notable Signals\n\nAnother paragraph [[#Source 3|3]].\n\n" +
      "## Other Items\n\nAnother item [[#Source 2|2]].\n\n" +
      "## Empty\n\nNo citations.",
      [
        { citation: 1, title: "One", url: "https://example.com/1" },
        { citation: 2, title: "Two", url: "https://example.com/2" },
        { citation: 3, title: "Three", url: null }
      ]
    )).toBe(
      "Intro without section.\n\n" +
      "## Executive Summary\n\nA paragraph [[#Source 2|2]] [[#Source 1|1]].\n\n" +
      "## Required Watchlist\n\nRequired paragraph [[#Source 1|1]].\n\n" +
      "## Other Notable Signals\n\nAnother paragraph [[#Source 3|3]].\n\n" +
      "## Other Items\n\nAnother item [[#Source 2|2]].\n\n" +
      "## Empty\n\nNo citations."
    );
  });
});

describe("limitDigestCitations", () => {
  it("caps executive summary paragraphs at 3 citations and bullets at 1 citation", () => {
    expect(limitDigestCitations(
      "## Executive Summary\n\n" +
      "Paragraph [[#Source 1|1]] [[#Source 2|2]] [[#Source 3|3]] [[#Source 4|4]].\n\n" +
      "## Top Items\n\n" +
      "- Item [[#Source 1|1]] [[#Source 2|2]] [[#Source 3|3]].\n\n" +
      "## Required Watchlist\n\n" +
      "- Bullet [[#Source 1|1]] [[#Source 2|2]] [[#Source 3|3]].\n" +
      "Plain paragraph [[#Source 1|1]] [[#Source 2|2]] [[#Source 3|3]]."
    )).toBe(
      "## Executive Summary\n\n" +
      "Paragraph [[#Source 1|1]] [[#Source 2|2]] [[#Source 3|3]].\n\n" +
      "## Top Items\n\n" +
      "- Item [[#Source 1|1]].\n\n" +
      "## Required Watchlist\n\n" +
      "- Bullet [[#Source 1|1]].\n" +
      "Plain paragraph [[#Source 1|1]] [[#Source 2|2]] [[#Source 3|3]]."
    );
  });
});

describe("removeShortUrlReferenceSection", () => {
  it("removes model-generated short URL reference sections", () => {
    expect(removeShortUrlReferenceSection(
      "## Executive Summary\n\nDigest.\n\n# Short URLs for reference\n\n[1] https://example.com"
    )).toBe("## Executive Summary\n\nDigest.");
  });
});

describe("cleanDigestBody", () => {
  it("removes short URL sections, empty optional sections, and trailing line whitespace", () => {
    expect(cleanDigestBody(
      "## Top Items  \n\n- Item.  \n\n## Other Items\nNo meaningful new signal found in this window.\n\n# Short URLs for reference\n\n[1] https://example.com"
    )).toBe("## Top Items\n\n- Item.");
  });

  it("removes a highlighted focus section when every focus area is empty", () => {
    expect(cleanDigestBody(
      "## Top Items\n\n- Item.\n\n## Highlighted Focus Areas\n\n### MCP\nNo meaningful new signal found in this window.\n\n### API\n"
    )).toBe("## Top Items\n\n- Item.");
  });
});

describe("sanitizeMarkdownText", () => {
  it("removes multiline and fenced-markdown hazards from source text", () => {
    expect(sanitizeMarkdownText("a\n\n```code\nb")).toBe("a `code b");
  });
});
