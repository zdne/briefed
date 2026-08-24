import { readFileSync } from "node:fs";
import { load } from "js-yaml";

export interface GraphEntity {
  id: string;
  type: string;
  name: string;
  aliases?: string[];
}

interface RawGraphRelationship {
  subject: string;
  predicate: string;
  object: string;
}

interface RawGraphSource {
  id: string;
  url?: string | null;
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

export function loadGraphContext(yamlPath: string): GraphContext {
  return parseGraphContext(readFileSync(yamlPath, "utf8"));
}

export function parseGraphContext(raw: string): GraphContext {
  const parsed = load(raw) as {
    entities?: GraphEntity[];
    relationships?: RawGraphRelationship[];
    sources?: RawGraphSource[];
  };
  const entities = parsed.entities ?? [];
  const relationships = parsed.relationships ?? [];
  const sources = parsed.sources ?? [];

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
