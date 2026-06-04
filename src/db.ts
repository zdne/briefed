import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { config } from "./config.js";
import type { Enrichment, NormalizedEntry, RetrievedContent } from "./types.js";

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.DATABASE_URL });

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

export async function getSyncCursor(): Promise<string | undefined> {
  const result = await pool.query<{ value: string }>(
    "SELECT value FROM sync_state WHERE key = 'feedbin_entries_since'"
  );
  return result.rows[0]?.value;
}

export async function setSyncCursor(value: string): Promise<void> {
  await pool.query(
    `INSERT INTO sync_state(key, value) VALUES ('feedbin_entries_since', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [value]
  );
}

export async function upsertContent(entry: NormalizedEntry): Promise<{ id: string; needsEnrichment: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string; enrichment_status: string }>(
      `SELECT id, enrichment_status FROM content
       WHERE feedbin_entry_id = $1 OR ($2::text IS NOT NULL AND canonical_url = $2)
       ORDER BY feedbin_entry_id = $1 DESC
       LIMIT 1
       FOR UPDATE`,
      [entry.feedbinEntryId, entry.canonicalUrl]
    );

    let id: string;
    let needsEnrichment = true;
    if (existing.rows[0]) {
      id = existing.rows[0].id;
      needsEnrichment = existing.rows[0].enrichment_status !== "complete";
      await client.query(
        `UPDATE content SET
          feedbin_entry_id = $2, feed_id = $3, canonical_url = COALESCE($4, canonical_url),
          title = $5, author = $6, source_summary = $7, content_html = $8,
          content_text = $9, published_at = $10, feedbin_created_at = $11,
          raw_entry = $12, updated_at = now()
         WHERE id = $1`,
        [
          id, entry.feedbinEntryId, entry.feedId, entry.canonicalUrl, entry.title,
          entry.author, entry.sourceSummary, entry.contentHtml, entry.contentText,
          entry.publishedAt, entry.feedbinCreatedAt, entry.rawEntry
        ]
      );
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO content (
          feedbin_entry_id, feed_id, canonical_url, title, author, source_summary,
          content_html, content_text, published_at, feedbin_created_at, raw_entry
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          entry.feedbinEntryId, entry.feedId, entry.canonicalUrl, entry.title,
          entry.author, entry.sourceSummary, entry.contentHtml, entry.contentText,
          entry.publishedAt, entry.feedbinCreatedAt, entry.rawEntry
        ]
      );
      id = inserted.rows[0]!.id;
    }
    await client.query("COMMIT");
    return { id, needsEnrichment };
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
      embedding = $5::vector, enrichment_status = 'complete', enrichment_error = NULL,
      updated_at = now()
     WHERE id = $1`,
    [id, enrichment.summary, enrichment.topics, JSON.stringify(enrichment.entities), vectorLiteral(embedding)]
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

export async function recentContent(hours: number): Promise<RetrievedContent[]> {
  const result = await pool.query<RetrievedContent>(
    `SELECT id::text, title, canonical_url AS "canonicalUrl", author,
      published_at::text AS "publishedAt", analyst_summary AS summary, content_text AS "contentText",
      0::float AS score
     FROM content
     WHERE enrichment_status = 'complete' AND feedbin_created_at >= now() - ($1 * interval '1 hour')
     ORDER BY feedbin_created_at DESC`,
    [hours]
  );
  return result.rows;
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
