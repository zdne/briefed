import { readFile } from "node:fs/promises";
import { z } from "zod";
import { normalizeSourceUrl } from "./source-utils.js";

const feedSchema = z.object({
  title: z.string().trim().min(1),
  url: z.string().trim().url(),
  category: z.string().trim().min(1).optional(),
  enabled: z.boolean().default(true)
});

const feedsFileSchema = z.object({
  version: z.literal(1),
  feeds: z.array(feedSchema)
});

export interface RssFeedConfig {
  title: string;
  url: string;
  normalizedUrl: string;
  category?: string;
  enabled: boolean;
}

export async function loadRssFeeds(path: string): Promise<RssFeedConfig[]> {
  const raw = await readFile(path, "utf8");
  return parseRssFeeds(raw);
}

export function parseRssFeeds(raw: string): RssFeedConfig[] {
  const parsed = feedsFileSchema.parse(JSON.parse(raw));
  const seen = new Set<string>();
  const feeds: RssFeedConfig[] = [];

  for (const feed of parsed.feeds) {
    if (!feed.enabled) continue;
    const normalizedUrl = normalizeSourceUrl(feed.url);
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    feeds.push({
      ...feed,
      normalizedUrl
    });
  }

  return feeds;
}
