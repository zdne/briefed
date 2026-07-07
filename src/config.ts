import "dotenv/config";
import { z } from "zod";
import type { LightweightSourceType } from "./enrichment-policy.js";

export function parseCommaSeparatedList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const schema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://pnd:pnd@localhost:5432/pnd"),
  PG_POOL_MAX: z.coerce.number().int().min(1).default(3),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  USER_CONFIG_PATH: optionalString(),
  BRIEFED_CONFIG_PATH: optionalString(),
  FEEDBIN_EMAIL: optionalString(),
  FEEDBIN_PASSWORD: optionalString(),
  FEEDBIN_BASE_URL: z.string().url().default("https://api.feedbin.com/v2"),
  RSS_FETCH_DELAY_MS: z.coerce.number().int().min(0).default(1500),
  RSS_REDDIT_FETCH_DELAY_MS: z.coerce.number().int().min(0).default(10000),
  REDDIT_RSS_USER: optionalString(),
  REDDIT_RSS_FEED: optionalString(),
  REDDIT_RSS_DEBUG: z.coerce.boolean().default(false),
  RSS_MAX_ITEMS_PER_FEED: z.coerce.number().int().min(1).default(50),
  RSS_USER_AGENT: z.string().min(1).default("pnd-rss/0.1"),
  RSS_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).default(15000),
  GMAIL_CLIENT_ID: optionalString(),
  GMAIL_CLIENT_SECRET: optionalString(),
  GMAIL_REFRESH_TOKEN: optionalString(),
  GMAIL_MAX_MESSAGES: z.coerce.number().int().min(1).default(50),
  TWITTERAPI_IO_API_KEY: optionalString(),
  TWITTERAPI_IO_BASE_URL: z.string().url().default("https://api.twitterapi.io"),
  TWITTERAPI_LIST_MAX_PAGES: z.coerce.number().int().min(1).default(3),
  TWITTERAPI_LIST_MAX_TWEETS: z.coerce.number().int().min(1).default(200),
  OPENAI_API_KEY: optionalString(),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  LLM_PROVIDER: z.enum(["openai", "anthropic"]).default("openai"),
  OPENAI_LLM_MODEL: z.string().default("gpt-4.1-mini"),
  ANTHROPIC_API_KEY: optionalString(),
  ANTHROPIC_LLM_MODEL: z.string().default("claude-3-5-haiku-latest"),
  LIGHTWEIGHT_SOURCE_TYPES: z.string().default("reddit,hackernews,twitter").transform((value) =>
    parseCommaSeparatedList(value).map((source) =>
      z.enum(["reddit", "hackernews", "twitter"]).parse(source)
    ) as LightweightSourceType[]
  ),
  QUERY_LIMIT: z.coerce.number().int().min(1).max(30).default(8),
  DIGEST_HOURS: z.coerce.number().int().min(1).default(24),
  DIGEST_MAX_ENTRIES: z.coerce.number().int().min(1).default(200),
  DIGEST_CANDIDATE_LIMIT: z.coerce.number().int().min(1).default(1000),
  DIGEST_REQUIRED_TOPIC_MIN_ENTRIES: z.coerce.number().int().min(0).default(3),
  DIGEST_REQUIRED_TOPIC_MAX_ENTRIES: z.coerce.number().int().min(1).default(5),
  DIGEST_FOCUS_AREA_MIN_ENTRIES: z.coerce.number().int().min(0).default(2),
  DIGEST_FOCUS_AREA_MAX_ENTRIES: z.coerce.number().int().min(1).default(4),
  DIGEST_REQUIRED_TOPIC_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.25),
  DIGEST_FOCUS_AREA_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.35),
  DIGEST_IMPORTANT_GENERAL_MIN_SCORE: z.coerce.number().int().min(1).default(3),
  DIGEST_IMPORTANT_GENERAL_MAX_ENTRIES: z.coerce.number().int().min(0).default(12),
  DIGEST_GENERAL_MAX_ENTRIES: z.coerce.number().int().min(0).default(120),
  DIGEST_MAX_ARTICLE_ENTRIES: z.coerce.number().int().min(0).default(80),
  DIGEST_MAX_REDDIT_ENTRIES: z.coerce.number().int().min(0).default(25),
  DIGEST_MAX_HACKERNEWS_ENTRIES: z.coerce.number().int().min(0).default(15),
  DIGEST_MAX_TWITTER_ENTRIES: z.coerce.number().int().min(0).default(20),
  DIGEST_MAX_ENTRIES_PER_SOURCE_KEY: z.coerce.number().int().min(0).default(20),
  DIGEST_MAX_ENTRIES_PER_AUTHOR: z.coerce.number().int().min(0).default(4),
  DIGEST_REPEAT_LOOKBACK_HOURS: z.coerce.number().int().min(0).default(72),
  DIGEST_MAX_FOLLOWUPS_PER_EVENT: z.coerce.number().int().min(0).default(1),
  DIGEST_OUTPUT_DIR: z.string().min(1).default("output/briefings"),
  QUERY_OUTPUT_DIR: z.string().min(1).default("output/queries")
});

export type Config = z.infer<typeof schema>;
export const config = schema.parse(process.env);

function optionalString(defaultValue: string): z.ZodEffects<z.ZodDefault<z.ZodString>, string, unknown>;
function optionalString(): z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, unknown>;
function optionalString(defaultValue?: string) {
  const normalized = z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed || undefined;
  }, defaultValue === undefined ? z.string().optional() : z.string().default(defaultValue));
  return normalized;
}

export function requireConfig(values: (keyof Config)[]): void {
  const missing = values.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }
}
