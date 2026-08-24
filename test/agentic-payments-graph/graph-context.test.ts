import { describe, expect, it } from "vitest";
import { parseGraphContext, tripleKey } from "../../src/agentic-payments-graph/graph-context.js";

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

describe("parseGraphContext", () => {
  it("extracts entity ids, predicate vocabulary, triples, and source urls", () => {
    const context = parseGraphContext(FIXTURE_YAML);
    expect(context.entityIds).toEqual(new Set(["acp", "ucp"]));
    expect(context.predicates).toEqual(["co_developed_by"]);
    expect(context.tripleKeys).toEqual(new Set([tripleKey("acp", "co_developed_by", "openai")]));
    expect(context.sourceUrls).toEqual(new Set(["https://example.com/acp"]));
    expect(context.sourceIds).toEqual(new Set(["acp_spec"]));
  });
});
