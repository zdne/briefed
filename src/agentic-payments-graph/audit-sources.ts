import { isGoogleNewsArticleUrl } from "../google-news-resolver.js";
import type { GraphClaimFull, GraphDocument, GraphEntity, GraphRelationshipFull, GraphSourceFull } from "./graph-context.js";

const DOMAIN_OWNING_ENTITY_TYPES = new Set(["company", "financial_institution", "merchant", "foundation", "standards_body"]);

// A press release is still the company's own words even when distributed
// through a wire service whose domain can never match the company it's
// about — flagging those as a "domain mismatch" is pure noise, not signal.
const WIRE_SERVICE_HOSTNAMES = new Set(["prnewswire.com", "businesswire.com", "globenewswire.com", "prweb.com"]);

export function normalizeForDomainMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return null;
  }
}

/**
 * Best-effort second-level-domain guess. Doesn't special-case multi-part
 * public suffixes (co.uk, com.au, ...) — a known false-negative source for
 * those TLDs, acceptable for an advisory/report-only heuristic.
 */
export function registrableDomainLabel(hostname: string): string {
  const labels = hostname.split(".");
  return normalizeForDomainMatch(labels.length >= 2 ? labels[labels.length - 2]! : labels[0]!);
}

function entityMatchesDomain(entity: GraphEntity, domainLabel: string): boolean {
  if (domainLabel.length < 3) return false;
  const candidates = [entity.id, entity.name, ...(entity.aliases ?? [])].map(normalizeForDomainMatch);
  return candidates.some((candidate) => candidate.length >= 3 && (candidate === domainLabel || candidate.includes(domainLabel) || domainLabel.includes(candidate)));
}

export function indexEntitiesById(entities: GraphEntity[]): Map<string, GraphEntity> {
  return new Map(entities.map((entity) => [entity.id, entity]));
}

export function entitiesReferencingSource(
  sourceId: string,
  relationships: GraphRelationshipFull[],
  claims: GraphClaimFull[],
  knownEntityIds: Set<string>
): Set<string> {
  const ids = new Set<string>();
  for (const relationship of relationships) {
    if (!relationship.evidence?.includes(sourceId)) continue;
    ids.add(relationship.subject);
    ids.add(relationship.object);
  }
  for (const claim of claims) {
    // Some hand-written "limitation" claims cite their checked sources via
    // qualifiers.checked_sources instead of a top-level evidence array —
    // real, pre-existing data shape, not malformed input.
    if (!claim.evidence?.includes(sourceId)) continue;
    ids.add(claim.subject);
    if (claim.object && knownEntityIds.has(claim.object)) ids.add(claim.object);
  }
  return ids;
}

export function findGoogleNewsWrapperSources(sources: GraphSourceFull[]): GraphSourceFull[] {
  return sources.filter((source) => isGoogleNewsArticleUrl(source.url));
}

export function findMissingOrUnknownPublisherSources(sources: GraphSourceFull[]): GraphSourceFull[] {
  return sources.filter((source) => !source.publisher || source.publisher.trim().toLowerCase() === "unknown");
}

export interface DomainMismatchFinding {
  sourceId: string;
  url: string;
  publisher: string | null;
  checkedAgainstEntityIds: string[];
}

/**
 * Flags a source_type: primary source whose URL's domain doesn't match any
 * domain-owning entity (company/financial_institution/merchant/foundation/
 * standards_body) it's cited as evidence for. Skips sources not referenced
 * by any domain-owning entity — a protocol-only citation gives no domain
 * signal to check against, so silence there isn't a finding either way —
 * and skips known press-release wire services (WIRE_SERVICE_HOSTNAMES),
 * whose domain can never match the company the release is about even when
 * the release is genuinely that company's own words.
 */
export function findDomainMismatches(doc: GraphDocument): DomainMismatchFinding[] {
  const entityById = indexEntitiesById(doc.entities);
  const knownEntityIds = new Set(entityById.keys());
  const findings: DomainMismatchFinding[] = [];

  for (const source of doc.sources) {
    if (source.source_type !== "primary" || !source.url) continue;
    const hostname = safeHostname(source.url);
    if (!hostname || WIRE_SERVICE_HOSTNAMES.has(hostname)) continue;

    const referencedIds = entitiesReferencingSource(source.id, doc.relationships, doc.claims, knownEntityIds);
    const domainOwningEntities = [...referencedIds]
      .map((id) => entityById.get(id))
      .filter((entity): entity is GraphEntity => entity !== undefined && DOMAIN_OWNING_ENTITY_TYPES.has(entity.type));
    if (domainOwningEntities.length === 0) continue;

    const domainLabel = registrableDomainLabel(hostname);
    if (domainOwningEntities.some((entity) => entityMatchesDomain(entity, domainLabel))) continue;

    findings.push({
      sourceId: source.id,
      url: source.url,
      publisher: source.publisher,
      checkedAgainstEntityIds: domainOwningEntities.map((entity) => entity.id)
    });
  }
  return findings;
}

export interface AuditReport {
  wrapperSources: GraphSourceFull[];
  missingPublisherSources: GraphSourceFull[];
  domainMismatches: DomainMismatchFinding[];
  totalSourceCount: number;
}

export function buildAuditReport(doc: GraphDocument): AuditReport {
  return {
    wrapperSources: findGoogleNewsWrapperSources(doc.sources),
    missingPublisherSources: findMissingOrUnknownPublisherSources(doc.sources),
    domainMismatches: findDomainMismatches(doc),
    totalSourceCount: doc.sources.length
  };
}

export function formatAuditReport(report: AuditReport, resolvedWrappers: Map<string, string | null> = new Map()): string {
  const lines: string[] = [];

  lines.push(`== Unresolved Google News wrapper URLs (${report.wrapperSources.length}) ==`);
  for (const source of report.wrapperSources) {
    const resolved = source.url ? resolvedWrappers.get(source.url) : undefined;
    lines.push(`- ${source.id}: ${source.url} (publisher: ${JSON.stringify(source.publisher)})`);
    if (resolved) lines.push(`    resolves to: ${safeHostname(resolved) ?? resolved}`);
  }
  lines.push("");

  lines.push(`== Missing or "unknown" publisher (${report.missingPublisherSources.length}) ==`);
  for (const source of report.missingPublisherSources) {
    lines.push(`- ${source.id}: publisher=${JSON.stringify(source.publisher)}, url=${JSON.stringify(source.url)}`);
  }
  lines.push("");

  lines.push(`== Possible primary/secondary domain mismatches (${report.domainMismatches.length}) ==`);
  for (const finding of report.domainMismatches) {
    lines.push(`- ${finding.sourceId}: url=${finding.url} publisher=${JSON.stringify(finding.publisher)}`);
    lines.push(`    cited as evidence for: ${finding.checkedAgainstEntityIds.join(", ")} — domain doesn't obviously match`);
  }
  lines.push("");

  const total = report.wrapperSources.length + report.missingPublisherSources.length + report.domainMismatches.length;
  lines.push(`${total} suspect source(s) flagged out of ${report.totalSourceCount} cataloged. Report only — nothing was changed.`);
  return lines.join("\n");
}
