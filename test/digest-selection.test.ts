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
    const required = [{ topic: "agentic payments", matches: [candidate("required-1", {
      title: "Agentic payments update"
    })] }];

    const result = selectDigestSources(recent, required, [], defaults);

    expect(result.sources.map((source) => source.id)).toEqual(["required-1", "general-1", "general-2"]);
    expect(result.requiredCount).toBe(1);
    expect(result.generalCount).toBe(2);
  });

  it("selects focus area matches after required topic matches", () => {
    const result = selectDigestSources(
      [candidate("general-1")],
      [{ topic: "payments", matches: [candidate("required-1", { title: "Payments update" })] }],
      [{ topic: "observability", matches: [candidate("focus-1", { title: "Observability update" })] }],
      defaults
    );

    expect(result.sources.map((source) => source.id)).toEqual(["required-1", "focus-1", "general-1"]);
    expect(result.selectedSources.map((selection) => selection.bucket)).toEqual(["required", "focus", "general"]);
    expect(result.selectedSources.map((selection) => selection.topic)).toEqual(["payments", "observability", undefined]);
    expect(result.focusCount).toBe(1);
  });

  it("filters topic vector matches below configured score thresholds", () => {
    const result = selectDigestSources(
      [],
      [{ topic: "agentic payments", matches: [
        candidate("weak-required", { score: 0.24 }),
        candidate("strong-required", { score: 0.25, title: "Agentic payments update" })
      ] }],
      [{ topic: "observability", matches: [
        candidate("weak-focus", { score: 0.34 }),
        candidate("strong-focus", { score: 0.35, title: "Observability update" })
      ] }],
      {
        ...defaults,
        requiredTopicMaxEntries: 3,
        focusAreaMaxEntries: 3,
        requiredTopicMinScore: 0.25,
        focusAreaMinScore: 0.35
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["strong-required", "strong-focus"]);
  });

  it("filters topic vector matches without a lexical topic anchor", () => {
    const result = selectDigestSources(
      [],
      [{ topic: "agentic payments", matches: [
        candidate("browser-agent", {
          score: 0.9,
          title: "Browser agent token costs"
        }),
        candidate("payments", {
          score: 0.4,
          title: "AI agency stablecoin payments tooling"
        })
      ] }],
      [],
      {
        ...defaults,
        requiredTopicMaxEntries: 3,
        requiredTopicMinScore: 0.25
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["payments"]);
  });

  it("requires agentic topic matches to include an agentic concept and topic anchor", () => {
    const result = selectDigestSources(
      [],
      [{ topic: "agentic commerce", matches: [
        candidate("generic-commerce", {
          score: 0.9,
          title: "Q-commerce retail sales update"
        }),
        candidate("agentic-commerce", {
          score: 0.4,
          title: "AI agents for commerce checkout"
        }),
        candidate("exact-agentic-commerce", {
          score: 0.3,
          title: "Agentic commerce payments rollout"
        })
      ] }],
      [],
      {
        ...defaults,
        requiredTopicMaxEntries: 3,
        requiredTopicMinScore: 0.25
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["agentic-commerce", "exact-agentic-commerce"]);
  });

  it("deduplicates candidates that match more than one bucket", () => {
    const shared = candidate("shared");
    const result = selectDigestSources(
      [shared, candidate("general-1")],
      [{ topic: "payments", matches: [{ ...shared, title: "Payments update" }] }],
      [{ topic: "commerce", matches: [
        { ...shared, title: "Commerce update" },
        candidate("focus-1", { title: "Commerce update" })
      ] }],
      defaults
    );

    expect(result.sources.map((source) => source.id)).toEqual(["shared", "focus-1", "general-1"]);
  });

  it("skips focus area buckets that overlap required watchlist topics", () => {
    const result = selectDigestSources(
      [],
      [{ topic: "MCP Discovery", matches: [
        candidate("required-mcp", { title: "MCP discovery security update" })
      ] }],
      [{ topic: "MCP", matches: [
        candidate("focus-mcp", { title: "MCP focus security update" })
      ] }],
      defaults
    );

    expect(result.sources.map((source) => source.id)).toEqual(["required-mcp"]);
    expect(result.focusCount).toBe(0);
    expect(result.selectedSources.map((selection) => selection.bucket)).toEqual(["required"]);
  });

  it("skips broad agentic focus buckets when required agentic topics already cover them", () => {
    const result = selectDigestSources(
      [],
      [{ topic: "Agentic Payments", matches: [
        candidate("required-agentic", { title: "Agentic payments update" })
      ] }],
      [{ topic: "Agentic", matches: [
        candidate("focus-agentic", { title: "Agentic workflow update" })
      ] }],
      defaults
    );

    expect(result.sources.map((source) => source.id)).toEqual(["required-agentic"]);
    expect(result.focusCount).toBe(0);
  });

  it("deduplicates different candidates with the same normalized title", () => {
    const result = selectDigestSources(
      [
        candidate("first", {
          title: "Trends: Agentic commerce next inflection point in digital payments - The Edge Malaysia",
          canonicalUrl: "https://news.google.com/rss/articles/one"
        }),
        candidate("duplicate", {
          title: "Trends: Agentic commerce next inflection point in digital payments - KLSE Screener",
          canonicalUrl: "https://news.google.com/rss/articles/two"
        }),
        candidate("kept", {
          title: "Other item"
        })
      ],
      [],
      [],
      defaults
    );

    expect(result.sources.map((source) => source.id)).toEqual(["first", "kept"]);
  });

  it("does not select duplicate-title topic matches under multiple required topics", () => {
    const payments = candidate("payments-copy", {
      title: "Trends: Agentic commerce next inflection point in digital payments - The Edge Malaysia"
    });
    const commerce = candidate("commerce-copy", {
      title: "Trends: Agentic commerce next inflection point in digital payments - KLSE Screener"
    });

    const result = selectDigestSources(
      [],
      [
        { topic: "agentic payments", matches: [payments] },
        { topic: "agentic commerce", matches: [commerce] }
      ],
      [],
      {
        ...defaults,
        requiredTopicMaxEntries: 2
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["payments-copy"]);
    expect(result.selectedSources.map((selection) => selection.topic)).toEqual(["agentic payments"]);
  });

  it("caps outlet variants covering the same Visa and OpenAI announcement", () => {
    const result = selectDigestSources(
      [
        visaOpenAi("official", {
          canonicalUrl: "https://usa.visa.com/about-visa/newsroom/press-releases/openai-agentic-commerce.html",
          summary: "Visa announced work with OpenAI on agentic commerce checkout and payments for ChatGPT users."
        }),
        visaOpenAi("wrapper-1", {
          title: "Visa and OpenAI team on agentic commerce payments - Outlet One",
          canonicalUrl: "https://news.google.com/rss/articles/one",
          summary: "Visa and OpenAI announced agentic commerce payments."
        }),
        visaOpenAi("wrapper-2", {
          title: "OpenAI taps Visa for agentic checkout - Outlet Two",
          canonicalUrl: "https://news.google.com/rss/articles/two",
          summary: "OpenAI and Visa announced agentic checkout."
        }),
        visaOpenAi("wire", {
          title: "Visa backs OpenAI shopping checkout push - Outlet Three",
          canonicalUrl: "https://examplewire.com/visa-openai-shopping",
          summary: "Visa and OpenAI announced shopping checkout and payments."
        }),
        visaOpenAi("syndicated", {
          title: "OpenAI Visa payment partnership starts agentic commerce pilot - Outlet Four",
          canonicalUrl: "https://syndicated.example/visa-openai",
          summary: "OpenAI and Visa announced a payment partnership for agentic commerce."
        }),
        candidate("mastercard-ripple", {
          title: "Mastercard and Ripple test stablecoin settlement",
          summary: "Mastercard and Ripple reported a stablecoin settlement test.",
          entities: [{ name: "Mastercard", type: "company" }, { name: "Ripple", type: "company" }]
        }),
        candidate("trustap", {
          title: "Trustap launches escrow checkout for marketplaces",
          summary: "Trustap launched escrow checkout tooling for marketplaces.",
          entities: [{ name: "Trustap", type: "company" }]
        }),
        candidate("fastly-skyfire", {
          title: "Fastly and Skyfire integrate agent payments",
          summary: "Fastly and Skyfire integrated agent payment infrastructure.",
          entities: [{ name: "Fastly", type: "company" }, { name: "Skyfire", type: "company" }]
        })
      ],
      [],
      [],
      { ...defaults, maxEntries: 8, importantGeneralMaxEntries: 0, generalMaxEntries: 8 }
    );

    const ids = result.sources.map((source) => source.id);
    expect(ids.filter((id) => id.startsWith("visa-openai-"))).toHaveLength(1);
    expect(ids).toContain("visa-openai-official");
    expect(ids).toEqual(expect.arrayContaining(["mastercard-ripple", "trustap", "fastly-skyfire"]));
  });

  it("selects a cross-topic event once under the first matching required topic", () => {
    const shared = visaOpenAi("payments-commerce", {
      title: "Visa and OpenAI announce agentic commerce checkout payments",
      summary: "Visa and OpenAI announced agentic commerce checkout payments."
    });

    const result = selectDigestSources(
      [shared],
      [
        { topic: "agentic payments", matches: [shared] },
        { topic: "agentic commerce", matches: [shared] }
      ],
      [],
      { ...defaults, requiredTopicMaxEntries: 2 }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["visa-openai-payments-commerce"]);
    expect(result.selectedSources.map((selection) => selection.topic)).toEqual(["agentic payments"]);
  });

  it("allows a second same-event source only when it adds a distinct material fact", () => {
    const result = selectDigestSources(
      [
        visaOpenAi("checkout", {
          summary: "Visa and OpenAI announced agentic commerce checkout for ChatGPT shopping."
        }),
        visaOpenAi("stablecoin", {
          title: "Visa and OpenAI add stablecoin tokenization to agent payments",
          summary: "Visa and OpenAI announced stablecoin tokenization for agent payments."
        }),
        visaOpenAi("thin-copy", {
          title: "OpenAI and Visa announce agentic commerce - Outlet",
          summary: "OpenAI and Visa announced agentic commerce payments."
        })
      ],
      [],
      [],
      { ...defaults, maxEntries: 3, importantGeneralMaxEntries: 0, generalMaxEntries: 3 }
    );

    expect(result.sources.map((source) => source.id)).toEqual([
      "visa-openai-checkout",
      "visa-openai-stablecoin"
    ]);
  });

  it("prefers sourceful direct coverage over thin Google News wrappers", () => {
    const result = selectDigestSources(
      [
        visaOpenAi("wrapper", {
          canonicalUrl: "https://news.google.com/rss/articles/visa-openai",
          summary: "Visa and OpenAI announced payments."
        }),
        visaOpenAi("official", {
          canonicalUrl: "https://openai.com/index/agentic-commerce-visa/",
          summary: "OpenAI announced work with Visa on agentic commerce checkout, payments, and buying through ChatGPT."
        })
      ],
      [{ topic: "agentic commerce", matches: [] }],
      [],
      defaults
    );

    expect(result.sources[0]?.id).toBe("visa-openai-official");
  });

  it("prefers a fuller wrapper summary when all same-event sources are wrappers", () => {
    const result = selectDigestSources(
      [
        visaOpenAi("thin-wrapper", {
          canonicalUrl: "https://news.google.com/rss/articles/thin",
          summary: "Visa and OpenAI announced payments."
        }),
        visaOpenAi("full-wrapper", {
          canonicalUrl: "https://news.google.com/rss/articles/full",
          summary: "Visa and OpenAI announced agentic commerce checkout, payment credentials, shopping flows, and merchant payment handling for ChatGPT users."
        })
      ],
      [{ topic: "agentic commerce", matches: [] }],
      [],
      defaults
    );

    expect(result.sources[0]?.id).toBe("visa-openai-full-wrapper");
  });

  it("respects the digest max entry cap", () => {
    const result = selectDigestSources(
      [candidate("general-1"), candidate("general-2"), candidate("general-3")],
      [{ topic: "payments", matches: [
        candidate("required-1", { title: "Payments update" }),
        candidate("required-2", { title: "Payments launch" })
      ] }],
      [{ topic: "commerce", matches: [
        candidate("focus-1", { title: "Commerce update" }),
        candidate("focus-2", { title: "Commerce launch" })
      ] }],
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
    const vector = candidate("vector", {
      title: "AI payments infrastructure"
    });

    const result = selectDigestSources(
      [exactTitle, exactTag],
      [{ topic: "agentic payments", matches: [vector] }],
      [],
      { ...defaults, requiredTopicMaxEntries: 3 }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["exact-title", "exact-tag", "vector"]);
  });

  it("does not treat content body substring matches as exact topic matches", () => {
    const result = selectDigestSources(
      [
        candidate("body-only", {
          contentText: "This body mentions agentic payments, but the source summary is unrelated."
        }),
        candidate("title-match", {
          title: "Agentic payments rollout"
        })
      ],
      [{ topic: "agentic payments", matches: [] }],
      [],
      defaults
    );

    expect(result.sources.map((source) => source.id)).toEqual(["title-match", "body-only"]);
    expect(result.selectedSources.map((selection) => selection.bucket)).toEqual(["required", "general"]);
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

  it("requires important general candidates to meet the configured score threshold", () => {
    const result = selectDigestSources(
      [
        candidate("weak-important", {
          title: "Google update"
        }),
        candidate("strong-important", {
          title: "Google published security protocol"
        }),
        candidate("general")
      ],
      [],
      [],
      {
        ...defaults,
        importantGeneralMinScore: 3
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["strong-important", "weak-important", "general"]);
    expect(result.selectedSources.map((selection) => selection.bucket)).toEqual([
      "important_general",
      "general",
      "general"
    ]);
  });

  it("promotes high-signal strategic general analysis over low-value recent entries", () => {
    const result = selectDigestSources(
      [
        candidate("recent-hiring", {
          title: "AI startup is hiring",
          summary: "The post is hiring for several jobs and includes no further analysis."
        }),
        candidate("recent-comments", {
          title: "Comments on model providers",
          summary: "This comments-only item likely discusses model providers but lacks detailed content."
        }),
        candidate("substitution-wave", {
          title: "The Substitution Wave in AI",
          author: "Tomasz Tunguz",
          summary: "The article analyzes substitution in AI buying, pricing pressure, frontier model costs, token usage, and model routing as buyers shift between providers.",
          topicTags: ["ai strategy", "unit economics"],
          entities: [{ name: "Tomasz Tunguz", type: "person" }]
        })
      ],
      [],
      [],
      {
        ...defaults,
        importantGeneralMaxEntries: 0,
        generalMaxEntries: 2
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["substitution-wave"]);
    expect(result.selectedSources[0]).toMatchObject({
      bucket: "general",
      signalLabel: "strategic_analysis"
    });
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

function visaOpenAi(id: string, overrides: Partial<DigestCandidate> = {}): DigestCandidate {
  return candidate(`visa-openai-${id}`, {
    title: "Visa and OpenAI announce agentic commerce payments",
    summary: "Visa and OpenAI announced agentic commerce payments and checkout.",
    topicTags: ["agentic payments", "agentic commerce"],
    entities: [{ name: "Visa", type: "company" }, { name: "OpenAI", type: "company" }],
    ...overrides
  });
}
