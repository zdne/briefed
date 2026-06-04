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
});

describe("desiredEnrichmentMode", () => {
  it("applies the configured Reddit mode only to Reddit", () => {
    expect(desiredEnrichmentMode("reddit", "embedded_only")).toBe("embedded_only");
    expect(desiredEnrichmentMode("reddit", "full")).toBe("full");
    expect(desiredEnrichmentMode("article", "embedded_only")).toBe("full");
  });
});
