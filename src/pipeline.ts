import { AnalystAI } from "./ai.js";
import {
  enrichmentCandidates,
  getSyncCursor,
  getSyncCursorForKey,
  markEnrichmentFailed,
  markEnrichmentProcessing,
  saveEmbeddedOnly,
  saveEnrichment,
  setSyncCursor,
  setSyncCursorForKey,
  upsertSourceContent
} from "./db.js";
import { config } from "./config.js";
import {
  desiredEnrichmentMode,
  detectSourceType,
  type SourceType
} from "./enrichment-policy.js";
import { FeedbinClient } from "./feedbin.js";
import { loadRssFeeds, type RssFeedConfig } from "./rss-feeds.js";
import {
  filterNewRssItems,
  nextRssFeedState,
  parseRssXml,
  redditRssAuthMode,
  retryAfterFromRateLimit,
  RssClient,
  RssRateLimitError,
  rssFeedHash,
  shouldSkipFeedForRetry,
  type ParsedFeedItem,
  type RssFeedState
} from "./rss.js";
import { normalizeEntry } from "./normalize.js";
import {
  buildGmailQuery,
  GmailClient,
  gmailSourceKey,
  messageInternalDate,
  normalizeGmailMessage
} from "./gmail.js";
import { normalizeTwitterTweet } from "./twitter-normalize.js";
import { TwitterApiClient } from "./twitterapi.js";
import type { ContentForEnrichment, FeedbinEntry, SourceEntry } from "./types.js";

export interface SyncResult {
  fetched: number;
  insertedOrUpdated: number;
  fullyEnriched: number;
  embeddedOnly: number;
  enrichmentFailed: number;
  cursor?: string;
  twitterLists?: TwitterListSyncSummary[];
  rssFeeds?: RssFeedSyncSummary[];
  gmail?: GmailSyncSummary;
}

export type SyncLogger = (message: string) => void;

export interface SyncOptions {
  since?: string;
}

export interface TwitterSyncOptions {
  listIds: string[];
  maxPages: number;
  maxTweets: number;
}

export interface TwitterListSyncSummary {
  listId: string;
  storedLatestId?: string;
  newestId?: string;
  pagesFetched: number;
  tweetsReturned: number;
  tweetsProcessed: number;
  stoppedReason: "stored_latest_reached" | "max_pages" | "max_tweets" | "no_next_page" | "empty_page";
  hasNextPage?: boolean;
  nextCursorPresent?: boolean;
}

export interface RssSyncOptions {
  feedsPath: string;
  hours?: number;
  fetchDelayMs: number;
  redditFetchDelayMs: number;
  redditUser?: string;
  redditFeed?: string;
  maxItemsPerFeed: number;
  userAgent: string;
  requestTimeoutMs: number;
}

export interface RssFeedSyncSummary {
  title: string;
  url: string;
  fetched: boolean;
  parsedItems: number;
  processedItems: number;
  overflowCount: number;
  redditAuthMode?: "user_feed_params" | "none" | "fallback_none";
  skippedReason?: "retry_after" | "domain_retry_after";
  error?: string;
}

export interface GmailSyncOptions {
  query: string;
  hours?: number;
  maxMessages: number;
}

export interface GmailSyncSummary {
  query: string;
  effectiveQuery: string;
  messagesReturned: number;
  messagesProcessed: number;
  cursor?: string;
}

export async function enrichContent(id: string, entry: SourceEntry, ai: AnalystAI): Promise<void> {
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
  entry: Pick<SourceEntry, "title" | "sourceSummary" | "contentText">,
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
      const label = entry.title ?? entry.canonicalUrl ?? `${entry.sourceKey}:${entry.sourceItemId}`;
      const progress = formatProgress(result.fetched, totalEntries);
      await storeAndProcessEntry(entry, sourceType, mode, ai, result, progress, log, label);
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

export async function syncRssFeeds(
  options: RssSyncOptions,
  ai: AnalystAI,
  log: SyncLogger = () => {}
): Promise<SyncResult> {
  const feeds = await loadRssFeeds(options.feedsPath);
  const client = new RssClient({
    userAgent: options.userAgent,
    timeoutMs: options.requestTimeoutMs,
    redditUser: options.redditUser,
    redditFeed: options.redditFeed
  });
  const result: SyncResult = {
    fetched: 0,
    insertedOrUpdated: 0,
    fullyEnriched: 0,
    embeddedOnly: 0,
    enrichmentFailed: 0,
    rssFeeds: []
  };
  let successfulFeeds = 0;
  log(`Loaded ${feeds.length} RSS feed(s) from ${options.feedsPath}`);

  let previousFetchedFeed: RssFeedConfig | undefined;
  for (const feed of feeds) {
    const summary: RssFeedSyncSummary = {
      title: feed.title,
      url: feed.url,
      fetched: false,
      parsedItems: 0,
      processedItems: 0,
      overflowCount: 0,
      redditAuthMode: rssRetryDomain(feed) === "reddit.com"
        ? redditRssAuthMode({ redditUser: options.redditUser, redditFeed: options.redditFeed })
        : undefined
    };
    result.rssFeeds!.push(summary);

    const stateKey = rssFeedStateKey(feed);
    const previousState = await readRssFeedState(stateKey);
    const domainStateKey = rssDomainStateKey(feed);
    const previousDomainState = domainStateKey ? await readRssFeedState(domainStateKey) : {};
    if (shouldSkipFeedForRetry(previousState)) {
      summary.skippedReason = "retry_after";
      log(`Skipping RSS feed ${feed.title}: retry-after active until ${previousState.retryAfter}`);
      continue;
    }
    if (shouldSkipFeedForRetry(previousDomainState)) {
      summary.skippedReason = "domain_retry_after";
      log(`Skipping RSS feed ${feed.title}: domain retry-after active until ${previousDomainState.retryAfter}`);
      continue;
    }

    try {
      if (previousFetchedFeed) {
        const delay = rssDelayForFeed(feed, options);
        if (delay > 0) await sleep(delay);
      }
      previousFetchedFeed = feed;
      log(`Fetching RSS feed ${feed.title}`);
      const fetched = await client.fetchFeed(feed);
      summary.fetched = true;
      if (summary.redditAuthMode !== undefined) {
        summary.redditAuthMode = fetched.redditAuthMode;
      }
      const now = new Date();
      const nowIso = now.toISOString();
      if (domainStateKey) {
        const domainRetryAfter = retryAfterFromRateLimit(fetched.rateLimit, now);
        if (domainRetryAfter) {
          await setSyncCursorForKey(
            domainStateKey,
            JSON.stringify({
              ...previousDomainState,
              lastError: null,
              redditAuthMode: summary.redditAuthMode,
              retryAfter: domainRetryAfter
            })
          );
          log(`RSS domain ${rssRetryDomain(feed)} rate limit exhausted; pausing until ${domainRetryAfter}`);
        }
      }
      const parsed = parseRssXml(fetched.xml, feed, nowIso);
      const parsedItems = parsed.items.sort(compareParsedNewestFirst);
      summary.parsedItems = parsedItems.length;
      const selected = filterNewRssItems(parsedItems, previousState, {
        hours: options.hours,
        maxItems: options.maxItemsPerFeed,
        referenceTime: now
      });
      summary.overflowCount = selected.overflowCount;
      log(
        `RSS feed ${feed.title}: ${parsedItems.length} parsed, ` +
        `${selected.items.length} selected, ${selected.overflowCount} overflow`
      );

      for (const [itemIndex, item] of selected.items.entries()) {
        result.fetched++;
        summary.processedItems++;
        await processSourceEntry(
          item.sourceEntry,
          ai,
          result,
          `[${itemIndex + 1}/${selected.items.length}]`,
          log
        );
      }

      await setSyncCursorForKey(
        stateKey,
        JSON.stringify({
          ...nextRssFeedState(previousState, selected.items, nowIso, selected.overflowCount),
          redditAuthMode: summary.redditAuthMode
        })
      );
      successfulFeeds++;
    } catch (error) {
      summary.error = errorMessage(error);
      await setSyncCursorForKey(stateKey, JSON.stringify({
        ...failedRssFeedState(previousState, error),
        redditAuthMode: summary.redditAuthMode
      }));
      if (domainStateKey && error instanceof RssRateLimitError) {
        await setSyncCursorForKey(domainStateKey, JSON.stringify({
          ...failedRssFeedState(previousDomainState, error),
          redditAuthMode: summary.redditAuthMode
        }));
      }
      log(`RSS feed ${feed.title} failed: ${summary.error}`);
    }
  }

  if (feeds.length > 0 && successfulFeeds === 0) {
    throw new Error("All enabled RSS feeds failed or were skipped");
  }

  log("RSS sync complete");
  return result;
}

export async function syncGmail(
  client: GmailClient,
  options: GmailSyncOptions,
  ai: AnalystAI,
  log: SyncLogger = () => {}
): Promise<SyncResult> {
  const cursorKey = gmailCursorKey(options.query);
  const storedCursor = await getSyncCursorForKey(cursorKey);
  const lookback = options.hours === undefined ? undefined : lookbackSince(new Date(), options.hours);
  const since = lookback ?? storedCursor;
  const effectiveQuery = buildGmailQuery(options.query, since);
  const result: SyncResult = {
    fetched: 0,
    insertedOrUpdated: 0,
    fullyEnriched: 0,
    embeddedOnly: 0,
    enrichmentFailed: 0,
    gmail: {
      query: options.query,
      effectiveQuery,
      messagesReturned: 0,
      messagesProcessed: 0,
      cursor: storedCursor
    }
  };

  log(`Listing Gmail messages with query: ${effectiveQuery}`);
  const messageIds = await client.listMessages(effectiveQuery, options.maxMessages);
  result.gmail!.messagesReturned = messageIds.length;
  let newestInternalDate = storedCursor;

  for (const [index, id] of messageIds.entries()) {
    log(`[${index + 1}/${messageIds.length}] Fetching Gmail message ${id}`);
    const message = await client.getMessage(id);
    const internalDate = messageInternalDate(message);
    if (storedCursor && !lookback && internalDate && Date.parse(internalDate) <= Date.parse(storedCursor)) {
      continue;
    }
    const entry = normalizeGmailMessage(message, options.query, new Date().toISOString());
    result.fetched++;
    result.gmail!.messagesProcessed++;
    await processSourceEntry(
      entry,
      ai,
      result,
      `[${index + 1}/${messageIds.length}]`,
      log
    );
    if (internalDate && (!newestInternalDate || Date.parse(internalDate) > Date.parse(newestInternalDate))) {
      newestInternalDate = internalDate;
    }
  }

  if (newestInternalDate && newestInternalDate !== storedCursor) {
    await setSyncCursorForKey(cursorKey, newestInternalDate);
    result.cursor = newestInternalDate;
    result.gmail!.cursor = newestInternalDate;
    log(`Advanced Gmail cursor to ${newestInternalDate}`);
  } else {
    log("Gmail cursor unchanged");
  }

  log("Gmail sync complete");
  return result;
}

export async function syncTwitterLists(
  client: TwitterApiClient,
  ai: AnalystAI,
  options: TwitterSyncOptions,
  log: SyncLogger = () => {}
): Promise<SyncResult> {
  const result: SyncResult = {
    fetched: 0,
    insertedOrUpdated: 0,
    fullyEnriched: 0,
    embeddedOnly: 0,
    enrichmentFailed: 0,
    twitterLists: []
  };

  for (const listId of options.listIds) {
    const cursorKey = twitterListCursorKey(listId);
    const storedLatestId = await getSyncCursorForKey(cursorKey);
    let newestId: string | undefined;
    let cursor: string | undefined;
    let seenStoredLatest = false;
    let listFetched = 0;
    const summary: TwitterListSyncSummary = {
      listId,
      storedLatestId,
      pagesFetched: 0,
      tweetsReturned: 0,
      tweetsProcessed: 0,
      stoppedReason: "max_pages"
    };

    log(storedLatestId
      ? `Starting Twitter list ${listId} sync until stored latest tweet ${storedLatestId}`
      : `Starting initial Twitter list ${listId} sync`);

    for (let pageNumber = 1; pageNumber <= options.maxPages; pageNumber++) {
      if (listFetched >= options.maxTweets) {
        log(`Stopped Twitter list ${listId} sync at max tweets ${options.maxTweets}`);
        summary.stoppedReason = "max_tweets";
        break;
      }

      const page = await client.listTimeline(listId, cursor);
      const tweets = page.tweets ?? [];
      summary.pagesFetched++;
      summary.tweetsReturned += tweets.length;
      summary.hasNextPage = page.has_next_page;
      summary.nextCursorPresent = Boolean(page.next_cursor);
      log(
        `Fetched Twitter list ${listId} page ${pageNumber} with ${tweets.length} tweets ` +
        `(has_next_page=${Boolean(page.has_next_page)}, next_cursor=${page.next_cursor ? "present" : "missing"})`
      );
      if (tweets.length === 0) {
        summary.stoppedReason = "empty_page";
        log(`Stopped Twitter list ${listId} sync because page ${pageNumber} returned no tweets`);
        break;
      }

      for (const tweet of tweets) {
        if (listFetched >= options.maxTweets) break;
        if (storedLatestId && tweet.id === storedLatestId) {
          seenStoredLatest = true;
          summary.stoppedReason = "stored_latest_reached";
          log(`Reached stored latest tweet ${storedLatestId} for Twitter list ${listId}`);
          break;
        }

        newestId ??= tweet.id;
        listFetched++;
        summary.tweetsProcessed++;
        result.fetched++;
        const entry = normalizeTwitterTweet(tweet, listId);
        const mode = desiredEnrichmentMode("twitter", config.LIGHTWEIGHT_SOURCE_TYPES);
        const label = entry.title ?? entry.canonicalUrl ?? `${entry.sourceKey}:${entry.sourceItemId}`;
        await storeAndProcessEntry(
          entry,
          "twitter",
          mode,
          ai,
          result,
          formatProgress(result.fetched, null),
          log,
          label
        );
      }

      if (listFetched >= options.maxTweets) {
        summary.stoppedReason = "max_tweets";
        log(`Stopped Twitter list ${listId} sync at max tweets ${options.maxTweets}`);
        break;
      }
      if (seenStoredLatest) break;
      if (!page.has_next_page) {
        summary.stoppedReason = "no_next_page";
        log(`Stopped Twitter list ${listId} sync because API reported no next page`);
        break;
      }
      if (!page.next_cursor) {
        summary.stoppedReason = "no_next_page";
        log(`Stopped Twitter list ${listId} sync because API did not return a next cursor`);
        break;
      }
      cursor = page.next_cursor;
    }

    if (newestId && newestId !== storedLatestId) {
      await setSyncCursorForKey(cursorKey, newestId);
      result.cursor = newestId;
      summary.newestId = newestId;
      log(`Advanced Twitter list ${listId} cursor to ${newestId}`);
    } else {
      log(`Twitter list ${listId} cursor unchanged`);
    }
    result.twitterLists!.push(summary);
    log(
      `Twitter list ${listId} summary: ${summary.pagesFetched} page(s), ` +
      `${summary.tweetsReturned} tweet(s) returned, ${summary.tweetsProcessed} processed, ` +
      `stopped_reason=${summary.stoppedReason}`
    );
  }

  log("Twitter sync complete");
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

function rssFeedStateKey(feed: RssFeedConfig): string {
  return `rss:feed:${rssFeedHash(feed.normalizedUrl)}:state`;
}

function rssDomainStateKey(feed: RssFeedConfig): string | undefined {
  const domain = rssRetryDomain(feed);
  return domain ? `rss:domain:${domain}:state` : undefined;
}

function rssDelayForFeed(feed: RssFeedConfig, options: RssSyncOptions): number {
  return rssRetryDomain(feed) === "reddit.com"
    ? Math.max(options.fetchDelayMs, options.redditFetchDelayMs)
    : options.fetchDelayMs;
}

function rssRetryDomain(feed: RssFeedConfig): string | undefined {
  try {
    const hostname = new URL(feed.normalizedUrl).hostname.toLowerCase();
    if (hostname === "reddit.com" || hostname.endsWith(".reddit.com")) return "reddit.com";
    return undefined;
  } catch {
    return undefined;
  }
}

function gmailCursorKey(query: string): string {
  return `${gmailSourceKey(query)}:latest_internal_date`;
}

async function readRssFeedState(key: string): Promise<RssFeedState> {
  const raw = await getSyncCursorForKey(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as RssFeedState;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function failedRssFeedState(previous: RssFeedState, error: unknown): RssFeedState {
  return {
    ...previous,
    lastError: errorMessage(error),
    retryAfter: error instanceof RssRateLimitError ? error.retryAfter : previous.retryAfter ?? null
  };
}

function compareParsedNewestFirst(a: ParsedFeedItem, b: ParsedFeedItem): number {
  return timeValue(b.publishedAt) - timeValue(a.publishedAt);
}

function timeValue(value: string | null): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatProgress(current: number, total: number | null): string {
  if (total === null || total === 0) return `[${current}]`;
  const percent = Math.min(100, Math.round((current / total) * 100));
  return `[${current}/${total} ${percent}%]`;
}

export async function processSourceEntry(
  entry: SourceEntry,
  ai: AnalystAI,
  result: Pick<SyncResult, "insertedOrUpdated" | "fullyEnriched" | "embeddedOnly" | "enrichmentFailed">,
  progress: string,
  log: SyncLogger
): Promise<void> {
  const sourceType = detectSourceType(entry);
  const mode = desiredEnrichmentMode(sourceType, config.LIGHTWEIGHT_SOURCE_TYPES);
  const label = entry.title ?? entry.canonicalUrl ?? `${entry.sourceKey}:${entry.sourceItemId}`;
  await storeAndProcessEntry(entry, sourceType, mode, ai, result, progress, log, label);
}

async function storeAndProcessEntry(
  entry: SourceEntry,
  sourceType: SourceType,
  mode: "full" | "embedded_only",
  ai: AnalystAI,
  result: Pick<SyncResult, "insertedOrUpdated" | "fullyEnriched" | "embeddedOnly" | "enrichmentFailed">,
  progress: string,
  log: SyncLogger,
  label: string
): Promise<void> {
  const stored = await upsertSourceContent(entry, sourceType, mode);
  result.insertedOrUpdated++;
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
      if (isFatalProviderError(error)) {
        throw new Error(`Stopping sync after provider failure: ${errorMessage(error)}`);
      }
    }
  } else if (!entry.contentText) {
    log(`${progress} Skipped enrichment: entry has no text content`);
  } else {
    log(`${progress} Skipped enrichment: already complete`);
  }
}

export function isFatalProviderError(error: unknown): boolean {
  const candidate = error as { status?: unknown; code?: unknown; type?: unknown };
  const status = typeof candidate.status === "number" ? candidate.status : undefined;
  const code = typeof candidate.code === "string" ? candidate.code.toLowerCase() : "";
  const type = typeof candidate.type === "string" ? candidate.type.toLowerCase() : "";
  const message = errorMessage(error).toLowerCase();

  return (
    status === 401 ||
    status === 403 ||
    status === 429 ||
    code === "insufficient_quota" ||
    code === "invalid_api_key" ||
    code === "rate_limit_exceeded" ||
    type.includes("authentication") ||
    type.includes("permission") ||
    message.includes("exceeded your current quota") ||
    message.includes("insufficient_quota") ||
    message.includes("invalid api key") ||
    message.includes("incorrect api key") ||
    message.includes("billing")
  );
}

function twitterListCursorKey(listId: string): string {
  return `twitterapi:list:${listId}:latest_id`;
}
