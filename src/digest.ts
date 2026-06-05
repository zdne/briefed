import { AnalystAI } from "./ai.js";
import { config } from "./config.js";
import { countRecentContent, recentContent, saveDigest } from "./db.js";

export type DigestLogger = (message: string) => void;

export async function createDigest(
  hours: number,
  ai: AnalystAI,
  log: DigestLogger = () => {}
) {
  log(`Loading enriched entries collected during the last ${hours} hours`);
  const eligibleCount = await countRecentContent(hours);
  const sources = await recentContent(hours, config.DIGEST_MAX_ENTRIES);
  if (eligibleCount > sources.length) {
    log(
      `${eligibleCount} enriched entries are eligible; selected the newest ${sources.length} ` +
      `because DIGEST_MAX_ENTRIES=${config.DIGEST_MAX_ENTRIES}`
    );
  } else {
    log(`Loaded ${sources.length} enriched entries`);
  }

  if (sources.length === 0) {
    log("No entries available; digest generation skipped");
    return {
      id: null,
      periodStart: null,
      periodEnd: null,
      body: "No enriched entries were collected during this period.",
      sources: []
    };
  }

  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  log(`Generating digest with ${sources.length} sources using the configured LLM`);
  const body = await ai.digest(sources, hours, {
    requiredTopics: config.DIGEST_REQUIRED_TOPICS,
    focusAreas: config.DIGEST_FOCUS_AREAS
  });
  log("Digest generation complete; storing result");
  const id = await saveDigest(start, end, sources.map((source) => source.id), body);
  log(`Stored digest ${id}`);
  log("Digest complete");

  return {
    id,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    body,
    sources: sources.map((source, index) => ({
      citation: index + 1,
      id: source.id,
      title: source.title,
      url: source.canonicalUrl,
      author: source.author,
      publishedAt: source.publishedAt,
      summary: source.summary
    }))
  };
}
