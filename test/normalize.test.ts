import { describe, expect, it } from "vitest";
import { canonicalizeUrl, normalizeEntry } from "../src/normalize.js";

describe("canonicalizeUrl", () => {
  it("removes fragments, trailing slashes, and tracking parameters", () => {
    expect(canonicalizeUrl("https://EXAMPLE.com/post/?utm_source=rss&keep=yes#section")).toBe(
      "https://example.com/post?keep=yes"
    );
  });
});

describe("normalizeEntry", () => {
  it("converts HTML to useful plain text", () => {
    const normalized = normalizeEntry({
      id: 10,
      feed_id: 20,
      title: " Example ",
      author: null,
      url: "https://example.com/article",
      summary: "fallback",
      content: "<p>Hello <strong>world</strong>.</p><p>Next.</p>",
      published: "2026-06-01T10:00:00.000000Z",
      created_at: "2026-06-01T10:01:00.123456Z"
    });

    expect(normalized.title).toBe("Example");
    expect(normalized.contentText).toBe("Hello world.\n\nNext.");
    expect(normalized.feedbinEntryId).toBe(10);
  });
});
