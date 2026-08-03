import { describe, expect, it } from "vitest";
import { selectDigestSources } from "../src/digest-selection.js";
import type { DigestCandidate, TopicClassification } from "../src/types.js";

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
      title: "Agentic payments update",
      summary: "A named source reported an agentic payments protocol update."
    })] }];

    const result = selectDigestSources(recent, required, [], {
      ...defaults,
      topicClassifications: classifications([["required-1", "required", "agentic payments"]])
    });

    expect(result.sources.map((source) => source.id)).toEqual(["required-1", "general-1", "general-2"]);
    expect(result.requiredCount).toBe(1);
    expect(result.generalCount).toBe(2);
  });

  it("selects focus area matches after required topic matches", () => {
    const result = selectDigestSources(
      [candidate("general-1")],
      [{ topic: "payments", matches: [candidate("required-1", {
        title: "Payments update",
        summary: "A named source reported a payments protocol update."
      })] }],
      [{ topic: "observability", matches: [candidate("focus-1", {
        title: "Observability update",
        summary: "A named source reported an observability tooling update."
      })] }],
      {
        ...defaults,
        topicClassifications: classifications([
          ["required-1", "required", "payments"],
          ["focus-1", "focus", "observability"]
        ])
      }
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
        candidate("weak-required", { score: 0.24, summary: "A named source reported an agentic payments update." }),
        candidate("strong-required", { score: 0.25, title: "Agentic payments update", summary: "A named source reported an agentic payments update." })
      ] }],
      [{ topic: "observability", matches: [
        candidate("weak-focus", { score: 0.34, summary: "A named source reported an observability update." }),
        candidate("strong-focus", { score: 0.35, title: "Observability update", summary: "A named source reported an observability update." })
      ] }],
      {
        ...defaults,
        requiredTopicMaxEntries: 3,
        focusAreaMaxEntries: 3,
        requiredTopicMinScore: 0.25,
        focusAreaMinScore: 0.35,
        topicClassifications: classifications([
          ["weak-required", "required", "agentic payments"],
          ["strong-required", "required", "agentic payments"],
          ["weak-focus", "focus", "observability"],
          ["strong-focus", "focus", "observability"]
        ])
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["strong-required", "strong-focus"]);
  });

  it("only selects vector matches the classifier confirms for the topic", () => {
    const result = selectDigestSources(
      [],
      [{ topic: "agentic payments", matches: [
        candidate("browser-agent", { score: 0.9, title: "Browser agent token costs" }),
        candidate("payments", { score: 0.4, title: "AI agency stablecoin payments tooling" })
      ] }],
      [],
      {
        ...defaults,
        requiredTopicMaxEntries: 3,
        requiredTopicMinScore: 0.25,
        // "browser-agent" scored higher on the vector search but the classifier only confirmed "payments"
        topicClassifications: classifications([["payments", "required", "agentic payments"]])
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["payments"]);
  });

  it("keeps only classifier-confirmed candidates when several share a broad concept", () => {
    const result = selectDigestSources(
      [],
      [{ topic: "agentic commerce", matches: [
        candidate("generic-commerce", { score: 0.9, title: "Q-commerce retail sales update" }),
        candidate("agentic-commerce", { score: 0.4, title: "AI agents for commerce checkout" }),
        candidate("exact-agentic-commerce", { score: 0.3, title: "Agentic commerce payments rollout" })
      ] }],
      [],
      {
        ...defaults,
        requiredTopicMaxEntries: 3,
        requiredTopicMinScore: 0.25,
        topicClassifications: classifications([
          ["agentic-commerce", "required", "agentic commerce"],
          ["exact-agentic-commerce", "required", "agentic commerce"]
        ])
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["agentic-commerce", "exact-agentic-commerce"]);
  });

  it("deduplicates candidates that match more than one bucket", () => {
    const shared = candidate("shared", {
      title: "Payments update",
      summary: "A named source reported a payments protocol update."
    });
    const result = selectDigestSources(
      [shared, candidate("general-1")],
      [{ topic: "payments", matches: [shared] }],
      [{ topic: "commerce", matches: [
        shared,
        candidate("focus-1", { title: "Commerce update", summary: "A named source reported a commerce tooling update." })
      ] }],
      {
        ...defaults,
        topicClassifications: classifications([
          ["shared", "required", "payments"],
          ["focus-1", "focus", "commerce"]
        ])
      }
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
      {
        ...defaults,
        topicClassifications: classifications([["required-mcp", "required", "MCP Discovery"]])
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["required-mcp"]);
    expect(result.focusCount).toBe(0);
    expect(result.selectedSources.map((selection) => selection.bucket)).toEqual(["required"]);
  });

  it("skips broad agentic focus buckets when required agentic topics already cover them", () => {
    const result = selectDigestSources(
      [],
      [{ topic: "Agentic Payments", matches: [
        candidate("required-agentic", { title: "Agentic payments update", summary: "A named source reported an agentic payments update." })
      ] }],
      [{ topic: "Agentic", matches: [
        candidate("focus-agentic", { title: "Agentic workflow update" })
      ] }],
      {
        ...defaults,
        topicClassifications: classifications([["required-agentic", "required", "Agentic Payments"]])
      }
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
        requiredTopicMaxEntries: 2,
        topicClassifications: classifications([
          ["payments-copy", "required", "agentic payments"],
          ["commerce-copy", "required", "agentic commerce"]
        ])
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
      {
        ...defaults,
        requiredTopicMaxEntries: 2,
        // the classifier assigns a single most-specific topic per candidate
        topicClassifications: classifications([["visa-openai-payments-commerce", "required", "agentic payments"]])
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["visa-openai-payments-commerce"]);
    expect(result.selectedSources.map((selection) => selection.topic)).toEqual(["agentic payments"]);
  });

  it("promotes a candidate to the topic the classifier picked even if a different topic's search retrieved it", () => {
    const paymentAuth = candidate("payment-auth", {
      title: "How should an AI agent prove a payment is allowed before it reaches the signer?",
      summary: "Discussion about agent payment authorization before a signer approves a transaction."
    });

    const result = selectDigestSources(
      [],
      [{ topic: "Agentic Payments", matches: [] }],
      [{ topic: "agent frameworks", matches: [paymentAuth] }],
      {
        ...defaults,
        focusAreaMaxEntries: 2,
        topicClassifications: classifications([["payment-auth", "required", "Agentic Payments"]])
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["payment-auth"]);
    expect(result.selectedSources[0]).toMatchObject({
      bucket: "required",
      topic: "Agentic Payments"
    });
    expect(result.requiredCount).toBe(1);
    expect(result.focusCount).toBe(0);
  });

  it("leaves a candidate under its classified focus topic when it does not match a required topic", () => {
    const agentAuthz = candidate("agent-authz", {
      title: "A2A solved how agents talk. It didn’t solve what a stranger agent is allowed to do - how are you handling authz?",
      summary: "Discussion about authorization for stranger agents."
    });

    const result = selectDigestSources(
      [],
      [{ topic: "Agentic Payments", matches: [] }],
      [{ topic: "agent frameworks", matches: [agentAuthz] }],
      {
        ...defaults,
        focusAreaMaxEntries: 2,
        topicClassifications: classifications([["agent-authz", "focus", "agent frameworks"]])
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["agent-authz"]);
    expect(result.selectedSources[0]).toMatchObject({
      bucket: "focus",
      topic: "agent frameworks"
    });
  });

  it("does not reassign generic transaction-coordination analysis to agentic payments", () => {
    const xbox = candidate("xbox-transaction-coordination", {
      title: "XBOX Cuts; Bundling and the Internet Solvent; Transaction, Coordination, and Sunk Costs",
      author: "Ben Thompson",
      summary: "Microsoft's Xbox division layoffs amid failed Game Pass strategy, bundling, transaction coordination, and sunk costs."
    });

    const result = selectDigestSources(
      [xbox],
      [{ topic: "Agentic Payments", matches: [] }],
      [],
      { ...defaults, importantGeneralMaxEntries: 0, generalMaxEntries: 1 }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["xbox-transaction-coordination"]);
    expect(result.selectedSources[0]?.bucket).toBe("general");
    expect(result.selectedSources[0]?.topic).toBeUndefined();
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

  it("suppresses stale repeats already covered in recent digests", () => {
    const yesterday = visaOpenAi("yesterday", {
      summary: "OpenAI and Visa announced agentic commerce checkout payments for ChatGPT users."
    });

    const result = selectDigestSources(
      [
        visaOpenAi("follow-on", {
          title: "Visa to enable OpenAI payments in agentic commerce - CFOtech Asia",
          canonicalUrl: "https://news.google.com/rss/articles/follow-on",
          summary: "Visa and OpenAI announced agentic commerce payments."
        }),
        candidate("fresh", {
          title: "Pine Labs launches agentic payment protocol",
          summary: "Pine Labs launched an agentic payment protocol for payment processing.",
          entities: [{ name: "Pine Labs", type: "company" }]
        })
      ],
      [{ topic: "agentic payments", matches: [] }],
      [],
      {
        ...defaults,
        priorDigestCandidates: [yesterday],
        importantGeneralMaxEntries: 0
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["fresh"]);
  });

  it("allows one material follow-up for a recently covered event", () => {
    const yesterday = visaOpenAi("yesterday", {
      summary: "OpenAI and Visa announced agentic commerce checkout payments for ChatGPT users."
    });

    const result = selectDigestSources(
      [
        visaOpenAi("stablecoin-1", {
          title: "Visa and OpenAI add stablecoin settlement to agent payments",
          summary: "Visa and OpenAI added stablecoin settlement expansion to agentic payments."
        }),
        visaOpenAi("stablecoin-2", {
          title: "Visa deepens OpenAI commerce push with stablecoin settlement",
          summary: "Visa and OpenAI expanded stablecoin settlement for agentic payments."
        }),
        candidate("fresh", {
          title: "Trustap raises funding for agentic commerce",
          summary: "Trustap raised funding for agentic commerce infrastructure.",
          entities: [{ name: "Trustap", type: "company" }]
        })
      ],
      [],
      [],
      {
        ...defaults,
        priorDigestCandidates: [yesterday],
        maxFollowupsPerEvent: 1,
        importantGeneralMaxEntries: 0
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual([
      "visa-openai-stablecoin-1",
      "fresh"
    ]);
    expect(result.selectedSources[0]?.freshnessLabel).toBe("follow_up");
  });

  it("uses fresh watchlist candidates before material follow-ups", () => {
    const yesterday = visaOpenAi("yesterday", {
      summary: "OpenAI and Visa announced agentic commerce checkout payments for ChatGPT users."
    });

    const stablecoin = visaOpenAi("stablecoin", {
      title: "Visa and OpenAI add stablecoin settlement to agent payments",
      summary: "Visa and OpenAI added stablecoin settlement expansion to agentic payments."
    });
    const freshPayments = candidate("fresh-payments", {
      title: "Pine Labs launches agentic payments protocol",
      summary: "Pine Labs launched an agentic payments protocol for payment processing.",
      entities: [{ name: "Pine Labs", type: "company" }]
    });

    const result = selectDigestSources(
      [stablecoin, freshPayments],
      [{ topic: "agentic payments", matches: [stablecoin, freshPayments] }],
      [],
      {
        ...defaults,
        requiredTopicMaxEntries: 2,
        priorDigestCandidates: [yesterday],
        importantGeneralMaxEntries: 0,
        generalMaxEntries: 0,
        topicClassifications: classifications([
          ["visa-openai-stablecoin", "required", "agentic payments"],
          ["fresh-payments", "required", "agentic payments"]
        ])
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["fresh-payments"]);
    expect(result.selectedSources.map((selection) => selection.freshnessLabel)).toEqual(["fresh"]);
  });

  it("respects the digest max entry cap", () => {
    const result = selectDigestSources(
      [candidate("general-1"), candidate("general-2"), candidate("general-3")],
      [{ topic: "payments", matches: [
        candidate("required-1", { title: "Payments update", summary: "A named source reported a payments protocol update." }),
        candidate("required-2", { title: "Payments launch", summary: "A named source reported a new payments protocol launch." })
      ] }],
      [{ topic: "commerce", matches: [
        candidate("focus-1", { title: "Commerce update", summary: "A named source reported a commerce tooling update." }),
        candidate("focus-2", { title: "Commerce launch", summary: "A named source reported a commerce tooling launch." })
      ] }],
      {
        ...defaults,
        maxEntries: 3,
        topicClassifications: classifications([
          ["required-1", "required", "payments"],
          ["required-2", "required", "payments"],
          ["focus-1", "focus", "commerce"],
          ["focus-2", "focus", "commerce"]
        ])
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["required-1", "required-2", "focus-1"]);
  });

  it("selects classifier-confirmed matches ahead of unconfirmed vector matches", () => {
    const exactTitle = candidate("exact-title", {
      title: "Agentic payments rollout",
      summary: "A named source reported an agentic payments rollout."
    });
    const exactTag = candidate("exact-tag", {
      topicTags: ["agentic payments"],
      summary: "A named source reported an agentic payments update."
    });
    const vector = candidate("vector", {
      title: "AI payments infrastructure"
    });

    const result = selectDigestSources(
      [],
      [{ topic: "agentic payments", matches: [exactTitle, exactTag, vector] }],
      [],
      {
        ...defaults,
        requiredTopicMaxEntries: 3,
        // the classifier did not confirm "vector" as centrally about the topic
        topicClassifications: classifications([
          ["exact-title", "required", "agentic payments"],
          ["exact-tag", "required", "agentic payments"]
        ])
      }
    );

    expect(result.sources.map((source) => source.id)).toEqual(["exact-title", "exact-tag"]);
  });

  it("does not classify a candidate into a topic bucket without classifier confirmation", () => {
    const result = selectDigestSources(
      [
        candidate("body-only", {
          contentText: "This body mentions agentic payments, but the source summary is unrelated."
        }),
        candidate("title-match", {
          title: "Agentic payments rollout",
          summary: "A named source reported an agentic payments rollout."
        })
      ],
      [{ topic: "agentic payments", matches: [
        candidate("title-match", {
          title: "Agentic payments rollout",
          summary: "A named source reported an agentic payments rollout."
        })
      ] }],
      [],
      {
        ...defaults,
        topicClassifications: classifications([["title-match", "required", "agentic payments"]])
      }
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

  it("ranks security advisories above community meta items", () => {
    const result = selectDigestSources(
      [
        candidate("model-civil-war", {
          title: "SPECIAL REPORT: The r/hermesagent Model Civil War",
          summary: "Community debate and model civil war discussion."
        }),
        candidate("hall-of-fame", {
          title: "r/hermesagent Hall of Fame: Top Posts of All Time",
          summary: "Community hall of fame list."
        }),
        candidate("tenda-backdoor", {
          title: "Tenda firmware contains hidden authentication backdoor",
          canonicalUrl: "https://kb.cert.org/vuls/id/213560",
          summary: "CERT reported a vulnerability and hidden authentication backdoor enabling unauthorized remote access."
        })
      ],
      [],
      [],
      {
        ...defaults,
        importantGeneralMaxEntries: 0,
        generalMaxEntries: 3
      }
    );

    expect(result.sources[0]?.id).toBe("tenda-backdoor");
  });

  it("limits selected entries by source type", () => {
    const result = selectDigestSources(
      [
        // give each a summary >=40 chars so the reddit/twitter/hackernews low-content
        // penalty in generalQualityScore doesn't confound this cap-only test
        candidate("reddit-1", { sourceType: "reddit", summary: "A named source reported a reddit discussion update." }),
        candidate("reddit-2", { sourceType: "reddit", summary: "A named source reported another reddit discussion update." }),
        candidate("reddit-3", { sourceType: "reddit", summary: "A named source reported a third reddit discussion update." }),
        candidate("article-1", { sourceType: "article", summary: "A named source reported an article update." }),
        candidate("article-2", { sourceType: "article", summary: "A named source reported another article update." })
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

function classifications(
  entries: Array<[id: string, bucket: TopicClassification["bucket"], topic: string]>
): Map<string, TopicClassification> {
  return new Map(entries.map(([id, bucket, topic]) => [id, { bucket, topic }]));
}
