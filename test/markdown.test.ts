import { describe, expect, it } from "vitest";
import {
  linkCitations,
  renderDigestMarkdown,
  renderQueryMarkdown,
  sanitizeMarkdownText
} from "../src/markdown.js";

describe("linkCitations", () => {
  it("links bracketed and parenthetical citations without modifying existing or unknown links", () => {
    expect(linkCitations(
      "Known [1], parenthetical (1), group (1, 3), linked [1](https://example.com), unknown (2).",
      [
        { citation: 1, title: "Source", url: null },
        { citation: 3, title: "Another", url: null }
      ]
    )).toBe(
      "Known [[#Source 1|1]], parenthetical [[#Source 1|1]], group " +
      "[[#Source 1|1]], [[#Source 3|3]], linked [1](https://example.com), unknown (2)."
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
    expect(markdown).toContain("type: pnd-query");
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
      body: "Digest body [1].",
      sources: [{ citation: 1, title: "Source", url: "https://example.com" }]
    }, new Date("2026-06-04T10:30:00.000Z"));

    expect(markdown).toContain("type: pnd-digest");
    expect(markdown).toContain("source_count: 1");
    expect(markdown).toContain("# Daily Digest");
    expect(markdown).toContain("Digest body [[#Source 1|1]].");
    expect(markdown).toContain("### Source 1");
    expect(markdown).toContain("[Source](https://example.com)");
    expect(markdown).not.toContain("Back to writeup");
  });

  it("sanitizes source summaries so fenced code cannot consume later sources", () => {
    const markdown = renderDigestMarkdown({
      id: "4",
      periodStart: "2026-06-04T10:00:00.000Z",
      periodEnd: "2026-06-05T10:00:00.000Z",
      body: "Digest body [1].",
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
});

describe("sanitizeMarkdownText", () => {
  it("removes multiline and fenced-markdown hazards from source text", () => {
    expect(sanitizeMarkdownText("a\n\n```code\nb")).toBe("a `code b");
  });
});
