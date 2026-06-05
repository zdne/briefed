import { describe, expect, it } from "vitest";
import { desiredEnrichmentMode, detectSourceType } from "../src/enrichment-policy.js";

describe("detectSourceType", () => {
  it("detects Reddit community posts", () => {
    expect(detectSourceType({ canonicalUrl: "https://www.reddit.com/r/AI_Agents/comments/abc/post" }))
      .toBe("reddit");
  });

  it("does not treat unrelated URLs as Reddit posts", () => {
    expect(detectSourceType({ canonicalUrl: "https://example.com/r/article" })).toBe("article");
  });

  it("detects Hacker News discussion items", () => {
    expect(detectSourceType({ canonicalUrl: "https://news.ycombinator.com/item?id=123456" }))
      .toBe("hackernews");
  });

  it("does not treat other Hacker News URLs as discussion items", () => {
    expect(detectSourceType({ canonicalUrl: "https://news.ycombinator.com/news" })).toBe("article");
  });
});

describe("desiredEnrichmentMode", () => {
  it("uses embedded-only mode for configured lightweight sources", () => {
    expect(desiredEnrichmentMode("reddit", ["reddit", "hackernews"])).toBe("embedded_only");
    expect(desiredEnrichmentMode("hackernews", ["reddit", "hackernews"])).toBe("embedded_only");
  });

  it("uses full mode for articles and unconfigured lightweight sources", () => {
    expect(desiredEnrichmentMode("article", ["reddit", "hackernews"])).toBe("full");
    expect(desiredEnrichmentMode("reddit", ["hackernews"])).toBe("full");
    expect(desiredEnrichmentMode("hackernews", ["reddit"])).toBe("full");
  });
});
