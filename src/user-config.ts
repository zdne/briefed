import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { normalizeSourceUrl } from "./source-utils.js";

const nullableString = z.preprocess((value) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed || null;
}, z.string().min(1).nullable());

const stringList = z.array(z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return value.trim();
}, z.string().min(1))).default([]);

const rssFeedSchema = z.object({
  title: z.string().trim().min(1),
  url: z.string().trim().url(),
  category: z.string().trim().min(1).optional(),
  enabled: z.boolean().default(true)
}).strict();

export const collectorsSchema = z.object({
  rss: z.object({
    enabled: z.boolean().default(true),
    feeds: z.array(rssFeedSchema).default([])
  }).strict().default({}),
  gmail: z.object({
    enabled: z.boolean().default(false),
    label: nullableString.default("newsletter"),
    query: nullableString.default(null)
  }).strict().default({}),
  twitter: z.object({
    enabled: z.boolean().default(false),
    listIds: stringList
  }).strict().default({}),
  feedbin: z.object({
    enabled: z.boolean().default(false)
  }).strict().default({})
}).strict();

export const briefingPreferencesSchema = z.object({
  requiredTopics: stringList,
  focusAreas: stringList
}).strict();

export const userConfigSchema = z.object({
  version: z.literal(1),
  collectors: collectorsSchema.default({}),
  briefing: briefingPreferencesSchema.default({})
}).strict();

export type UserConfig = z.infer<typeof userConfigSchema>;
export type UserCollectorsConfig = z.infer<typeof collectorsSchema>;
export type BriefingPreferences = z.infer<typeof briefingPreferencesSchema>;

export interface UserRssFeedConfig {
  title: string;
  url: string;
  normalizedUrl: string;
  category?: string;
  enabled: boolean;
}

export function userConfigPath(): string {
  return config.USER_CONFIG_PATH ?? config.BRIEFED_CONFIG_PATH ?? "briefed.config.json";
}

export async function loadUserConfig(path = userConfigPath()): Promise<UserConfig> {
  const raw = await readFile(path, "utf8");
  return parseUserConfig(raw);
}

export function parseUserConfig(raw: string): UserConfig {
  return userConfigSchema.parse(JSON.parse(raw));
}

export async function writeUserConfig(next: UserConfig, path = userConfigPath()): Promise<UserConfig> {
  const parsed = userConfigSchema.parse(next);
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await rename(tempPath, absolutePath);
  return parsed;
}

export async function updateUserConfig(next: unknown, path = userConfigPath()): Promise<UserConfig> {
  const parsed = userConfigSchema.parse(next);
  return writeUserConfig(parsed, path);
}

export async function updateCollectors(next: unknown, path = userConfigPath()): Promise<UserConfig> {
  const current = await loadUserConfig(path);
  const collectors = collectorsSchema.parse(next);
  return writeUserConfig({ ...current, collectors }, path);
}

export async function updateBriefingPreferences(next: unknown, path = userConfigPath()): Promise<UserConfig> {
  const current = await loadUserConfig(path);
  const briefing = briefingPreferencesSchema.parse(next);
  return writeUserConfig({ ...current, briefing }, path);
}

export function enabledRssFeeds(userConfig: UserConfig): UserRssFeedConfig[] {
  if (!userConfig.collectors.rss.enabled) return [];
  const seen = new Set<string>();
  const feeds: UserRssFeedConfig[] = [];

  for (const feed of userConfig.collectors.rss.feeds) {
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

export function gmailQueryFromUserConfig(userConfig: UserConfig): string | null {
  const gmail = userConfig.collectors.gmail;
  if (!gmail.enabled) return null;
  return gmail.query ?? (gmail.label ? `label:${gmail.label}` : null);
}
