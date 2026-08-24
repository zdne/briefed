import { describe, expect, it } from "vitest";
import {
  addToTaxonomyMembership,
  appendToFileEnd,
  assertValidYaml,
  candidateHeaderComment,
  formatClaimBlock,
  formatEntityLine,
  formatRelationshipLine,
  formatSourceLine,
  insertBeforeTopLevelKey
} from "../../src/agentic-payments-graph/patchers.js";

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

describe("insertBeforeTopLevelKey", () => {
  it("inserts a block immediately before the matching top-level key, leaving everything else untouched", () => {
    const result = insertBeforeTopLevelKey(FIXTURE_YAML, "relationships", "  - { id: new_entity, type: company, name: New Co }\n");
    expect(result).toContain("- { id: ucp, type: protocol, name: Universal Commerce Protocol }\n\n  - { id: new_entity, type: company, name: New Co }\nrelationships:");
    expect(result).toContain("# Commerce\n  - { subject: acp");
  });

  it("throws when the key doesn't exist", () => {
    expect(() => insertBeforeTopLevelKey(FIXTURE_YAML, "nope", "x\n")).toThrow(/Could not find top-level key/);
  });
});

describe("appendToFileEnd", () => {
  it("appends lines after normalizing trailing whitespace, with exactly one trailing newline", () => {
    const result = appendToFileEnd("a: 1\n\n\n", ["  - { id: new_source }"]);
    expect(result).toBe("a: 1\n  - { id: new_source }\n");
  });

  it("is a no-op for an empty lines array", () => {
    expect(appendToFileEnd(FIXTURE_YAML, [])).toBe(FIXTURE_YAML);
  });
});

describe("addToTaxonomyMembership", () => {
  it("appends an id to the flow's inline array", () => {
    const result = addToTaxonomyMembership(FIXTURE_YAML, "commerce", "stripe");
    expect(result).toContain("commerce: [acp, ucp, stripe]");
    expect(result).toContain("machine_payments: [x402]");
  });

  it("is idempotent when the id is already present", () => {
    const result = addToTaxonomyMembership(FIXTURE_YAML, "commerce", "acp");
    expect(result).toBe(FIXTURE_YAML);
  });

  it("throws when the flow doesn't exist", () => {
    expect(() => addToTaxonomyMembership(FIXTURE_YAML, "nonexistent_flow", "x")).toThrow(/Could not find taxonomy.memberships/);
  });
});


describe("formatEntityLine", () => {
  it("formats a bare entity", () => {
    expect(formatEntityLine({ id: "acme_pay", type: "company", name: "Acme Pay" }))
      .toBe('  - { id: acme_pay, type: company, name: "Acme Pay" }');
  });

  it("includes aliases when present", () => {
    expect(formatEntityLine({ id: "acme_pay", type: "company", name: "Acme Pay", aliases: ["Acme"] }))
      .toBe('  - { id: acme_pay, type: company, name: "Acme Pay", aliases: [Acme] }');
  });
});

describe("formatRelationshipLine", () => {
  it("formats a relationship with evidence", () => {
    expect(formatRelationshipLine({ subject: "acme_pay", predicate: "supports", object: "x402", status: "live" }, "acme_launch"))
      .toBe("  - { subject: acme_pay, predicate: supports, object: x402, status: live, evidence: [acme_launch] }");
  });

  it("includes qualifiers when present", () => {
    const line = formatRelationshipLine(
      { subject: "acme_pay", predicate: "settles_in", object: "usdc", status: "limited", qualifiers: { deployment: "testnet" } },
      "acme_launch"
    );
    expect(line).toBe("  - { subject: acme_pay, predicate: settles_in, object: usdc, status: limited, qualifiers: { deployment: testnet }, evidence: [acme_launch] }");
  });
});

describe("formatSourceLine", () => {
  it("formats a source with a url", () => {
    expect(formatSourceLine({ id: "acme_launch", publisher: "Acme", title: "Acme launches Pay", source_type: "primary", url: "https://acme.com/pay" }))
      .toBe('  - { id: acme_launch, publisher: "Acme", title: "Acme launches Pay", source_type: primary, url: "https://acme.com/pay" }');
  });

  it("uses null for a missing url", () => {
    expect(formatSourceLine({ id: "acme_launch", publisher: "Acme", title: "Acme launches Pay", source_type: "user_confirmed", url: null }))
      .toContain(", url: null }");
  });
});

describe("formatClaimBlock", () => {
  it("formats a multi-line claim block matching the file's block style", () => {
    const block = formatClaimBlock(
      { id: "acme_share", kind: "metric", subject: "acme_pay", predicate: "share_of", object: "sample", value: 42, unit: "percent" },
      "acme_launch",
      "2026-08-23"
    );
    expect(block).toBe(
      "  - id: acme_share\n" +
      "    kind: metric\n" +
      "    subject: acme_pay\n" +
      "    predicate: share_of\n" +
      "    object: sample\n" +
      "    value: 42\n" +
      "    unit: percent\n" +
      "    evidence: [acme_launch]\n" +
      "    checked_at: 2026-08-23"
    );
  });
});

describe("assertValidYaml", () => {
  it("does not throw for valid YAML", () => {
    expect(() => assertValidYaml(FIXTURE_YAML, "fixture")).not.toThrow();
  });

  it("throws for invalid YAML", () => {
    expect(() => assertValidYaml("entities: [ { id: x ", "fixture")).toThrow(/is not valid YAML/);
  });
});

describe("candidateHeaderComment", () => {
  it("formats a dated comment line", () => {
    expect(candidateHeaderComment("2026-08-23")).toBe("  # Candidates added 2026-08-23 from briefed\n");
  });
});
