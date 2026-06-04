import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://pnd:pnd@localhost:5432/pnd"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  FEEDBIN_EMAIL: z.string().optional(),
  FEEDBIN_PASSWORD: z.string().optional(),
  FEEDBIN_BASE_URL: z.string().url().default("https://api.feedbin.com/v2"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  LLM_PROVIDER: z.enum(["openai", "anthropic"]).default("openai"),
  OPENAI_LLM_MODEL: z.string().default("gpt-4.1-mini"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_LLM_MODEL: z.string().default("claude-3-5-haiku-latest"),
  QUERY_LIMIT: z.coerce.number().int().min(1).max(30).default(8),
  DIGEST_HOURS: z.coerce.number().int().min(1).default(24)
});

export type Config = z.infer<typeof schema>;
export const config = schema.parse(process.env);

export function requireConfig(values: (keyof Config)[]): void {
  const missing = values.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }
}
