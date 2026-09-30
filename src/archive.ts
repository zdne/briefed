import { z } from "zod";
import { config } from "./config.js";
import {
  getArchiveContentByIds,
  listArchiveContent,
  searchArchiveLexical,
  searchArchiveSemantic
} from "./db.js";
import type { SourceType } from "./enrichment-policy.js";
import type { ArchiveContentRow, ArchiveRecordBase, ArchiveSearchRow } from "./types.js";

const SOURCE_TYPES = ["article", "reddit", "hackernews", "twitter", "clip"] as const;

function isoDateString() {
  return z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "must be a parseable date/time string, e.g. \"2026-09-01\" or \"2026-09-01T00:00:00Z\""
  });
}

function toIso(value: string | undefined | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

// Distinct from toIso: preserves "omitted" (undefined) rather than collapsing
// it to null, which matters when validating a request against a cursor —
// null there means "explicitly cleared," not "not passed."
function toIsoOrUndefined(value: string | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

// --- Provenance derivations --------------------------------------------------
//
// Mechanical, documented mappings from the already-stored source_key prefix —
// not a per-item editorial judgment about sensitivity or page completeness.

/**
 * True only when sourceKey indicates the Gmail collector. This reflects
 * collection *channel*, not a content-sensitivity determination: records
 * from any source — especially clip:text, which stores arbitrary pasted
 * text — can still contain sensitive material. Do not treat `false` here as
 * "safe to treat as public."
 */
export function deriveIsGmailSource(sourceKey: string): boolean {
  return sourceKey.startsWith("gmail:");
}

export type ContentCompleteness = "full" | "excerpt" | "unknown";

/**
 * Derived from documented collector behavior (docs/HowItWorks.md), not
 * inspected per item:
 * - rss: (including Reddit/HN RSS) stores feed-provided content only, never
 *   the fetched original page — "excerpt".
 * - gmail: stores the full message payload fetched via the Gmail API — "full".
 * - twitterapi: stores a tweet's full (inherently short) text via the API — "full".
 * - clip: is "unknown", not "full" — clip.ts's normalizeUrlClip can store
 *   empty content_text on a failed fetch or bot-challenge (fetchBlocked), and
 *   clip:text is exactly whatever the user typed, which may itself be a
 *   partial note. Neither case is record-specific evidence of completeness.
 * - anything else (e.g. feedbin:) has unconfirmed extraction completeness — "unknown".
 */
export function deriveSourceContentCompleteness(sourceKey: string): ContentCompleteness {
  if (sourceKey.startsWith("rss:")) return "excerpt";
  if (sourceKey.startsWith("gmail:")) return "full";
  if (sourceKey.startsWith("twitterapi:")) return "full";
  return "unknown";
}

export interface ArchiveRecordMeta {
  id: string;
  sourceKey: string;
  sourceItemId: string;
  canonicalUrl: string | null;
  title: string | null;
  author: string | null;
  sourceType: string;
  isGmailSource: boolean;
  sourceContentCompleteness: ContentCompleteness;
  publishedAt: string | null;
  collectedAt: string;
  updatedAt: string;
  sourceSummary: string | null;
  analystSummary: string | null;
  topicTags: string[];
  entities: unknown;
  enrichmentStatus: string;
  enrichmentMode: string;
  /** sha256 of content_text only — does not cover title/author/dates/other metadata. */
  contentHash: string;
}

export function toArchiveRecordMeta(row: ArchiveRecordBase): ArchiveRecordMeta {
  return {
    id: row.id,
    sourceKey: row.sourceKey,
    sourceItemId: row.sourceItemId,
    canonicalUrl: row.canonicalUrl,
    title: row.title,
    author: row.author,
    sourceType: row.sourceType,
    isGmailSource: deriveIsGmailSource(row.sourceKey),
    sourceContentCompleteness: deriveSourceContentCompleteness(row.sourceKey),
    publishedAt: row.publishedAt,
    collectedAt: row.collectedAt,
    updatedAt: row.updatedAt,
    sourceSummary: row.sourceSummary,
    analystSummary: row.analystSummary,
    topicTags: row.topicTags,
    entities: row.entities,
    enrichmentStatus: row.enrichmentStatus,
    enrichmentMode: row.enrichmentMode,
    contentHash: row.contentHash
  };
}

// --- Cursor codec -------------------------------------------------------------

const archiveCursorFiltersSchema = z.object({
  publishedAfter: z.string().nullable(),
  publishedBefore: z.string().nullable(),
  sourceType: z.string().nullable(),
  sourceKey: z.string().nullable(),
  updatedAfter: z.string().nullable()
});

const archiveCursorSchema = z.object({
  v: z.literal(1),
  filters: archiveCursorFiltersSchema,
  boundary: z.string(),
  after: z.object({ updatedAt: z.string(), id: z.string() })
});

export type ArchiveCursorFilters = z.infer<typeof archiveCursorFiltersSchema>;
export type ArchiveCursorPayload = z.infer<typeof archiveCursorSchema>;

export class ArchiveCursorError extends Error {}

export function encodeArchiveCursor(payload: ArchiveCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeArchiveCursor(cursor: string): ArchiveCursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ArchiveCursorError("Cursor is not valid base64url-encoded JSON.");
  }
  const result = archiveCursorSchema.safeParse(parsed);
  if (!result.success) {
    throw new ArchiveCursorError(`Cursor failed validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * A cursor is bound to the filters and scan boundary it was issued with. If
 * the caller also passes filter args alongside the cursor, they must match
 * exactly — this catches a client silently switching filters mid-scan rather
 * than starting a fresh one.
 */
export function validateCursorAgainstRequest(
  cursor: ArchiveCursorPayload,
  requested: {
    publishedAfter?: string;
    publishedBefore?: string;
    sourceType?: string;
    sourceKey?: string;
    updatedAfter?: string;
    updatedBefore?: string;
  }
): void {
  const checks: Array<[keyof ArchiveCursorFilters, string | undefined]> = [
    ["publishedAfter", requested.publishedAfter],
    ["publishedBefore", requested.publishedBefore],
    ["sourceType", requested.sourceType],
    ["sourceKey", requested.sourceKey],
    ["updatedAfter", requested.updatedAfter]
  ];
  for (const [key, value] of checks) {
    if (value !== undefined && value !== cursor.filters[key]) {
      throw new ArchiveCursorError(
        `Filter "${key}" (${JSON.stringify(value)}) does not match the value this cursor was issued with (${JSON.stringify(cursor.filters[key])}). Omit it to continue the existing scan, or omit the cursor to start a new one.`
      );
    }
  }
  if (requested.updatedBefore !== undefined && requested.updatedBefore !== cursor.boundary) {
    throw new ArchiveCursorError(
      `"updatedBefore" (${requested.updatedBefore}) does not match the scan boundary this cursor was issued with (${cursor.boundary}).`
    );
  }
}

// --- list_archive_items -------------------------------------------------------

export const listArchiveItemsInputShape = {
  publishedAfter: isoDateString().optional().describe(
    "Only include records with published_at >= this date/time (inclusive). Omit for no lower bound."
  ),
  publishedBefore: isoDateString().optional().describe(
    "Only include records with published_at < this date/time (exclusive). Omit for no upper bound."
  ),
  sourceType: z.enum(SOURCE_TYPES).optional().describe("Restrict to one source_type."),
  sourceKey: z.string().min(1).optional().describe(
    "Restrict to one exact source_key, e.g. \"rss:feed:<hash>\" or \"gmail:query:<hash>\"."
  ),
  updatedAfter: isoDateString().optional().describe(
    "Start (or resume) an incremental scan from records updated strictly after this time. Ignored once a cursor is supplied — pass the prior scan's scanBoundary here to begin the next incremental scan after a completed one."
  ),
  updatedBefore: isoDateString().optional().describe(
    "Fix the scan's upper time boundary explicitly instead of defaulting to (now - safety margin). Must match the cursor's boundary if a cursor is also supplied."
  ),
  pageSize: z.number().int().min(1).max(config.ARCHIVE_LIST_MAX_PAGE_SIZE).optional().describe(
    `Rows per page. Default ${config.ARCHIVE_LIST_DEFAULT_PAGE_SIZE}, max ${config.ARCHIVE_LIST_MAX_PAGE_SIZE}.`
  ),
  cursor: z.string().optional().describe(
    "Opaque continuation cursor from a previous call's nextCursor. Bound to the filters and scan boundary it was issued with; pass it alone (no other filter args) to continue that exact scan."
  )
};

const listArchiveItemsArgsSchema = z.object(listArchiveItemsInputShape);
export type ListArchiveItemsArgs = z.infer<typeof listArchiveItemsArgsSchema>;

export interface ListArchiveItemsResult {
  [key: string]: unknown;
  items: Array<ArchiveRecordMeta & {
    contentExcerpt: string | null;
    contentExcerptTruncated: boolean;
    contentTextLength: number;
  }>;
  nextCursor: string | null;
  scanBoundary: string;
  scanComplete: boolean;
  pageSize: number;
  resultType: "enumeration";
}

export async function listArchiveItems(rawArgs: ListArchiveItemsArgs): Promise<ListArchiveItemsResult> {
  const args = listArchiveItemsArgsSchema.parse(rawArgs);

  let filters: ArchiveCursorFilters;
  let boundary: string;
  let afterUpdatedAt: string | null;
  let afterId: string | null;

  if (args.cursor) {
    const decoded = decodeArchiveCursor(args.cursor);
    validateCursorAgainstRequest(decoded, {
      publishedAfter: toIsoOrUndefined(args.publishedAfter),
      publishedBefore: toIsoOrUndefined(args.publishedBefore),
      sourceType: args.sourceType ?? undefined,
      sourceKey: args.sourceKey ?? undefined,
      updatedAfter: toIsoOrUndefined(args.updatedAfter),
      updatedBefore: toIsoOrUndefined(args.updatedBefore)
    });
    filters = decoded.filters;
    boundary = decoded.boundary;
    afterUpdatedAt = decoded.after.updatedAt;
    afterId = decoded.after.id;
  } else {
    filters = {
      publishedAfter: toIso(args.publishedAfter),
      publishedBefore: toIso(args.publishedBefore),
      sourceType: args.sourceType ?? null,
      sourceKey: args.sourceKey ?? null,
      updatedAfter: toIso(args.updatedAfter)
    };
    boundary = args.updatedBefore
      ? new Date(args.updatedBefore).toISOString()
      : new Date(Date.now() - config.ARCHIVE_SCAN_BOUNDARY_SAFETY_MARGIN_MS).toISOString();
    afterUpdatedAt = filters.updatedAfter;
    afterId = filters.updatedAfter ? "0" : null;
  }

  const pageSize = Math.min(args.pageSize ?? config.ARCHIVE_LIST_DEFAULT_PAGE_SIZE, config.ARCHIVE_LIST_MAX_PAGE_SIZE);

  const rows = await listArchiveContent(
    {
      publishedAfter: filters.publishedAfter,
      publishedBefore: filters.publishedBefore,
      sourceType: (filters.sourceType as SourceType | null) ?? null,
      sourceKey: filters.sourceKey
    },
    { boundary, afterUpdatedAt, afterId },
    pageSize + 1
  );

  const page = rows.slice(0, pageSize);
  const hasMore = rows.length > pageSize;
  const excerptChars = config.ARCHIVE_LIST_EXCERPT_CHARS;

  const items = page.map((row: ArchiveContentRow) => ({
    ...toArchiveRecordMeta(row),
    contentExcerpt: row.contentText ? row.contentText.slice(0, excerptChars) : null,
    contentExcerptTruncated: row.contentText.length > excerptChars,
    contentTextLength: row.contentText.length
  }));

  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? encodeArchiveCursor({ v: 1, filters, boundary, after: { updatedAt: last.updatedAt, id: last.id } })
    : null;

  return {
    items,
    nextCursor,
    scanBoundary: boundary,
    scanComplete: !hasMore,
    pageSize,
    resultType: "enumeration"
  };
}

// --- search_archive -------------------------------------------------------

export const searchArchiveInputShape = {
  query: z.string().trim().min(1).describe("Search text."),
  mode: z.enum(["lexical", "semantic"]).optional().describe(
    "\"lexical\" (default) runs Postgres full-text search over stored title/content_text — no external calls, no cost. " +
    "\"semantic\" embeds the query via OpenAI (exactly one embedding API call; requires OPENAI_API_KEY) and ranks by cosine " +
    "similarity over stored embeddings. Neither mode generates an LLM answer — this is ranked retrieval only; use `brief` for a synthesized answer."
  ),
  publishedAfter: isoDateString().optional().describe(
    "Only include records with published_at >= this date/time (inclusive), applied before ranking/limiting."
  ),
  publishedBefore: isoDateString().optional().describe(
    "Only include records with published_at < this date/time (exclusive), applied before ranking/limiting."
  ),
  sourceType: z.enum(SOURCE_TYPES).optional().describe("Restrict to one source_type, applied before ranking/limiting."),
  sourceKey: z.string().min(1).optional().describe("Restrict to one exact source_key, applied before ranking/limiting."),
  limit: z.number().int().min(1).max(config.ARCHIVE_SEARCH_MAX_LIMIT).optional().describe(
    `Maximum ranked results. Default ${config.ARCHIVE_SEARCH_DEFAULT_LIMIT}, max ${config.ARCHIVE_SEARCH_MAX_LIMIT}.`
  )
};

const searchArchiveArgsSchema = z.object(searchArchiveInputShape);
export type SearchArchiveArgs = z.infer<typeof searchArchiveArgsSchema>;

export interface ArchiveEmbedder {
  embed(text: string): Promise<number[]>;
}

export interface SearchArchiveResult {
  [key: string]: unknown;
  resultType: "ranked_retrieval";
  mode: "lexical" | "semantic";
  embeddingCallMade: boolean;
  query: string;
  results: Array<ArchiveRecordMeta & { score: number; excerpt: string }>;
}

export async function searchArchive(rawArgs: SearchArchiveArgs, embedder?: ArchiveEmbedder): Promise<SearchArchiveResult> {
  const args = searchArchiveArgsSchema.parse(rawArgs);
  const mode = args.mode ?? "lexical";
  const filters = {
    publishedAfter: toIso(args.publishedAfter),
    publishedBefore: toIso(args.publishedBefore),
    sourceType: (args.sourceType as SourceType | undefined) ?? null,
    sourceKey: args.sourceKey ?? null
  };
  const limit = Math.min(args.limit ?? config.ARCHIVE_SEARCH_DEFAULT_LIMIT, config.ARCHIVE_SEARCH_MAX_LIMIT);
  const excerptChars = config.ARCHIVE_SEARCH_EXCERPT_CHARS;

  let rows: ArchiveSearchRow[];
  let embeddingCallMade = false;
  if (mode === "semantic") {
    if (!embedder) throw new Error("search_archive: semantic mode requires an embedder");
    const embedding = await embedder.embed(args.query);
    embeddingCallMade = true;
    rows = await searchArchiveSemantic(embedding, filters, excerptChars, limit);
  } else {
    rows = await searchArchiveLexical(args.query, filters, excerptChars, limit);
  }

  return {
    resultType: "ranked_retrieval",
    mode,
    embeddingCallMade,
    query: args.query,
    results: rows.map((row) => ({ ...toArchiveRecordMeta(row), score: row.score, excerpt: row.excerpt }))
  };
}

// --- get_archive_items -------------------------------------------------------

export const getArchiveItemsInputShape = {
  ids: z.array(z.string().min(1)).min(1).max(config.ARCHIVE_GET_MAX_IDS).describe(
    `Archive record ids to fetch verbatim — original stored content_text, no refetch/enrichment/clipping. Max ${config.ARCHIVE_GET_MAX_IDS} per call.`
  ),
  chunkIndex: z.number().int().min(0).optional().describe(
    `0-based index into each item's contentText, in fixed ${config.ARCHIVE_ITEM_CHUNK_CHARS}-character chunks (applies uniformly to every id in this call). ` +
    "Check totalChunks/isLastChunk on the response and re-call with the next chunkIndex to read the rest — text is never silently truncated."
  )
};

const getArchiveItemsArgsSchema = z.object(getArchiveItemsInputShape);
export type GetArchiveItemsArgs = z.infer<typeof getArchiveItemsArgsSchema>;

export interface GetArchiveItemsResult {
  [key: string]: unknown;
  items: Array<ArchiveRecordMeta & {
    contentText: string;
    contentTextLength: number;
    chunkIndex: number;
    chunkCharsPerChunk: number;
    totalChunks: number;
    isLastChunk: boolean;
  }>;
  missingIds: string[];
  chunkIndex: number;
  chunkCharsPerChunk: number;
}

export async function getArchiveItems(rawArgs: GetArchiveItemsArgs): Promise<GetArchiveItemsResult> {
  const args = getArchiveItemsArgsSchema.parse(rawArgs);
  const chunkIndex = args.chunkIndex ?? 0;
  const chunkChars = config.ARCHIVE_ITEM_CHUNK_CHARS;

  const rows = await getArchiveContentByIds(args.ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missingIds = args.ids.filter((id) => !byId.has(id));

  const items = args.ids
    .filter((id) => byId.has(id))
    .map((id) => {
      const row = byId.get(id)!;
      const totalChunks = Math.max(1, Math.ceil(row.contentText.length / chunkChars));
      const start = chunkIndex * chunkChars;
      return {
        ...toArchiveRecordMeta(row),
        contentText: row.contentText.slice(start, start + chunkChars),
        contentTextLength: row.contentText.length,
        chunkIndex,
        chunkCharsPerChunk: chunkChars,
        totalChunks,
        isLastChunk: chunkIndex >= totalChunks - 1
      };
    });

  return { items, missingIds, chunkIndex, chunkCharsPerChunk: chunkChars };
}
