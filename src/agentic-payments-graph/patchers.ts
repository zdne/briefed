import { load } from "js-yaml";

// The graph file has meaningful hand-written comments (section headers,
// editorial notes). Neither Ruby's nor JS's YAML libraries round-trip
// comments on a parse-and-dump cycle, so every patch here works by
// inserting new text at an anchor point in the raw file text — the file is
// never fully reparsed and reserialized.

export function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

export function formatEntityLine(entity: { id: string; type: string; name: string; aliases?: string[] }): string {
  const aliasPart = entity.aliases && entity.aliases.length > 0
    ? `, aliases: [${entity.aliases.join(", ")}]`
    : "";
  return `  - { id: ${entity.id}, type: ${entity.type}, name: ${yamlScalar(entity.name)}${aliasPart} }`;
}

export function formatRelationshipLine(
  relationship: { subject: string; predicate: string; object: string; status: string; qualifiers?: Record<string, unknown> },
  evidenceId: string
): string {
  const qualifierPart = relationship.qualifiers && Object.keys(relationship.qualifiers).length > 0
    ? `, qualifiers: { ${Object.entries(relationship.qualifiers).map(([key, value]) => `${key}: ${formatScalarValue(value)}`).join(", ")} }`
    : "";
  return `  - { subject: ${relationship.subject}, predicate: ${relationship.predicate}, object: ${relationship.object}, status: ${relationship.status}${qualifierPart}, evidence: [${evidenceId}] }`;
}

export function formatSourceLine(source: { id: string; publisher: string; title: string; source_type: string; url: string | null }): string {
  const urlPart = source.url ? `, url: ${yamlScalar(source.url)}` : ", url: null";
  return `  - { id: ${source.id}, publisher: ${yamlScalar(source.publisher)}, title: ${yamlScalar(source.title)}, source_type: ${source.source_type}${urlPart} }`;
}

export function formatClaimBlock(
  claim: {
    id: string;
    kind: string;
    subject: string;
    predicate: string;
    object?: string;
    value?: string | number;
    unit?: string;
    qualifiers?: Record<string, unknown>;
  },
  evidenceId: string,
  checkedAt: string
): string {
  const lines = [
    `  - id: ${claim.id}`,
    `    kind: ${claim.kind}`,
    `    subject: ${claim.subject}`,
    `    predicate: ${claim.predicate}`
  ];
  if (claim.object !== undefined) lines.push(`    object: ${formatScalarValue(claim.object)}`);
  if (claim.value !== undefined) lines.push(`    value: ${formatScalarValue(claim.value)}`);
  if (claim.unit !== undefined) lines.push(`    unit: ${claim.unit}`);
  if (claim.qualifiers && Object.keys(claim.qualifiers).length > 0) {
    lines.push("    qualifiers:");
    for (const [key, value] of Object.entries(claim.qualifiers)) {
      lines.push(`      ${key}: ${formatScalarValue(value)}`);
    }
  }
  lines.push(`    evidence: [${evidenceId}]`);
  lines.push(`    checked_at: ${checkedAt}`);
  return lines.join("\n");
}

function formatScalarValue(value: unknown): string {
  if (typeof value === "string") return /^[A-Za-z0-9_.-]+$/.test(value) ? value : yamlScalar(value);
  return String(value);
}

/** Inserts `block` (already newline-terminated) immediately before the line `^key:$`. */
export function insertBeforeTopLevelKey(text: string, key: string, block: string): string {
  const pattern = new RegExp(`^${key}:$`, "m");
  const match = pattern.exec(text);
  if (!match) throw new Error(`Could not find top-level key "${key}:" in graph YAML`);
  return text.slice(0, match.index) + block + text.slice(match.index);
}

export function appendToFileEnd(text: string, lines: string[]): string {
  if (lines.length === 0) return text;
  return `${text.replace(/\s*$/, "")}\n${lines.join("\n")}\n`;
}

export function candidateHeaderComment(dateLabel: string): string {
  return `  # Candidates added ${dateLabel} from briefed\n`;
}

export function addToTaxonomyMembership(text: string, flow: string, entityId: string): string {
  const pattern = new RegExp(`^(\\s*${flow}: \\[)([^\\]]*)(\\])`, "m");
  const match = pattern.exec(text);
  if (!match) throw new Error(`Could not find taxonomy.memberships.${flow} in graph YAML`);
  const existingIds = match[2]!.split(",").map((id) => id.trim()).filter(Boolean);
  if (existingIds.includes(entityId)) return text;
  const separator = existingIds.length > 0 ? ", " : "";
  const updated = `${match[1]}${match[2]}${separator}${entityId}${match[3]}`;
  return text.slice(0, match.index) + updated + text.slice(match.index + match[0].length);
}

export function assertValidYaml(text: string, label: string): void {
  try {
    load(text);
  } catch (error) {
    throw new Error(`Patched ${label} is not valid YAML: ${(error as Error).message}`);
  }
}
