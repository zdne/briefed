import { XMLParser } from "fast-xml-parser";
import { canonicalizeUrl, htmlToPlainText } from "./normalize.js";
import {
  createRedditRssContext,
  isRedditUrl,
  redactRedditRssUrl,
  type RedditRssAuthMode,
  type RedditRssContext
} from "./reddit-rss.js";
import { stableHash } from "./source-utils.js";
import type { SourceEntry } from "./types.js";
import type { RssFeedConfig } from "./rss-feeds.js";

export interface RssClientOptions {
  userAgent: string;
  timeoutMs: number;
  redditUser?: string;
  redditFeed?: string;
  debug?: boolean;
  debugLog?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

export interface RssFeedState {
  lastSuccessAt?: string;
  lastError?: string | null;
  retryAfter?: string | null;
  newestPublishedAt?: string | null;
  recentItemIds?: string[];
  lastOverflowCount?: number;
  redditAuthMode?: RedditRssAuthMode;
}

export interface ParsedFeedItem {
  sourceItemId: string;
  publishedAt: string | null;
  sourceEntry: SourceEntry;
}

export interface ParsedRssFeed {
  title: string | null;
  siteUrl: string | null;
  items: ParsedFeedItem[];
}

export interface RssFetchResult {
  xml: string;
  rateLimit: RssRateLimitHeaders;
  redditAuthMode: RedditRssAuthMode;
}

export interface RssRateLimitHeaders {
  remaining: number | null;
  resetSeconds: number | null;
  retryAfter: string | null;
}

export class RssClient {
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly reddit: RedditRssContext;

  constructor(options: RssClientOptions) {
    this.userAgent = options.userAgent;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.reddit = createRedditRssContext({
      userAgent: this.userAgent,
      redditUser: options.redditUser,
      redditFeed: options.redditFeed,
      debug: options.debug ?? false,
      debugLog: options.debugLog ?? (() => {}),
      fetchImpl: this.fetchImpl
    });
  }

  async fetchFeed(feed: RssFeedConfig): Promise<RssFetchResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const isReddit = isRedditUrl(feed.url);
    const requestUrl = isReddit ? this.reddit.prepareUrl(feed.url) : feed.url;
    try {
      let response = await this.request(requestUrl, controller.signal);
      let redditAuthMode: RssFetchResult["redditAuthMode"] = isReddit ? this.reddit.authMode : "none";
      let effectiveUrl = requestUrl;

      const rateLimit = parseRateLimitHeaders(response.headers);
      if (response.status === 429) {
        const retryAfter = rateLimit.retryAfter ?? defaultRetryAfter();
        throw new RssRateLimitError(feed.url, retryAfter);
      }
      if (response.status === 403 && isReddit) {
        throw this.reddit.accessError(feed.url, defaultRetryAfter(), await shortResponseText(response));
      }
      if (!response.ok) {
        throw new Error(`RSS request failed (${response.status}) for ${redactRedditRssUrl(effectiveUrl)}: ${await shortResponseText(response)}`);
      }
      return {
        xml: await response.text(),
        rateLimit,
        redditAuthMode
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request(url: string, signal: AbortSignal): Promise<Response> {
    const baseHeaders = {
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      "User-Agent": this.userAgent
    };
    const headers = isRedditUrl(url)
      ? await this.reddit.prepareHeaders(url, baseHeaders)
      : baseHeaders;
    const response = await this.fetchImpl(url, {
      redirect: "follow",
      signal,
      headers
    });
    if (isRedditUrl(url)) this.reddit.logResponse(url, response);
    return response;
  }
}

export class RssRateLimitError extends Error {
  constructor(
    url: string,
    readonly retryAfter: string | null
  ) {
    super(`RSS feed rate limited: ${url}`);
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  trimValues: true
});

export function parseRssXml(xml: string, feed: RssFeedConfig, collectedAt: string): ParsedRssFeed {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  if (isRecord(parsed.rss)) return parseRss2(parsed.rss, feed, collectedAt);
  if (isRecord(parsed.feed)) return parseAtom(parsed.feed, feed, collectedAt);
  throw new Error("Unsupported feed format: expected RSS or Atom XML");
}

export function rssFeedHash(feedUrl: string): string {
  return stableHash(feedUrl);
}

export function rssSourceKey(feedUrl: string): string {
  return `rss:feed:${rssFeedHash(feedUrl)}`;
}

export function shouldSkipFeedForRetry(state: RssFeedState, now = new Date()): boolean {
  return Boolean(state.retryAfter && Date.parse(state.retryAfter) > now.getTime());
}

export function filterNewRssItems(
  items: ParsedFeedItem[],
  state: RssFeedState,
  options: { hours?: number; maxItems: number; referenceTime: Date }
): { items: ParsedFeedItem[]; overflowCount: number } {
  const sinceTime = options.hours === undefined
    ? undefined
    : options.referenceTime.getTime() - options.hours * 60 * 60 * 1000;
  const newestTime = state.newestPublishedAt ? Date.parse(state.newestPublishedAt) : undefined;
  const recentIds = new Set(state.recentItemIds ?? []);

  const candidates = items
    .filter((item) => {
      const publishedTime = item.publishedAt ? Date.parse(item.publishedAt) : Number.NaN;
      if (sinceTime !== undefined && (!Number.isFinite(publishedTime) || publishedTime < sinceTime)) {
        return false;
      }
      if (!Number.isFinite(publishedTime)) return !recentIds.has(item.sourceItemId);
      if (newestTime === undefined || !Number.isFinite(publishedTime)) return true;
      if (publishedTime > newestTime) return true;
      return publishedTime === newestTime && !recentIds.has(item.sourceItemId);
    })
    .sort(compareNewestFirst);

  return {
    items: candidates.slice(0, options.maxItems),
    overflowCount: Math.max(0, candidates.length - options.maxItems)
  };
}

export function nextRssFeedState(
  previous: RssFeedState,
  processedItems: ParsedFeedItem[],
  nowIso: string,
  overflowCount: number
): RssFeedState {
  const newestPublishedAt = processedItems
    .map((item) => item.publishedAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? previous.newestPublishedAt ?? null;
  const recentItemIds = [
    ...processedItems.map((item) => item.sourceItemId),
    ...(previous.recentItemIds ?? [])
  ].slice(0, 200);

  return {
    lastSuccessAt: nowIso,
    lastError: null,
    retryAfter: null,
    newestPublishedAt,
    recentItemIds: [...new Set(recentItemIds)],
    lastOverflowCount: overflowCount
  };
}

function parseRss2(rss: Record<string, unknown>, feed: RssFeedConfig, collectedAt: string): ParsedRssFeed {
  const channel = asRecord(rss.channel);
  const items = asArray(channel.item).map((item) => normalizeRssItem(asRecord(item), feed, channel, collectedAt));
  return {
    title: stringValue(channel.title),
    siteUrl: stringValue(channel.link),
    items
  };
}

function parseAtom(atom: Record<string, unknown>, feed: RssFeedConfig, collectedAt: string): ParsedRssFeed {
  const items = asArray(atom.entry).map((entry) => normalizeAtomItem(asRecord(entry), feed, atom, collectedAt));
  return {
    title: stringValue(atom.title),
    siteUrl: atomLink(atom.link),
    items
  };
}

function normalizeRssItem(
  item: Record<string, unknown>,
  feed: RssFeedConfig,
  feedMetadata: Record<string, unknown>,
  collectedAt: string
): ParsedFeedItem {
  const link = stringValue(item.link);
  const canonicalUrl = canonicalizeUrl(link);
  const title = stringValue(item.title);
  const publishedAt = parseDateValue(item.pubDate ?? item.published ?? item.updated ?? item["dc:date"]);
  const summary = htmlToMaybeText(stringValue(item.description));
  const content = htmlToMaybeText(
    stringValue(item["content:encoded"]) ??
    stringValue(item.content) ??
    stringValue(item.description) ??
    title ??
    ""
  ) ?? title ?? "";
  const sourceItemId = itemId(
    stringValue(item.guid),
    canonicalUrl,
    feed.normalizedUrl,
    title,
    publishedAt
  );

  return {
    sourceItemId,
    publishedAt,
    sourceEntry: {
      sourceKey: rssSourceKey(feed.normalizedUrl),
      sourceItemId,
      canonicalUrl,
      title,
      author: stringValue(item.author) ?? stringValue(item["dc:creator"]),
      sourceSummary: summary,
      contentText: content,
      publishedAt,
      collectedAt,
      rawEntry: { feed, feedMetadata: compactFeedMetadata(feedMetadata), item }
    }
  };
}

function normalizeAtomItem(
  item: Record<string, unknown>,
  feed: RssFeedConfig,
  feedMetadata: Record<string, unknown>,
  collectedAt: string
): ParsedFeedItem {
  const link = atomLink(item.link);
  const canonicalUrl = canonicalizeUrl(link);
  const title = stringValue(item.title);
  const publishedAt = parseDateValue(item.published ?? item.updated);
  const summary = htmlToMaybeText(stringValue(item.summary));
  const content = htmlToMaybeText(
    atomContent(item.content) ??
    stringValue(item.summary) ??
    title ??
    ""
  ) ?? title ?? "";
  const sourceItemId = itemId(
    stringValue(item.id),
    canonicalUrl,
    feed.normalizedUrl,
    title,
    publishedAt
  );

  return {
    sourceItemId,
    publishedAt,
    sourceEntry: {
      sourceKey: rssSourceKey(feed.normalizedUrl),
      sourceItemId,
      canonicalUrl,
      title,
      author: atomPerson(item.author) ?? atomPerson(item["dc:creator"]),
      sourceSummary: summary,
      contentText: content,
      publishedAt,
      collectedAt,
      rawEntry: { feed, feedMetadata: compactFeedMetadata(feedMetadata), item }
    }
  };
}

function itemId(
  preferred: string | null,
  canonicalUrl: string | null,
  feedUrl: string,
  title: string | null,
  publishedAt: string | null
): string {
  return preferred ?? canonicalUrl ?? stableHash([feedUrl, title ?? "", publishedAt ?? ""].join("\n"));
}

function parseDateValue(value: unknown): string | null {
  const string = stringValue(value);
  if (!string) return null;
  const time = Date.parse(string);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function parseRetryAfter(value: string | null): string | null {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isNaN(seconds)) return new Date(Date.now() + seconds * 1000).toISOString();
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

async function shortResponseText(response: Response): Promise<string> {
  const text = await response.text();
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function parseRateLimitHeaders(headers: Headers): RssRateLimitHeaders {
  return {
    remaining: parseNumberHeader(headers.get("x-ratelimit-remaining")),
    resetSeconds: parseNumberHeader(headers.get("x-ratelimit-reset")),
    retryAfter: parseRetryAfter(headers.get("retry-after"))
  };
}

function parseNumberHeader(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function defaultRetryAfter(): string {
  return new Date(Date.now() + 15 * 60 * 1000).toISOString();
}

function compareNewestFirst(a: ParsedFeedItem, b: ParsedFeedItem): number {
  return timestamp(b.publishedAt) - timestamp(a.publishedAt);
}

function timestamp(value: string | null): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function htmlToMaybeText(value: string | null): string | null {
  if (!value) return null;
  return htmlToPlainText(value) || value.trim() || null;
}

function atomLink(value: unknown): string | null {
  if (Array.isArray(value)) {
    const alternate = value.map(asRecord).find((link) => !stringValue(link["@_rel"]) || stringValue(link["@_rel"]) === "alternate");
    return stringValue(alternate?.["@_href"]) ?? stringValue(value[0]);
  }
  if (isRecord(value)) return stringValue(value["@_href"]) ?? stringValue(value["#text"]);
  return stringValue(value);
}

function atomContent(value: unknown): string | null {
  if (isRecord(value)) return stringValue(value["#cdata"]) ?? stringValue(value["#text"]);
  return stringValue(value);
}

function atomPerson(value: unknown): string | null {
  if (isRecord(value)) return stringValue(value.name) ?? stringValue(value.email) ?? stringValue(value["#text"]);
  return stringValue(value);
}

function compactFeedMetadata(feed: Record<string, unknown>): Record<string, unknown> {
  return {
    title: feed.title,
    link: feed.link,
    description: feed.description,
    updated: feed.updated
  };
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (isRecord(value)) return stringValue(value["#cdata"]) ?? stringValue(value["#text"]);
  return null;
}
