import { AnalystAI } from "./ai.js";
import {
  getSyncCursor,
  markEnrichmentFailed,
  markEnrichmentProcessing,
  saveEnrichment,
  setSyncCursor,
  upsertContent
} from "./db.js";
import { FeedbinClient } from "./feedbin.js";
import { normalizeEntry } from "./normalize.js";
import type { FeedbinEntry, NormalizedEntry } from "./types.js";

export interface SyncResult {
  fetched: number;
  insertedOrUpdated: number;
  enriched: number;
  enrichmentFailed: number;
  cursor?: string;
}

export type SyncLogger = (message: string) => void;

export async function enrichContent(id: string, entry: NormalizedEntry, ai: AnalystAI): Promise<void> {
  await markEnrichmentProcessing(id);
  try {
    const enrichment = await ai.enrich(entry.title, entry.contentText);
    const embeddingInput = [
      entry.title,
      enrichment.summary,
      enrichment.topics.join(", "),
      entry.contentText
    ]
      .filter(Boolean)
      .join("\n\n");
    const embedding = await ai.embed(embeddingInput);
    await saveEnrichment(id, enrichment, embedding);
  } catch (error) {
    await markEnrichmentFailed(id, error);
    throw error;
  }
}

export async function syncFeedbin(
  client: FeedbinClient,
  ai: AnalystAI,
  log: SyncLogger = () => {}
): Promise<SyncResult> {
  const since = await getSyncCursor();
  log(since ? `Starting incremental sync from ${since}` : "Starting initial sync of all Feedbin entries");
  const result: SyncResult = {
    fetched: 0,
    insertedOrUpdated: 0,
    enriched: 0,
    enrichmentFailed: 0,
    cursor: since
  };
  let newestCreatedAt = since;
  let pageNumber = 0;
  let totalEntries: number | null = null;

  for await (const page of client.entriesSince(since)) {
    pageNumber++;
    totalEntries ??= page.total;
    if (pageNumber === 1) {
      log(totalEntries === null ? "Feedbin did not provide a total entry count" : `${totalEntries} entries to sync`);
    }
    log(`Fetched page ${pageNumber} with ${page.entries.length} entries`);

    for (const raw of page.entries) {
      result.fetched++;
      newestCreatedAt = laterTimestamp(newestCreatedAt, raw);
      const entry = normalizeEntry(raw);
      const stored = await upsertContent(entry);
      result.insertedOrUpdated++;
      const label = entry.title ?? entry.canonicalUrl ?? `Feedbin entry ${entry.feedbinEntryId}`;
      const progress = formatProgress(result.fetched, totalEntries);
      log(`${progress} Stored: ${label}`);

      if (stored.needsEnrichment && entry.contentText) {
        log(`${progress} Enriching content ${stored.id}`);
        try {
          await enrichContent(stored.id, entry, ai);
          result.enriched++;
          log(`${progress} Enrichment complete`);
        } catch (error) {
          result.enrichmentFailed++;
          log(`${progress} Enrichment failed: ${errorMessage(error)}`);
        }
      } else if (!entry.contentText) {
        log(`${progress} Skipped enrichment: entry has no text content`);
      } else {
        log(`${progress} Skipped enrichment: already complete`);
      }
    }

    log(
      `Completed page ${pageNumber}: ${formatProgress(result.fetched, totalEntries)} fetched, ` +
      `${result.enriched} enriched, ` +
      `${result.enrichmentFailed} enrichment failures`
    );
  }

  if (newestCreatedAt && newestCreatedAt !== since) {
    await setSyncCursor(newestCreatedAt);
    result.cursor = newestCreatedAt;
    log(`Advanced Feedbin cursor to ${newestCreatedAt}`);
  } else {
    log("Feedbin cursor unchanged");
  }
  log("Sync complete");
  return result;
}

function laterTimestamp(current: string | undefined, entry: FeedbinEntry): string {
  if (!current) return entry.created_at;
  return Date.parse(entry.created_at) > Date.parse(current) ? entry.created_at : current;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatProgress(current: number, total: number | null): string {
  if (total === null || total === 0) return `[${current}]`;
  const percent = Math.min(100, Math.round((current / total) * 100));
  return `[${current}/${total} ${percent}%]`;
}
