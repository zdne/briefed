import { z } from "zod";
import type { AnalystAI } from "../ai.js";
import { retrieveRelevantSince } from "../db.js";
import { isGoogleNewsArticleUrl } from "../google-news-resolver.js";
import { canonicalizeUrl } from "../normalize.js";
import { tripleKey, type GraphContext } from "./graph-context.js";

const graphFlowSchema = z.enum(["shared_standards_trust", "commerce", "machine_payments", "treasury", "currency"]);
const graphStatusSchema = z.enum(["live", "limited", "announced", "planned", "reference"]);
const graphQualifiersSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional();

const graphEntityItemSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  flow: graphFlowSchema
});

const graphRelationshipItemSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  status: graphStatusSchema,
  qualifiers: graphQualifiersSchema
});

const graphClaimItemSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().optional(),
  value: z.union([z.number(), z.string()]).optional(),
  unit: z.string().optional(),
  qualifiers: graphQualifiersSchema
});

// The LLM sometimes sends explicit `null` (rather than omitting the key) for
// a claim field that doesn't apply to that claim's kind — strip those to
// "absent" before validating, ahead of the strict optional-string schema
// above.
const NULLABLE_CLAIM_KEYS = ["object", "value", "unit"] as const;

export function stripNullClaimFields(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const record = { ...(raw as Record<string, unknown>) };
  for (const key of NULLABLE_CLAIM_KEYS) {
    if (record[key] === null) delete record[key];
  }
  return record;
}

const graphProposalHeaderSchema = z.object({
  sourceIndex: z.number().int().min(0),
  reason: z.string().min(1),
  source: z.object({
    id: z.string().min(1),
    publisher: z.string().min(1).refine((value) => value.trim().toLowerCase() !== "unknown", {
      message: 'publisher must not be the literal "unknown" — omit the source rather than guess'
    }),
    title: z.string().min(1),
    source_type: z.enum(["primary", "secondary", "company_analysis", "user_confirmed"]),
    url: z.string().nullable()
  })
});

const graphCandidateEnvelopeSchema = z.object({ proposals: z.array(z.unknown()) });

export type GraphEntityItem = z.infer<typeof graphEntityItemSchema>;
export type GraphRelationshipItem = z.infer<typeof graphRelationshipItemSchema>;
export type GraphClaimItem = z.infer<typeof graphClaimItemSchema>;

export interface GraphCandidateProposal {
  sourceIndex: number;
  reason: string;
  source: z.infer<typeof graphProposalHeaderSchema>["source"];
  entities: GraphEntityItem[];
  relationships: GraphRelationshipItem[];
  claims: GraphClaimItem[];
}

/**
 * The LLM occasionally emits one malformed item (e.g. a relationship missing
 * a field) inside an otherwise-valid batch response. Validating item-by-item
 * — rather than one strict parse over the whole response — means a single
 * bad entry gets dropped with a warning instead of discarding every valid
 * proposal in the batch alongside it.
 */
export function filterValidItems<T>(schema: z.ZodType<T>, items: unknown, label: string): T[] {
  if (!Array.isArray(items)) return [];
  const valid: T[] = [];
  items.forEach((item, index) => {
    const result = schema.safeParse(item);
    if (result.success) {
      valid.push(result.data);
    } else {
      console.warn(`Skipping malformed ${label}[${index}]: ${result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
    }
  });
  return valid;
}

export interface GraphContextForPrompt {
  entities: { id: string; type: string; name: string; aliases?: string[] }[];
  predicates: string[];
}

export interface GraphCandidateSourceInput {
  title: string | null;
  url: string | null;
  publisher: string | null;
  publishedAt: string | null;
  summary: string | null;
}

function buildGraphCandidatePrompt(
  sources: GraphCandidateSourceInput[],
  context: GraphContextForPrompt
): string {
  return `You maintain a source-backed knowledge graph of the agentic payments ecosystem (companies, protocols, products, standards, and their relationships).

Editorial rules (strict):
- Only propose something a source explicitly documents. Do not infer a relationship that isn't stated.
- source_type reflects who owns the URL's domain, not how well-written the piece is:
  - "primary": the URL's domain is owned/operated by the entity the content is about — the
    company's own newsroom/blog/docs domain, the protocol's own site, or a standards body
    publishing its own spec. If you can't tell who owns the domain, do not call it "primary".
  - "secondary": any outlet, aggregator, or blog reporting on someone else's announcement —
    including press-release wire services (PR Newswire, Business Wire), general tech/crypto
    news sites, and news.google.com links, which are secondary regardless of what they link to,
    even if the wrapper eventually points at the company's own page.
  - "company_analysis": a company publishing analysis/commentary about the market or a
    competitor/partner, not its own product announcement.
  - "user_confirmed": never propose this value yourself; it is reserved for a source a human
    reviewer has manually supplied.
  - If the source's domain doesn't obviously belong to the company/protocol/product it's cited
    as evidence for, classify it "secondary" even if it reads like an announcement.
- publisher must name the organization that owns the source's domain. Never write "unknown" —
  if you can't identify the publisher, don't propose the source as "primary" (or at all, if you
  can't say anything specific and verifiable about it).
- A company's marketing claim of support for a protocol, without implementation evidence, is predicate "claims_support_for", status "announced" — not "supports"/"live".
- Use "live" only when the source shows something shipped/operating now; "limited" for pilots/betas/narrow availability; "announced" for a stated intent without evidence of implementation; "planned" for a stated future date/roadmap item; "reference" for background/governance facts (e.g. "governed_by", "hosted_by") that aren't a product capability.
- A missing relationship is not evidence of its absence — never propose a claim that something does NOT exist or is NOT supported, unless the source explicitly says so (then use claim kind "limitation").
- If a source doesn't add anything new and verifiable about this space, propose nothing for it.

Known entities already in the graph (reuse these exact ids — do not invent a duplicate for something already listed; only propose a NEW entity if it is genuinely absent):
${context.entities.map((entity) => `${entity.id} (${entity.type}): ${entity.name}${entity.aliases?.length ? ` [aka ${entity.aliases.join(", ")}]` : ""}`).join("\n")}

Predicate vocabulary already in use (reuse one of these when it fits; only invent a new predicate — a short snake_case verb phrase — when none of these fit):
${context.predicates.join(", ")}

Flows (assign every new entity and relationship to exactly one): shared_standards_trust, commerce, machine_payments, treasury, currency.

New entity/source id convention: lowercase snake_case, short, derived from the company or product name (e.g. "acme_pay" for "Acme Pay").

For each numbered source below, decide whether it supports adding anything to the graph. Return JSON: {"proposals": [{"sourceIndex": <0-based index>, "reason": "<one sentence: why this is graph-worthy>", "source": {"id": "...", "publisher": "...", "title": "...", "source_type": "primary"|"secondary"|"company_analysis"|"user_confirmed", "url": "..."|null}, "entities": [{"id": "...", "type": "...", "name": "...", "aliases": ["..."], "flow": "..."}], "relationships": [{"subject": "...", "predicate": "...", "object": "...", "status": "...", "qualifiers": {}}], "claims": [{"id": "...", "kind": "metric"|"announced_capability"|"limitation", "subject": "...", "predicate": "...", "object": "...", "value": ..., "unit": "...", "qualifiers": {}}]}]}. Omit a source entirely from "proposals" if it adds nothing new. Omit "entities"/"relationships"/"claims" arrays that would be empty.

Sources:
${sources.map((source, index) => `[${index}] ${source.title ?? "Untitled"} — ${source.publisher ?? "unknown publisher"}
URL: ${source.url ?? "unavailable"}
Published: ${source.publishedAt ?? "unknown"}
Summary: ${source.summary ?? "(no summary)"}`).join("\n\n")}`;
}

async function proposeGraphCandidates(
  ai: AnalystAI,
  sources: GraphCandidateSourceInput[],
  context: GraphContextForPrompt
): Promise<GraphCandidateProposal[]> {
  if (sources.length === 0) return [];
  const envelope = graphCandidateEnvelopeSchema.parse(
    await ai.generateJson(buildGraphCandidatePrompt(sources, context), { maxTokens: 8192 })
  );

  const proposals: GraphCandidateProposal[] = [];
  envelope.proposals.forEach((rawProposal, index) => {
    const header = graphProposalHeaderSchema.safeParse(rawProposal);
    if (!header.success) {
      console.warn(`Skipping malformed graph proposal[${index}]: ${header.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
      return;
    }
    const record = rawProposal as Record<string, unknown>;
    proposals.push({
      ...header.data,
      entities: filterValidItems(graphEntityItemSchema, record.entities, `proposal[${index}].entities`),
      relationships: filterValidItems(graphRelationshipItemSchema, record.relationships, `proposal[${index}].relationships`),
      claims: filterValidItems(
        graphClaimItemSchema,
        Array.isArray(record.claims) ? record.claims.map(stripNullClaimFields) : record.claims,
        `proposal[${index}].claims`
      )
    });
  });
  return proposals;
}

const FLOW_QUERIES: string[] = [
  "agentic AI trust and identity standards: MCP, Web Bot Authentication, AP2, agent authentication and authorization protocols",
  "agentic commerce checkout protocols: ACP, UCP, agent shopping, merchant acceptance, shared payment tokens",
  "agent-to-agent machine payments: x402, Machine Payments Protocol, pay-per-request APIs for AI agents, agent wallets",
  "agentic treasury: AI agents operating bank accounts, payments, and finance workflows under business controls",
  "stablecoin and currency settlement for AI agent payments: USDC, Open USD, card network stablecoin settlement"
];

export interface CandidateSource {
  id: string;
  title: string | null;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  collectedAt: string;
  summary: string | null;
}

/**
 * Semantic search only returns the top-K most similar items per query, not
 * an exhaustive scan of everything since `since` — if a run turns up more
 * than `limitPerFlow` genuinely new, relevant items in one flow, the least
 * similar ones won't surface this run. Acceptable for an on-demand,
 * human-reviewed tool; not a completeness guarantee.
 */
export async function findCandidateSources(
  ai: AnalystAI,
  since: string | null,
  limitPerFlow: number
): Promise<CandidateSource[]> {
  const seen = new Map<string, CandidateSource>();
  for (const query of FLOW_QUERIES) {
    const embedding = await ai.embed(query);
    const results = await retrieveRelevantSince(embedding, limitPerFlow, since);
    for (const result of results) {
      if (!result.canonicalUrl || seen.has(result.canonicalUrl)) continue;
      seen.set(result.canonicalUrl, {
        id: result.id,
        title: result.title,
        url: result.canonicalUrl,
        author: result.author,
        publishedAt: result.publishedAt,
        collectedAt: result.collectedAt,
        summary: result.summary
      });
    }
  }
  return [...seen.values()];
}

export function excludeKnownSources(sources: CandidateSource[], context: GraphContext): CandidateSource[] {
  return sources.filter((source) => !source.url || !context.sourceUrls.has(source.url));
}

const EXTRACTION_BATCH_SIZE = 10;

export async function extractCandidates(
  ai: AnalystAI,
  context: GraphContext,
  sources: CandidateSource[]
): Promise<GraphCandidateProposal[]> {
  const proposals: GraphCandidateProposal[] = [];
  for (let start = 0; start < sources.length; start += EXTRACTION_BATCH_SIZE) {
    const batch = sources.slice(start, start + EXTRACTION_BATCH_SIZE);
    let batchProposals: GraphCandidateProposal[];
    try {
      batchProposals = await proposeGraphCandidates(
        ai,
        batch.map((source) => ({
          title: source.title,
          url: source.url,
          publisher: source.author,
          publishedAt: source.publishedAt,
          summary: source.summary
        })),
        { entities: context.entities, predicates: context.predicates }
      );
    } catch (error) {
      // A single batch's response can still fail wholesale (e.g. malformed
      // JSON from an unlucky truncation) even with per-item validation
      // upstream. Losing that batch's sources for this run is better than
      // losing every other batch's already-extracted proposals too.
      console.warn(`Skipping batch [${start}, ${start + batch.length}): ${(error as Error).message}`);
      continue;
    }
    for (const proposal of batchProposals) {
      const source = batch[proposal.sourceIndex];
      if (!source) continue;
      proposals.push({ ...proposal, sourceIndex: start + proposal.sourceIndex });
    }
  }
  return proposals;
}

/** Drops entities/relationships already present in the graph; keeps everything else as proposed. */
export function dedupeProposal(proposal: GraphCandidateProposal, context: GraphContext): GraphCandidateProposal {
  return {
    ...proposal,
    entities: proposal.entities.filter((entity) => !context.entityIds.has(entity.id)),
    relationships: proposal.relationships.filter(
      (relationship) => !context.tripleKeys.has(tripleKey(relationship.subject, relationship.predicate, relationship.object))
    )
  };
}

export function isEmptyProposal(proposal: GraphCandidateProposal): boolean {
  return proposal.entities.length === 0 && proposal.relationships.length === 0 && proposal.claims.length === 0;
}

/**
 * The LLM occasionally references an entity id in a relationship/claim
 * without ever defining that entity — inventing an object id on the fly
 * without including a matching entry in the proposal's own "entities" array,
 * and it isn't in the graph yet either. Left alone, that reference silently
 * disappears at site-build time (site/_data/graph.js drops relationships/
 * claims pointing at unknown entities) — after a human already approved it.
 * Dropping it here, before review, means the reviewer only ever sees
 * proposals that are actually complete.
 */
export function dropDanglingReferences(proposal: GraphCandidateProposal, context: GraphContext): GraphCandidateProposal {
  const knownIds = new Set(context.entityIds);
  for (const entity of proposal.entities) knownIds.add(entity.id);

  const relationships = proposal.relationships.filter((relationship) => {
    const ok = knownIds.has(relationship.subject) && knownIds.has(relationship.object);
    if (!ok) console.warn(`Dropping relationship with undefined entity reference: ${JSON.stringify(relationship)}`);
    return ok;
  });
  const claims = proposal.claims.filter((claim) => {
    const ok = knownIds.has(claim.subject) && (!claim.object || knownIds.has(claim.object));
    if (!ok) console.warn(`Dropping claim with undefined entity reference: ${JSON.stringify(claim)}`);
    return ok;
  });

  return { ...proposal, relationships, claims };
}

/**
 * A reviewer manually confirmed a genuinely primary URL for this proposal
 * (e.g. found the company's own blog post rather than trusting the LLM's
 * discovery source) — mirrors what human review did by hand for several
 * mislabeled "primary" sources found in the 2026-08-23 candidates batch.
 */
export function applyUserSuppliedPrimarySource(
  source: GraphCandidateProposal["source"],
  override: { url: string; publisher?: string | null }
): GraphCandidateProposal["source"] {
  return {
    ...source,
    source_type: "user_confirmed",
    url: override.url,
    publisher: override.publisher?.trim() ? override.publisher.trim() : source.publisher
  };
}

export interface SourceReviewDisplay {
  url: string | null;
  isGoogleNewsWrapper: boolean;
  resolvedDestination: string | null;
}

/**
 * Describes a candidate's source URL for the interactive reviewer: whether
 * it's still an unresolved Google News wrapper, and if so, what it actually
 * resolves to — the reviewer has no way to judge primary-vs-secondary from
 * a wrapper link alone. `resolveWrapper` is injected so this stays
 * unit-testable without touching config/fetch.
 */
export async function describeSourceForReview(
  url: string | null,
  resolveWrapper: (url: string) => Promise<string | null>
): Promise<SourceReviewDisplay> {
  if (!url || !isGoogleNewsArticleUrl(url)) {
    return { url, isGoogleNewsWrapper: false, resolvedDestination: null };
  }
  return { url, isGoogleNewsWrapper: true, resolvedDestination: await resolveWrapper(url) };
}

/**
 * Best-effort pre-resolution of Google News wrapper links in candidate
 * sources before they're shown to the LLM, so source_type classification
 * (and the human review after it) sees the real publisher domain instead of
 * a news.google.com wrapper wherever resolution succeeds. Must stay a 1:1
 * map — command.ts indexes back into this array via proposal.sourceIndex.
 */
export async function resolveWrapperUrls(
  sources: CandidateSource[],
  resolveWrapper: (url: string) => Promise<string | null>
): Promise<CandidateSource[]> {
  return Promise.all(
    sources.map(async (source) => {
      if (!source.url || !isGoogleNewsArticleUrl(source.url)) return source;
      const resolved = await resolveWrapper(source.url);
      return resolved ? { ...source, url: canonicalizeUrl(resolved) } : source;
    })
  );
}
