import { AnalystAI } from "./ai.js";
import {
  enrichmentCandidates,
  getSyncCursor,
  markEnrichmentFailed,
  markEnrichmentProcessing,
  saveEmbeddedOnly,
  saveEnrichment,
  setSyncCursor,
  upsertContent
} from "./db.js";
import { config } from "./config.js";
import {
  desiredEnrichmentMode,
  detectSourceType,
  type SourceType
} from "./enrichment-policy.js";
import { FeedbinClient } from "./feedbin.js";
import { normalizeEntry } from "./normalize.js";
import type { ContentForEnrichment, FeedbinEntry, NormalizedEntry } from "./types.js";

export interface SyncResult {
  fetched: number;
  insertedOrUpdated: number;
  fullyEnriched: number;
  embeddedOnly: number;
  enrichmentFailed: number;
  cursor?: string;
}

export type SyncLogger = (message: string) => void;

export interface SyncOptions {
  since?: string;
}

export async function enrichContent(id: string, entry: NormalizedEntry, ai: AnalystAI): Promise<void> {
  return fullyEnrichContent(id, entry.title, entry.contentText, ai);
}

export async function fullyEnrichContent(
  id: string,
  title: string | null,
  contentText: string,
  ai: AnalystAI
): Promise<void> {
  await markEnrichmentProcessing(id);
  try {
    const enrichment = await ai.enrich(title, contentText);
    const embeddingInput = [
      title,
      enrichment.summary,
      enrichment.topics.join(", "),
      contentText
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

export async function embedOnlyContent(
  id: string,
  entry: Pick<NormalizedEntry, "title" | "sourceSummary" | "contentText">,
  ai: AnalystAI
): Promise<void> {
  await markEnrichmentProcessing(id);
  try {
    const summary = entry.sourceSummary ?? entry.title ?? entry.contentText.slice(0, 500);
    const embedding = await ai.embed([entry.title, entry.contentText].filter(Boolean).join("\n\n"));
    await saveEmbeddedOnly(id, summary, embedding);
  } catch (error) {
    await markEnrichmentFailed(id, error);
    throw error;
  }
}

export async function syncFeedbin(
  client: FeedbinClient,
  ai: AnalystAI,
  log: SyncLogger = () => {},
  options: SyncOptions = {}
): Promise<SyncResult> {
  const storedCursor = await getSyncCursor();
  const since = options.since ?? storedCursor;
  if (options.since) {
    log(`Starting sync with explicit lookback from ${since}`);
  } else {
    log(since ? `Starting incremental sync from ${since}` : "Starting initial sync of all Feedbin entries");
  }
  const result: SyncResult = {
    fetched: 0,
    insertedOrUpdated: 0,
    fullyEnriched: 0,
    embeddedOnly: 0,
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
      const sourceType = detectSourceType(entry);
      const mode = desiredEnrichmentMode(sourceType, config.LIGHTWEIGHT_SOURCE_TYPES);
      const stored = await upsertContent(entry, sourceType, mode);
      result.insertedOrUpdated++;
      const label = entry.title ?? entry.canonicalUrl ?? `Feedbin entry ${entry.feedbinEntryId}`;
      const progress = formatProgress(result.fetched, totalEntries);
      log(`${progress} Stored: ${label}`);

      if (stored.needsEnrichment && entry.contentText) {
        log(`${progress} Processing content ${stored.id} (${sourceType}, ${mode})`);
        try {
          if (mode === "embedded_only") {
            await embedOnlyContent(stored.id, entry, ai);
            result.embeddedOnly++;
            log(`${progress} Embedding-only processing complete`);
          } else {
            await enrichContent(stored.id, entry, ai);
            result.fullyEnriched++;
            log(`${progress} Full enrichment complete`);
          }
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
      `${result.fullyEnriched} fully enriched, ${result.embeddedOnly} embedded only, ` +
      `${result.enrichmentFailed} enrichment failures`
    );

    if (!page.hasNextPage && totalEntries !== null && result.fetched < totalEntries) {
      throw new Error(
        `Incomplete Feedbin pagination: fetched ${result.fetched} of ${totalEntries} entries; ` +
        "cursor was not advanced"
      );
    }
  }

  if (result.fetched > 0 && newestCreatedAt && newestCreatedAt !== storedCursor) {
    await setSyncCursor(newestCreatedAt);
    result.cursor = newestCreatedAt;
    log(`Advanced Feedbin cursor to ${newestCreatedAt}`);
  } else {
    log("Feedbin cursor unchanged");
  }
  log("Sync complete");
  return result;
}

export function lookbackSince(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

export interface EnrichStoredOptions {
  sourceType?: SourceType;
  hours?: number;
  limit: number;
}

export async function enrichStoredContent(
  options: EnrichStoredOptions,
  ai: AnalystAI,
  log: SyncLogger = () => {}
): Promise<{ selected: number; enriched: number; failed: number }> {
  const candidates = await enrichmentCandidates(options);
  const result = { selected: candidates.length, enriched: 0, failed: 0 };
  log(`Selected ${candidates.length} stored entries for full enrichment`);

  for (const [index, candidate] of candidates.entries()) {
    const progress = formatProgress(index + 1, candidates.length);
    log(`${progress} Fully enriching: ${candidate.title ?? `content ${candidate.id}`}`);
    try {
      await fullyEnrichCandidate(candidate, ai);
      result.enriched++;
      log(`${progress} Full enrichment complete`);
    } catch (error) {
      result.failed++;
      log(`${progress} Full enrichment failed: ${errorMessage(error)}`);
    }
  }
  log("Stored-content enrichment complete");
  return result;
}

async function fullyEnrichCandidate(candidate: ContentForEnrichment, ai: AnalystAI): Promise<void> {
  await fullyEnrichContent(candidate.id, candidate.title, candidate.contentText, ai);
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
