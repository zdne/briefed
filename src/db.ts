import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { config } from "./config.js";
import type {
  ContentForEnrichment,
  DigestCandidate,
  DigestForRendering,
  Enrichment,
  SourceEntry,
  RetrievedContent
} from "./types.js";
import type { EnrichmentMode, SourceType } from "./enrichment-policy.js";

const { Pool } = pg;
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX
});

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const directory = resolve(process.cwd(), "migrations");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    const exists = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if (exists.rowCount) continue;
    const sql = await readFile(resolve(directory, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function getSyncCursorForKey(key: string): Promise<string | undefined> {
  const result = await pool.query<{ value: string }>(
    "SELECT value FROM sync_state WHERE key = $1",
    [key]
  );
  return result.rows[0]?.value;
}

export async function setSyncCursorForKey(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO sync_state(key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

export async function getSyncCursor(): Promise<string | undefined> {
  return getSyncCursorForKey("feedbin_entries_since");
}

export async function setSyncCursor(value: string): Promise<void> {
  await setSyncCursorForKey("feedbin_entries_since", value);
}

export async function resetSyncCursor(): Promise<void> {
  await pool.query("DELETE FROM sync_state WHERE key = 'feedbin_entries_since'");
}

export async function upsertSourceContent(
  entry: SourceEntry,
  sourceType: SourceType,
  desiredMode: EnrichmentMode
): Promise<{ id: string; needsEnrichment: boolean; isNew: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{
      id: string;
      enrichment_status: string;
      enrichment_mode: EnrichmentMode;
    }>(
      `SELECT id, enrichment_status, enrichment_mode FROM content
       WHERE (source_key = $1 AND source_item_id = $2)
          OR ($3::text IS NOT NULL AND canonical_url = $3)
       ORDER BY (source_key = $1 AND source_item_id = $2) DESC
       LIMIT 1
       FOR UPDATE`,
      [entry.sourceKey, entry.sourceItemId, entry.canonicalUrl]
    );

    let id: string;
    let needsEnrichment = true;
    if (existing.rows[0]) {
      id = existing.rows[0].id;
      needsEnrichment =
        existing.rows[0].enrichment_status !== "complete" ||
        (desiredMode === "full" && existing.rows[0].enrichment_mode !== "full");
      await client.query(
        `UPDATE content SET
          source_key = $2, source_item_id = $3, canonical_url = COALESCE($4, canonical_url),
          title = $5, author = $6, source_summary = $7, content_text = $8,
          published_at = $9, collected_at = $10, raw_entry = $11,
          source_type = $12, updated_at = now()
         WHERE id = $1`,
        [
          id, entry.sourceKey, entry.sourceItemId, entry.canonicalUrl, entry.title,
          entry.author, entry.sourceSummary, entry.contentText,
          entry.publishedAt, entry.collectedAt, entry.rawEntry, sourceType
        ]
      );
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO content (
          source_key, source_item_id, canonical_url, title, author, source_summary,
          content_text, published_at, collected_at, raw_entry,
          source_type, enrichment_mode
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          entry.sourceKey, entry.sourceItemId, entry.canonicalUrl, entry.title,
          entry.author, entry.sourceSummary, entry.contentText,
          entry.publishedAt, entry.collectedAt, entry.rawEntry, sourceType, desiredMode
        ]
      );
      id = inserted.rows[0]!.id;
    }
    await client.query("COMMIT");
    return { id, needsEnrichment, isNew: !existing.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markEnrichmentProcessing(id: string): Promise<void> {
  await pool.query(
    "UPDATE content SET enrichment_status = 'processing', enrichment_error = NULL WHERE id = $1",
    [id]
  );
}

export async function saveEnrichment(
  id: string,
  enrichment: Enrichment,
  embedding: number[]
): Promise<void> {
  await pool.query(
    `UPDATE content SET analyst_summary = $2, topic_tags = $3, entities = $4,
      embedding = $5::vector, enrichment_mode = 'full',
      enrichment_status = 'complete', enrichment_error = NULL,
      updated_at = now()
     WHERE id = $1`,
    [id, enrichment.summary, enrichment.topics, JSON.stringify(enrichment.entities), vectorLiteral(embedding)]
  );
}

export async function saveEmbeddedOnly(
  id: string,
  summary: string,
  embedding: number[]
): Promise<void> {
  await pool.query(
    `UPDATE content SET analyst_summary = $2, topic_tags = '{}', entities = '[]',
      embedding = $3::vector, enrichment_mode = 'embedded_only',
      enrichment_status = 'complete', enrichment_error = NULL, updated_at = now()
     WHERE id = $1`,
    [id, summary, vectorLiteral(embedding)]
  );
}

export async function markEnrichmentFailed(id: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `UPDATE content SET enrichment_status = 'failed', enrichment_error = $2, updated_at = now()
     WHERE id = $1`,
    [id, message.slice(0, 2000)]
  );
}

export interface EnrichmentCandidateFilters {
  sourceType?: SourceType;
  hours?: number;
  limit: number;
}

export async function enrichmentCandidates(
  filters: EnrichmentCandidateFilters
): Promise<ContentForEnrichment[]> {
  const result = await pool.query<ContentForEnrichment>(
    `SELECT id::text, title, source_summary AS "sourceSummary", content_text AS "contentText",
      source_type AS "sourceType", enrichment_mode AS "enrichmentMode"
     FROM content
     WHERE ($1::text IS NULL OR source_type = $1)
       AND ($2::int IS NULL OR collected_at >= now() - ($2 * interval '1 hour'))
       AND (
         enrichment_mode = 'embedded_only'
         OR enrichment_status IN ('pending', 'failed')
         OR (enrichment_status = 'processing' AND updated_at < now() - interval '15 minutes')
       )
       AND content_text <> ''
     ORDER BY collected_at DESC
     LIMIT $3`,
    [filters.sourceType ?? null, filters.hours ?? null, filters.limit]
  );
  return result.rows;
}

export interface ClipRow {
  id: string;
  title: string | null;
  canonicalUrl: string | null;
  summary: string | null;
  collectedAt: string;
  note: string | null;
}

export async function listClips(limit: number): Promise<ClipRow[]> {
  const result = await pool.query<{ id: string; title: string | null; canonicalUrl: string | null; summary: string | null; collectedAt: string; rawEntry: unknown }>(
    `SELECT id::text, title, canonical_url AS "canonicalUrl",
      analyst_summary AS summary, collected_at::text AS "collectedAt", raw_entry AS "rawEntry"
     FROM content
     WHERE source_key LIKE 'clip:%'
     ORDER BY collected_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    canonicalUrl: row.canonicalUrl,
    summary: row.summary,
    collectedAt: row.collectedAt,
    note: rawEntryNote(row.rawEntry)
  }));
}

export async function retrieveRelevantClips(embedding: number[], limit: number): Promise<RetrievedContent[]> {
  const result = await pool.query<RetrievedContent>(
    `SELECT id::text, title, canonical_url AS "canonicalUrl", author,
      published_at::text AS "publishedAt", analyst_summary AS summary, content_text AS "contentText",
      1 - (embedding <=> $1::vector) AS score
     FROM content
     WHERE embedding IS NOT NULL AND enrichment_status = 'complete'
       AND source_key LIKE 'clip:%'
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [vectorLiteral(embedding), limit]
  );
  return result.rows;
}

function rawEntryNote(rawEntry: unknown): string | null {
  if (!rawEntry || typeof rawEntry !== "object") return null;
  const entry = rawEntry as Record<string, unknown>;
  return typeof entry.note === "string" ? entry.note : null;
}

export async function retrieveRelevant(embedding: number[], limit: number): Promise<RetrievedContent[]> {
  const result = await pool.query<RetrievedContent>(
    `SELECT id::text, title, canonical_url AS "canonicalUrl", author,
      published_at::text AS "publishedAt", analyst_summary AS summary, content_text AS "contentText",
      1 - (embedding <=> $1::vector) AS score
     FROM content
     WHERE embedding IS NOT NULL AND enrichment_status = 'complete'
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [vectorLiteral(embedding), limit]
  );
  return result.rows;
}

export async function countRecentContent(hours: number, referenceTime = new Date()): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM content
     WHERE enrichment_status = 'complete'
       AND published_at >= $2::timestamptz - ($1 * interval '1 hour')
       AND published_at < $2::timestamptz`,
    [hours, referenceTime.toISOString()]
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function recentContent(hours: number, limit: number): Promise<RetrievedContent[]> {
  return recentDigestCandidates(hours, limit);
}

export async function recentDigestCandidates(
  hours: number,
  limit: number,
  referenceTime = new Date()
): Promise<DigestCandidate[]> {
  const result = await pool.query<DigestCandidate>(
    `SELECT id::text, title, canonical_url AS "canonicalUrl", author,
      published_at::text AS "publishedAt", analyst_summary AS summary, content_text AS "contentText",
      0::float AS score, source_type AS "sourceType", source_key AS "sourceKey",
      topic_tags AS "topicTags", entities, raw_entry AS "rawEntry"
     FROM content
     WHERE enrichment_status = 'complete'
       AND published_at >= $3::timestamptz - ($1 * interval '1 hour')
       AND published_at < $3::timestamptz
     ORDER BY published_at DESC, collected_at DESC
     LIMIT $2`,
    [hours, limit, referenceTime.toISOString()]
  );
  return result.rows;
}

export async function recentVectorMatches(
  embedding: number[],
  hours: number,
  limit: number,
  referenceTime = new Date()
): Promise<DigestCandidate[]> {
  const result = await pool.query<DigestCandidate>(
    `SELECT id::text, title, canonical_url AS "canonicalUrl", author,
      published_at::text AS "publishedAt", analyst_summary AS summary, content_text AS "contentText",
      1 - (embedding <=> $1::vector) AS score, source_type AS "sourceType", source_key AS "sourceKey",
      topic_tags AS "topicTags", entities, raw_entry AS "rawEntry"
     FROM content
     WHERE embedding IS NOT NULL
       AND enrichment_status = 'complete'
       AND published_at >= $4::timestamptz - ($2 * interval '1 hour')
       AND published_at < $4::timestamptz
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vectorLiteral(embedding), hours, limit, referenceTime.toISOString()]
  );
  return result.rows;
}

export async function recentDigestHistoryCandidates(
  hours: number,
  referenceTime = new Date(),
  currentPeriodStart?: Date,
  currentPeriodEnd?: Date
): Promise<DigestCandidate[]> {
  if (hours <= 0) return [];
  const overlapThreshold = SAME_DIGEST_WINDOW_OVERLAP_THRESHOLD;
  const currentStart = currentPeriodStart?.toISOString() ?? null;
  const currentEnd = currentPeriodEnd?.toISOString() ?? null;
  const result = await pool.query<DigestCandidate>(
    `SELECT DISTINCT ON (c.id) c.id::text, c.title, c.canonical_url AS "canonicalUrl", c.author,
      c.published_at::text AS "publishedAt", c.analyst_summary AS summary, c.content_text AS "contentText",
      0::float AS score, c.source_type AS "sourceType", c.source_key AS "sourceKey",
      c.topic_tags AS "topicTags", c.entities, c.raw_entry AS "rawEntry"
     FROM digests d
     CROSS JOIN LATERAL unnest(d.content_ids) AS u(content_id)
     JOIN content c ON c.id = u.content_id
     WHERE d.created_at >= $2::timestamptz - ($1 * interval '1 hour')
       AND d.created_at < $2::timestamptz
       AND (
         $3::timestamptz IS NULL
         OR $4::timestamptz IS NULL
         OR (
           GREATEST(
             0,
             EXTRACT(EPOCH FROM (LEAST(d.period_end, $4::timestamptz) - GREATEST(d.period_start, $3::timestamptz)))
           )
           / NULLIF(EXTRACT(EPOCH FROM ($4::timestamptz - $3::timestamptz)), 0)
         ) < $5
       )
       AND c.enrichment_status = 'complete'
     ORDER BY c.id, d.created_at DESC`,
    [hours, referenceTime.toISOString(), currentStart, currentEnd, overlapThreshold]
  );
  return result.rows;
}

export const SAME_DIGEST_WINDOW_OVERLAP_THRESHOLD = 0.8;

export function isSameDigestWindow(
  currentPeriodStart: Date,
  currentPeriodEnd: Date,
  priorPeriodStart: Date,
  priorPeriodEnd: Date,
  threshold = SAME_DIGEST_WINDOW_OVERLAP_THRESHOLD
): boolean {
  const currentDuration = currentPeriodEnd.getTime() - currentPeriodStart.getTime();
  if (currentDuration <= 0) return false;
  const overlapStart = Math.max(currentPeriodStart.getTime(), priorPeriodStart.getTime());
  const overlapEnd = Math.min(currentPeriodEnd.getTime(), priorPeriodEnd.getTime());
  const overlap = Math.max(0, overlapEnd - overlapStart);
  return overlap / currentDuration >= threshold;
}

export async function saveDigest(
  start: Date,
  end: Date,
  contentIds: string[],
  body: string
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO digests(period_start, period_end, content_ids, body)
     VALUES ($1, $2, $3::bigint[], $4) RETURNING id::text`,
    [start, end, contentIds, body]
  );
  return result.rows[0]!.id;
}

export async function getDigestForRendering(id?: number): Promise<DigestForRendering | null> {
  const digestResult = await pool.query<{
    id: string;
    periodStart: string;
    periodEnd: string;
    body: string;
    createdAt: string;
  }>(
    `SELECT id::text, period_start::text AS "periodStart", period_end::text AS "periodEnd",
      body, created_at::text AS "createdAt"
     FROM digests
     WHERE ($1::bigint IS NULL OR id = $1)
     ORDER BY created_at DESC
     LIMIT 1`,
    [id ?? null]
  );
  const digest = digestResult.rows[0];
  if (!digest) return null;

  const sourcesResult = await pool.query<{
    citation: number;
    id: string;
    title: string | null;
    url: string | null;
    author: string | null;
    publishedAt: string | null;
    summary: string | null;
  }>(
    `SELECT u.ordinality::int AS citation, c.id::text, c.title, c.canonical_url AS url,
      c.author, c.published_at::text AS "publishedAt", c.analyst_summary AS summary
     FROM digests d
     CROSS JOIN LATERAL unnest(d.content_ids) WITH ORDINALITY AS u(content_id, ordinality)
     JOIN content c ON c.id = u.content_id
     WHERE d.id = $1
     ORDER BY u.ordinality`,
    [digest.id]
  );

  return {
    id: digest.id,
    periodStart: new Date(digest.periodStart).toISOString(),
    periodEnd: new Date(digest.periodEnd).toISOString(),
    createdAt: new Date(digest.createdAt).toISOString(),
    body: digest.body,
    sources: sourcesResult.rows
  };
}
