import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

// Mirrors the flow ids used throughout data/agentic-payments-graph.yaml and
// src/agentic-payments-graph/candidates.ts's graphFlowSchema. This is the
// single place cluster grouping is derived from taxonomy.memberships — no
// separate hardcoded mapping to keep in sync (that duplication used to live
// in the old render.rb).
// Object key order drives petal position (data.clusters below), 12 o'clock
// clockwise: shared_standards_trust, machine_payments, treasury, currency,
// commerce.
const FLOW_LABELS = {
  shared_standards_trust: "Shared standards & trust",
  machine_payments: "Machine payments",
  treasury: "Treasury",
  currency: "Currency",
  commerce: "Commerce"
};

export default function () {
  const raw = readFileSync(resolve(process.cwd(), "data/agentic-payments-graph.yaml"), "utf8");
  const parsed = load(raw);

  const clusterByEntityId = {};
  for (const [flow, ids] of Object.entries(parsed.taxonomy?.memberships ?? {})) {
    const label = FLOW_LABELS[flow] ?? flow;
    for (const id of ids) clusterByEntityId[id] = label;
  }

  const entities = (parsed.entities ?? []).map((entity) => ({
    ...entity,
    cluster: clusterByEntityId[entity.id] ?? FLOW_LABELS.shared_standards_trust
  }));

  const entityIds = new Set(entities.map((entity) => entity.id));
  // A relationship's subject/object are always meant to be real entity ids
  // (unlike a claim's `object`, which is often free text — e.g. "ACP Shared
  // Payment Token handoff" — so that one isn't validated the same way). The
  // graph is meant to be closed, but a bad hand-edit or a graph-candidates
  // run that added a relationship without its entity can break that. The D3
  // layer does an unconditional entity lookup per relationship, so a dangling
  // reference crashes the whole page's rendering — drop those rather than
  // let that happen, and warn at build time so the gap doesn't silently
  // disappear.
  const relationships = (parsed.relationships ?? []).filter((relationship) => {
    const valid = entityIds.has(relationship.subject) && entityIds.has(relationship.object);
    if (!valid) console.warn(`[graph] Skipping relationship with unknown entity: ${JSON.stringify(relationship)}`);
    return valid;
  });

  return {
    entities,
    relationships,
    claims: parsed.claims ?? [],
    sources: parsed.sources ?? [],
    clusters: Object.values(FLOW_LABELS)
  };
}
