import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

export const GRAPH_YAML_PATH = resolve(process.cwd(), "data/agentic-payments-graph.yaml");

export interface GraphEntity {
  id: string;
  type: string;
  name: string;
  aliases?: string[];
}

export interface GraphRelationshipFull {
  subject: string;
  predicate: string;
  object: string;
  status: string;
  qualifiers?: Record<string, unknown>;
  evidence?: string[];
}

export interface GraphClaimFull {
  id: string;
  kind: string;
  subject: string;
  predicate: string;
  object?: string;
  value?: number | string;
  unit?: string;
  qualifiers?: Record<string, unknown>;
  // A handful of hand-written "limitation" claims cite their checked
  // sources via qualifiers.checked_sources instead — not every claim has
  // this.
  evidence?: string[];
  checked_at?: string;
}

export interface GraphSourceFull {
  id: string;
  publisher: string | null;
  title: string;
  source_type: string;
  url: string | null;
}

export interface GraphDocument {
  entities: GraphEntity[];
  relationships: GraphRelationshipFull[];
  claims: GraphClaimFull[];
  sources: GraphSourceFull[];
}

export interface GraphContext {
  entities: GraphEntity[];
  entityIds: Set<string>;
  predicates: string[];
  tripleKeys: Set<string>;
  sourceUrls: Set<string>;
  sourceIds: Set<string>;
}

export function tripleKey(subject: string, predicate: string, object: string): string {
  return `${subject}|${predicate}|${object}`;
}

export function loadGraphDocument(yamlPath: string): GraphDocument {
  return parseGraphDocument(readFileSync(yamlPath, "utf8"));
}

export function parseGraphDocument(raw: string): GraphDocument {
  const parsed = load(raw) as Partial<GraphDocument>;
  return {
    entities: parsed.entities ?? [],
    relationships: parsed.relationships ?? [],
    claims: parsed.claims ?? [],
    sources: parsed.sources ?? []
  };
}

export function loadGraphContext(yamlPath: string): GraphContext {
  return parseGraphContext(readFileSync(yamlPath, "utf8"));
}

export function parseGraphContext(raw: string): GraphContext {
  const { entities, relationships, sources } = parseGraphDocument(raw);

  return {
    entities,
    entityIds: new Set(entities.map((entity) => entity.id)),
    predicates: [...new Set(relationships.map((relationship) => relationship.predicate))].sort(),
    tripleKeys: new Set(
      relationships.map((relationship) => tripleKey(relationship.subject, relationship.predicate, relationship.object))
    ),
    sourceUrls: new Set(sources.map((source) => source.url).filter((url): url is string => Boolean(url))),
    sourceIds: new Set(sources.map((source) => source.id))
  };
}
