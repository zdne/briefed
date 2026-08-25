import { describe, expect, it } from "vitest";
import {
  buildAuditReport,
  entitiesReferencingSource,
  findDomainMismatches,
  findGoogleNewsWrapperSources,
  findMissingOrUnknownPublisherSources,
  formatAuditReport,
  normalizeForDomainMatch,
  registrableDomainLabel,
  safeHostname
} from "../../src/agentic-payments-graph/audit-sources.js";
import type { GraphClaimFull, GraphDocument, GraphEntity, GraphRelationshipFull, GraphSourceFull } from "../../src/agentic-payments-graph/graph-context.js";

const WRAPPER_URL = "https://news.google.com/rss/articles/CBMi123?oc=5";

function makeSource(overrides: Partial<GraphSourceFull>): GraphSourceFull {
  return { id: "src", publisher: "Publisher", title: "Title", source_type: "secondary", url: "https://example.com", ...overrides };
}

describe("safeHostname", () => {
  it("strips a leading www.", () => {
    expect(safeHostname("https://www.coinbase.com/blog/x")).toBe("coinbase.com");
  });

  it("returns null for an unparseable url", () => {
    expect(safeHostname("not a url")).toBeNull();
  });
});

describe("registrableDomainLabel", () => {
  it("takes the second-level label for a simple domain", () => {
    expect(registrableDomainLabel("coinbase.com")).toBe("coinbase");
  });

  it("does not special-case multi-part public suffixes (known limitation)", () => {
    expect(registrableDomainLabel("visa.co.uk")).toBe("co");
  });
});

describe("normalizeForDomainMatch", () => {
  it("lowercases and strips non-alphanumerics", () => {
    expect(normalizeForDomainMatch("AxLabs, Inc.")).toBe("axlabsinc");
  });
});

describe("findGoogleNewsWrapperSources", () => {
  it("flags only sources whose url is an unresolved Google News wrapper", () => {
    const sources = [makeSource({ id: "a", url: WRAPPER_URL }), makeSource({ id: "b", url: "https://coinbase.com/blog/x" })];
    expect(findGoogleNewsWrapperSources(sources).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("findMissingOrUnknownPublisherSources", () => {
  it("flags null, missing-ish, and \"unknown\" (case-insensitive) publishers", () => {
    const sources = [
      makeSource({ id: "a", publisher: null }),
      makeSource({ id: "b", publisher: "unknown" }),
      makeSource({ id: "c", publisher: "Unknown" }),
      makeSource({ id: "d", publisher: "Coinbase" })
    ];
    expect(findMissingOrUnknownPublisherSources(sources).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});

describe("entitiesReferencingSource", () => {
  const relationships: GraphRelationshipFull[] = [
    { subject: "coinbase", predicate: "uses", object: "x402", status: "live", evidence: ["src_a"] },
    { subject: "mastercard", predicate: "uses", object: "x402", status: "live", evidence: ["src_b"] }
  ];
  const claims: GraphClaimFull[] = [
    { id: "claim1", kind: "metric", subject: "coinbase", predicate: "share_of", object: "tracked_onchain_machine_payment_sample", evidence: ["src_a"] }
  ];
  const knownEntityIds = new Set(["coinbase", "mastercard", "x402"]);

  it("includes both subject and object for a relationship citing the source", () => {
    expect(entitiesReferencingSource("src_a", relationships, [], knownEntityIds)).toEqual(new Set(["coinbase", "x402"]));
  });

  it("excludes a claim's object when it isn't a known entity id (free-text object)", () => {
    expect(entitiesReferencingSource("src_a", [], claims, knownEntityIds)).toEqual(new Set(["coinbase"]));
  });

  it("returns an empty set when nothing cites the source", () => {
    expect(entitiesReferencingSource("src_z", relationships, claims, knownEntityIds)).toEqual(new Set());
  });
});

describe("findDomainMismatches", () => {
  const coinbase: GraphEntity = { id: "coinbase", type: "company", name: "Coinbase" };
  const x402: GraphEntity = { id: "x402", type: "protocol", name: "x402" };

  function doc(sources: GraphSourceFull[], relationships: GraphRelationshipFull[]): GraphDocument {
    return { entities: [coinbase, x402], relationships, claims: [], sources };
  }

  it("does not flag a primary source whose domain matches the subject entity", () => {
    const relationships: GraphRelationshipFull[] = [{ subject: "coinbase", predicate: "uses", object: "x402", status: "live", evidence: ["s1"] }];
    const sources = [makeSource({ id: "s1", source_type: "primary", url: "https://www.coinbase.com/blog/coinbase-for-agents" })];
    expect(findDomainMismatches(doc(sources, relationships))).toEqual([]);
  });

  it("flags a primary source whose domain doesn't match the domain-owning entity it's evidence for", () => {
    const relationships: GraphRelationshipFull[] = [{ subject: "coinbase", predicate: "uses", object: "x402", status: "live", evidence: ["s1"] }];
    const sources = [makeSource({ id: "s1", source_type: "primary", publisher: "Yellow.com", url: "https://yellow.com/news/coinbase-ai-agents" })];
    const findings = findDomainMismatches(doc(sources, relationships));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ sourceId: "s1", checkedAgainstEntityIds: ["coinbase"] });
  });

  it("does not flag a primary source cited only for protocol-only entities (no domain-owning signal)", () => {
    const relationships: GraphRelationshipFull[] = [{ subject: "x402", predicate: "documented_by", object: "x402", status: "reference", evidence: ["s1"] }];
    const sources = [makeSource({ id: "s1", source_type: "primary", url: "https://x402.org/spec" })];
    expect(findDomainMismatches(doc(sources, relationships))).toEqual([]);
  });

  it("ignores secondary sources entirely", () => {
    const relationships: GraphRelationshipFull[] = [{ subject: "coinbase", predicate: "uses", object: "x402", status: "live", evidence: ["s1"] }];
    const sources = [makeSource({ id: "s1", source_type: "secondary", url: "https://yellow.com/news/x" })];
    expect(findDomainMismatches(doc(sources, relationships))).toEqual([]);
  });

  it("does not flag a primary press release distributed via a known wire service", () => {
    const relationships: GraphRelationshipFull[] = [{ subject: "coinbase", predicate: "uses", object: "x402", status: "live", evidence: ["s1"] }];
    const sources = [
      makeSource({ id: "s1", source_type: "primary", publisher: "Coinbase", url: "https://www.prnewswire.com/news-releases/coinbase-x402-launch" })
    ];
    expect(findDomainMismatches(doc(sources, relationships))).toEqual([]);
  });
});

describe("buildAuditReport / formatAuditReport", () => {
  it("assembles all three finding lists and a total count", () => {
    const coinbase: GraphEntity = { id: "coinbase", type: "company", name: "Coinbase" };
    const document: GraphDocument = {
      entities: [coinbase],
      relationships: [{ subject: "coinbase", predicate: "uses", object: "coinbase", status: "live", evidence: ["s2"] }],
      claims: [],
      sources: [
        makeSource({ id: "s1", url: WRAPPER_URL }),
        makeSource({ id: "s2", source_type: "primary", publisher: "Yellow.com", url: "https://yellow.com/x" }),
        makeSource({ id: "s3", publisher: "unknown" })
      ]
    };

    const report = buildAuditReport(document);
    expect(report.totalSourceCount).toBe(3);
    expect(report.wrapperSources.map((s) => s.id)).toEqual(["s1"]);
    expect(report.missingPublisherSources.map((s) => s.id)).toEqual(["s3"]);
    expect(report.domainMismatches.map((f) => f.sourceId)).toEqual(["s2"]);

    const formatted = formatAuditReport(report, new Map([[WRAPPER_URL, "https://www.coinbase.com/blog/x"]]));
    expect(formatted).toContain("Unresolved Google News wrapper URLs (1)");
    expect(formatted).toContain("resolves to: coinbase.com");
    expect(formatted).toContain('Missing or "unknown" publisher (1)');
    expect(formatted).toContain("Possible primary/secondary domain mismatches (1)");
    expect(formatted).toContain("3 suspect source(s) flagged out of 3 cataloged");
  });

  it("reports zero findings cleanly", () => {
    const report = buildAuditReport({ entities: [], relationships: [], claims: [], sources: [] });
    const formatted = formatAuditReport(report);
    expect(formatted).toContain("0 suspect source(s) flagged out of 0 cataloged");
  });
});
