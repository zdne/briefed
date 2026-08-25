import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  applyUserSuppliedPrimarySource,
  dedupeProposal,
  describeSourceForReview,
  excludeKnownSources,
  extractCandidates,
  filterValidItems,
  isEmptyProposal,
  resolveWrapperUrls,
  stripNullClaimFields,
  type CandidateSource,
  type GraphCandidateProposal
} from "../../src/agentic-payments-graph/candidates.js";
import { parseGraphContext } from "../../src/agentic-payments-graph/graph-context.js";
import type { AnalystAI } from "../../src/ai.js";

const FIXTURE_YAML = `taxonomy:
  memberships:
    commerce: [acp, ucp]
    machine_payments: [x402]

entities:
  # Commerce
  - { id: acp, type: protocol, name: Agentic Commerce Protocol }
  - { id: ucp, type: protocol, name: Universal Commerce Protocol }

relationships:
  # Commerce
  - { subject: acp, predicate: co_developed_by, object: openai, status: reference, evidence: [acp_spec] }

claims:
  - id: existing_claim
    kind: metric
    subject: acp
    predicate: share_of
    value: 50
    evidence: [acp_spec]
    checked_at: 2026-07-27

sources:
  - { id: acp_spec, publisher: ACP, title: "ACP specification", source_type: primary, url: "https://example.com/acp" }
`;

describe("filterValidItems", () => {
  const relationshipSchema = z.object({ subject: z.string(), predicate: z.string(), object: z.string() });

  it("drops a malformed item without throwing, keeping every valid item around it", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const items = [
      { subject: "a", predicate: "supports", object: "b" },
      { subject: "c" }, // missing predicate/object, mirroring a real truncated LLM response
      { subject: "d", predicate: "uses", object: "e" }
    ];

    const result = filterValidItems(relationshipSchema, items, "proposal[3].relationships");

    expect(result).toEqual([
      { subject: "a", predicate: "supports", object: "b" },
      { subject: "d", predicate: "uses", object: "e" }
    ]);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("proposal[3].relationships[1]");
    warnSpy.mockRestore();
  });

  it("returns an empty array when the input isn't an array", () => {
    expect(filterValidItems(relationshipSchema, undefined, "x")).toEqual([]);
  });
});

describe("stripNullClaimFields", () => {
  it("removes explicit null on object/value/unit, leaving other fields untouched", () => {
    expect(stripNullClaimFields({ id: "x", value: null, object: null, unit: null, kind: "limitation" }))
      .toEqual({ id: "x", kind: "limitation" });
  });

  it("leaves a claim with real values untouched", () => {
    const claim = { id: "x", value: 42, unit: "percent" };
    expect(stripNullClaimFields(claim)).toEqual(claim);
  });

  it("passes through non-object input unchanged", () => {
    expect(stripNullClaimFields(null)).toBeNull();
    expect(stripNullClaimFields("not an object")).toBe("not an object");
  });
});

describe("excludeKnownSources", () => {
  const context = parseGraphContext(FIXTURE_YAML);
  const makeSource = (url: string | null): CandidateSource => ({
    id: "1", title: "T", url, author: null, publishedAt: null, collectedAt: "2026-08-23T00:00:00Z", summary: null
  });

  it("filters out sources whose url is already cataloged", () => {
    const result = excludeKnownSources([makeSource("https://example.com/acp"), makeSource("https://new.example.com")], context);
    expect(result.map((s) => s.url)).toEqual(["https://new.example.com"]);
  });

  it("keeps sources with no url", () => {
    expect(excludeKnownSources([makeSource(null)], context)).toHaveLength(1);
  });
});

describe("dedupeProposal and isEmptyProposal", () => {
  const context = parseGraphContext(FIXTURE_YAML);
  const baseProposal: GraphCandidateProposal = {
    sourceIndex: 0,
    reason: "test",
    source: { id: "new_src", publisher: "P", title: "T", source_type: "primary", url: null },
    entities: [
      { id: "acp", type: "protocol", name: "Agentic Commerce Protocol", flow: "commerce" },
      { id: "new_co", type: "company", name: "New Co", flow: "commerce" }
    ],
    relationships: [
      { subject: "acp", predicate: "co_developed_by", object: "openai", status: "reference" },
      { subject: "new_co", predicate: "supports", object: "acp", status: "live" }
    ],
    claims: []
  };

  it("drops entities and relationships that already exist in the graph", () => {
    const result = dedupeProposal(baseProposal, context);
    expect(result.entities.map((e) => e.id)).toEqual(["new_co"]);
    expect(result.relationships).toEqual([{ subject: "new_co", predicate: "supports", object: "acp", status: "live" }]);
  });

  it("flags a proposal with nothing left after dedup as empty", () => {
    const onlyKnown: GraphCandidateProposal = { ...baseProposal, entities: [baseProposal.entities[0]!], relationships: [baseProposal.relationships[0]!], claims: [] };
    expect(isEmptyProposal(dedupeProposal(onlyKnown, context))).toBe(true);
  });

  it("does not flag a proposal with genuinely new content as empty", () => {
    expect(isEmptyProposal(dedupeProposal(baseProposal, context))).toBe(false);
  });
});

describe("applyUserSuppliedPrimarySource", () => {
  const source: GraphCandidateProposal["source"] = { id: "src", publisher: "Yellow.com", title: "T", source_type: "primary", url: "https://yellow.com/x" };

  it("forces source_type to user_confirmed and swaps in the given url", () => {
    const result = applyUserSuppliedPrimarySource(source, { url: "https://coinbase.com/blog/coinbase-for-agents" });
    expect(result.source_type).toBe("user_confirmed");
    expect(result.url).toBe("https://coinbase.com/blog/coinbase-for-agents");
    expect(result.id).toBe("src");
    expect(result.title).toBe("T");
  });

  it("keeps the existing publisher when no override is given", () => {
    expect(applyUserSuppliedPrimarySource(source, { url: "https://coinbase.com/x" }).publisher).toBe("Yellow.com");
  });

  it("uses the override publisher when a non-blank one is given, trimmed", () => {
    expect(applyUserSuppliedPrimarySource(source, { url: "https://coinbase.com/x", publisher: "  Coinbase  " }).publisher).toBe("Coinbase");
  });

  it("ignores a blank override publisher", () => {
    expect(applyUserSuppliedPrimarySource(source, { url: "https://coinbase.com/x", publisher: "   " }).publisher).toBe("Yellow.com");
  });
});

describe("describeSourceForReview", () => {
  const wrapperUrl = "https://news.google.com/rss/articles/CBMi123?oc=5";

  it("passes a non-wrapper url through without calling the resolver", async () => {
    const resolveWrapper = vi.fn(async () => "should not be called");
    const result = await describeSourceForReview("https://coinbase.com/blog/x", resolveWrapper);
    expect(result).toEqual({ url: "https://coinbase.com/blog/x", isGoogleNewsWrapper: false, resolvedDestination: null });
    expect(resolveWrapper).not.toHaveBeenCalled();
  });

  it("passes a null url through without calling the resolver", async () => {
    const resolveWrapper = vi.fn(async () => "should not be called");
    expect(await describeSourceForReview(null, resolveWrapper)).toEqual({ url: null, isGoogleNewsWrapper: false, resolvedDestination: null });
    expect(resolveWrapper).not.toHaveBeenCalled();
  });

  it("resolves a Google News wrapper url and reports the destination", async () => {
    const resolveWrapper = vi.fn(async () => "https://www.coinbase.com/blog/coinbase-for-agents");
    const result = await describeSourceForReview(wrapperUrl, resolveWrapper);
    expect(result).toEqual({ url: wrapperUrl, isGoogleNewsWrapper: true, resolvedDestination: "https://www.coinbase.com/blog/coinbase-for-agents" });
    expect(resolveWrapper).toHaveBeenCalledWith(wrapperUrl);
  });

  it("reports a null destination when resolution fails", async () => {
    const resolveWrapper = vi.fn(async () => null);
    const result = await describeSourceForReview(wrapperUrl, resolveWrapper);
    expect(result).toEqual({ url: wrapperUrl, isGoogleNewsWrapper: true, resolvedDestination: null });
  });
});

describe("resolveWrapperUrls", () => {
  const wrapperUrl = "https://news.google.com/rss/articles/CBMi123?oc=5";
  const makeSource = (id: string, url: string | null): CandidateSource => ({
    id, title: `Title ${id}`, url, author: null, publishedAt: null, collectedAt: "2026-08-23T00:00:00Z", summary: null
  });

  it("preserves array length and order (sourceIndex correctness depends on this)", async () => {
    const resolveWrapper = vi.fn(async () => "https://www.coinbase.com/blog/coinbase-for-agents");
    const sources = [makeSource("a", "https://coinbase.com/x"), makeSource("b", wrapperUrl), makeSource("c", null)];
    const result = await resolveWrapperUrls(sources, resolveWrapper);
    expect(result.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves non-wrapper and null urls untouched", async () => {
    const resolveWrapper = vi.fn(async () => "https://www.coinbase.com/blog/coinbase-for-agents");
    const sources = [makeSource("a", "https://coinbase.com/x"), makeSource("c", null)];
    const result = await resolveWrapperUrls(sources, resolveWrapper);
    expect(result[0]!.url).toBe("https://coinbase.com/x");
    expect(result[1]!.url).toBeNull();
    expect(resolveWrapper).not.toHaveBeenCalled();
  });

  it("replaces a wrapper url with the canonicalized resolved destination", async () => {
    const resolveWrapper = vi.fn(async () => "https://www.coinbase.com/blog/coinbase-for-agents?utm_source=x");
    const [result] = await resolveWrapperUrls([makeSource("b", wrapperUrl)], resolveWrapper);
    expect(result!.url).toBe("https://www.coinbase.com/blog/coinbase-for-agents");
  });

  it("keeps the original wrapper url when resolution fails", async () => {
    const resolveWrapper = vi.fn(async () => null);
    const [result] = await resolveWrapperUrls([makeSource("b", wrapperUrl)], resolveWrapper);
    expect(result!.url).toBe(wrapperUrl);
  });
});

describe("extractCandidates", () => {
  const context = parseGraphContext(FIXTURE_YAML);
  const makeSource = (id: string): CandidateSource => ({
    id, title: `Title ${id}`, url: `https://example.com/${id}`, author: null, publishedAt: null, collectedAt: "2026-08-23T00:00:00Z", summary: null
  });

  it("drops a proposal whose publisher is the literal \"unknown\"", async () => {
    const generateJson = vi.fn(async () => ({
      proposals: [{
        sourceIndex: 0,
        reason: "test",
        source: { id: "new_src", publisher: "unknown", title: "T", source_type: "primary", url: null }
      }]
    }));
    const ai = { generateJson } as unknown as AnalystAI;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const proposals = await extractCandidates(ai, context, [makeSource("0")]);

    expect(proposals).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("publisher"));
    warnSpy.mockRestore();
  });

  it("keeps proposals from a later batch even when an earlier batch's extraction throws", async () => {
    // 11 sources spans two batches (size 10): a failing first batch and a succeeding second one.
    const sources = Array.from({ length: 11 }, (_, index) => makeSource(String(index)));
    let callCount = 0;
    const generateJson = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("LLM returned malformed JSON, likely truncated by the output token limit");
      return {
        proposals: [{
          sourceIndex: 0,
          reason: "test",
          source: { id: "new_src", publisher: "P", title: "T", source_type: "primary", url: null }
        }]
      };
    });
    const ai = { generateJson } as unknown as AnalystAI;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const proposals = await extractCandidates(ai, context, sources);

    expect(generateJson).toHaveBeenCalledTimes(2);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.sourceIndex).toBe(10);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping batch"));
    warnSpy.mockRestore();
  });
});
