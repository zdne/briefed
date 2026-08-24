import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  dedupeProposal,
  excludeKnownSources,
  extractCandidates,
  filterValidItems,
  isEmptyProposal,
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

describe("extractCandidates", () => {
  const context = parseGraphContext(FIXTURE_YAML);
  const makeSource = (id: string): CandidateSource => ({
    id, title: `Title ${id}`, url: `https://example.com/${id}`, author: null, publishedAt: null, collectedAt: "2026-08-23T00:00:00Z", summary: null
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
