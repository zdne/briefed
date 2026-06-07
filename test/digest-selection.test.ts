import { describe, expect, it } from "vitest";
import { selectDigestSources } from "../src/digest-selection.js";
import type { DigestCandidate } from "../src/types.js";

const defaults = {
  maxEntries: 6,
  requiredTopicMinEntries: 1,
  requiredTopicMaxEntries: 2,
  focusAreaMinEntries: 1,
  focusAreaMaxEntries: 2,
  importantGeneralMaxEntries: 2,
  generalMaxEntries: 6
};

describe("selectDigestSources", () => {
  it("selects required topic matches before general recent candidates", () => {
    const recent = [candidate("general-1"), candidate("general-2")];
    const required = [{ topic: "agentic payments", matches: [candidate("required-1")] }];

    const result = selectDigestSources(recent, required, [], defaults);

    expect(result.sources.map((source) => source.id)).toEqual(["required-1", "general-1", "general-2"]);
    expect(result.requiredCount).toBe(1);
    expect(result.generalCount).toBe(2);
  });

  it("selects focus area matches after required topic matches", () => {
    const result = selectDigestSources(
      [candidate("general-1")],
      [{ topic: "payments", matches: [candidate("required-1")] }],
      [{ topic: "observability", matches: [candidate("focus-1")] }],
      defaults
    );

    expect(result.sources.map((source) => source.id)).toEqual(["required-1", "focus-1", "general-1"]);
    expect(result.selectedSources.map((selection) => selection.bucket)).toEqual(["required", "focus", "general"]);
    expect(result.selectedSources.map((selection) => selection.topic)).toEqual(["payments", "observability", undefined]);
    expect(result.focusCount).toBe(1);
  });

  it("deduplicates candidates that match more than one bucket", () => {
    const shared = candidate("shared");
    const result = selectDigestSources(
      [shared, candidate("general-1")],
      [{ topic: "payments", matches: [shared] }],
      [{ topic: "commerce", matches: [shared, candidate("focus-1")] }],
      defaults
    );

    expect(result.sources.map((source) => source.id)).toEqual(["shared", "focus-1", "general-1"]);
  });

  it("respects the digest max entry cap", () => {
    const result = selectDigestSources(
      [candidate("general-1"), candidate("general-2"), candidate("general-3")],
      [{ topic: "payments", matches: [candidate("required-1"), candidate("required-2")] }],
      [{ topic: "commerce", matches: [candidate("focus-1"), candidate("focus-2")] }],
      { ...defaults, maxEntries: 3 }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["required-1", "required-2", "focus-1"]);
  });

  it("adds exact title and topic-tag matches ahead of vector matches", () => {
    const exactTitle = candidate("exact-title", {
      title: "Agentic payments rollout"
    });
    const exactTag = candidate("exact-tag", {
      topicTags: ["agentic payments"]
    });
    const vector = candidate("vector");

    const result = selectDigestSources(
      [exactTitle, exactTag],
      [{ topic: "agentic payments", matches: [vector] }],
      [],
      { ...defaults, requiredTopicMaxEntries: 3 }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["exact-title", "exact-tag", "vector"]);
  });

  it("selects important general candidates before newest general fill", () => {
    const result = selectDigestSources(
      [
        candidate("general-1"),
        candidate("google-fido", {
          title: "Google donates Agent Payments Protocol to FIDO Alliance",
          summary: "Google donated a payment protocol to a standards alliance."
        }),
        candidate("general-2")
      ],
      [],
      [],
      defaults
    );

    expect(result.sources.map((source) => source.id)).toEqual(["google-fido", "general-1", "general-2"]);
    expect(result.selectedSources.map((selection) => selection.bucket)).toEqual([
      "important_general",
      "general",
      "general"
    ]);
    expect(result.importantGeneralCount).toBe(1);
  });

  it("limits selected entries by source type", () => {
    const result = selectDigestSources(
      [
        candidate("reddit-1", { sourceType: "reddit" }),
        candidate("reddit-2", { sourceType: "reddit" }),
        candidate("reddit-3", { sourceType: "reddit" }),
        candidate("article-1", { sourceType: "article" }),
        candidate("article-2", { sourceType: "article" })
      ],
      [],
      [],
      {
        ...defaults,
        maxEntries: 5,
        sourceTypeMaxEntries: { reddit: 2 }
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual([
      "reddit-1",
      "reddit-2",
      "article-1",
      "article-2"
    ]);
  });

  it("limits selected entries by author and source key", () => {
    const result = selectDigestSources(
      [
        candidate("author-1", { author: "Same Author", sourceKey: "feed:1" }),
        candidate("author-2", { author: "same author", sourceKey: "feed:2" }),
        candidate("source-1", { author: "Other 1", sourceKey: "feed:1" }),
        candidate("source-2", { author: "Other 2", sourceKey: "feed:1" }),
        candidate("kept", { author: "Other 3", sourceKey: "feed:3" })
      ],
      [],
      [],
      {
        ...defaults,
        maxEntries: 5,
        maxEntriesPerAuthor: 1,
        maxEntriesPerSourceKey: 2
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["author-1", "source-1", "kept"]);
  });
});

function candidate(id: string, overrides: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    id,
    title: id,
    canonicalUrl: `https://example.com/${id}`,
    author: null,
    publishedAt: null,
    summary: null,
    contentText: "",
    score: 0,
    sourceType: "article",
    sourceKey: "feedbin:feed:1",
    topicTags: [],
    entities: [],
    rawEntry: {},
    ...overrides
  };
}
