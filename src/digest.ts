import { AnalystAI } from "./ai.js";
import { config } from "./config.js";
import {
  countRecentContent,
  recentDigestCandidates,
  recentVectorMatches,
  saveDigest
} from "./db.js";
import {
  type DigestTopicMatches,
  selectDigestSources
} from "./digest-selection.js";

export type DigestLogger = (message: string) => void;

export async function createDigest(
  hours: number,
  ai: AnalystAI,
  log: DigestLogger = () => {},
  referenceTime = new Date()
) {
  log(`Loading enriched entries published during the last ${hours} hours`);
  const eligibleCount = await countRecentContent(hours, referenceTime);
  const candidates = await recentDigestCandidates(hours, config.DIGEST_CANDIDATE_LIMIT, referenceTime);
  if (eligibleCount > candidates.length) {
    log(
      `${eligibleCount} enriched entries are eligible; loaded the newest ${candidates.length} ` +
      `as candidates because DIGEST_CANDIDATE_LIMIT=${config.DIGEST_CANDIDATE_LIMIT}`
    );
  } else {
    log(`Loaded ${candidates.length} enriched entries`);
  }

  if (candidates.length === 0) {
    log("No entries available; digest generation skipped");
    return {
      id: null,
      periodStart: null,
      periodEnd: null,
      body: "No enriched entries were published during this period.",
      sources: []
    };
  }

  const requiredTopicMatches = await vectorMatchesForTopics(
    config.DIGEST_REQUIRED_TOPICS,
    config.DIGEST_REQUIRED_TOPIC_MAX_ENTRIES,
    hours,
    referenceTime,
    ai,
    log
  );
  const focusAreaMatches = await vectorMatchesForTopics(
    config.DIGEST_FOCUS_AREAS,
    config.DIGEST_FOCUS_AREA_MAX_ENTRIES,
    hours,
    referenceTime,
    ai,
    log
  );
  const selection = selectDigestSources(candidates, requiredTopicMatches, focusAreaMatches, {
    maxEntries: config.DIGEST_MAX_ENTRIES,
    requiredTopicMinEntries: config.DIGEST_REQUIRED_TOPIC_MIN_ENTRIES,
    requiredTopicMaxEntries: config.DIGEST_REQUIRED_TOPIC_MAX_ENTRIES,
    focusAreaMinEntries: config.DIGEST_FOCUS_AREA_MIN_ENTRIES,
    focusAreaMaxEntries: config.DIGEST_FOCUS_AREA_MAX_ENTRIES,
    requiredTopicMinScore: config.DIGEST_REQUIRED_TOPIC_MIN_SCORE,
    focusAreaMinScore: config.DIGEST_FOCUS_AREA_MIN_SCORE,
    importantGeneralMinScore: config.DIGEST_IMPORTANT_GENERAL_MIN_SCORE,
    importantGeneralMaxEntries: config.DIGEST_IMPORTANT_GENERAL_MAX_ENTRIES,
    generalMaxEntries: config.DIGEST_GENERAL_MAX_ENTRIES,
    sourceTypeMaxEntries: {
      article: config.DIGEST_MAX_ARTICLE_ENTRIES,
      reddit: config.DIGEST_MAX_REDDIT_ENTRIES,
      hackernews: config.DIGEST_MAX_HACKERNEWS_ENTRIES,
      twitter: config.DIGEST_MAX_TWITTER_ENTRIES
    },
    maxEntriesPerSourceKey: config.DIGEST_MAX_ENTRIES_PER_SOURCE_KEY,
    maxEntriesPerAuthor: config.DIGEST_MAX_ENTRIES_PER_AUTHOR
  });
  const sources = selection.sources;
  log(
    `Selected ${sources.length} digest sources: ` +
    `${selection.requiredCount} required-topic, ${selection.focusCount} focus-area, ` +
    `${selection.importantGeneralCount} important-general, ${selection.generalCount} general`
  );

  const end = referenceTime;
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  log(`Generating digest with ${sources.length} sources using the configured LLM`);
  const body = await ai.digest(sources, hours, {
    requiredTopics: config.DIGEST_REQUIRED_TOPICS,
    focusAreas: config.DIGEST_FOCUS_AREAS,
    sourceContexts: selection.selectedSources.map((selectedSource) => ({
      bucket: selectedSource.bucket,
      topic: selectedSource.topic,
      signalLabel: selectedSource.signalLabel
    }))
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

async function vectorMatchesForTopics(
  topics: string[],
  maxEntries: number,
  hours: number,
  referenceTime: Date,
  ai: AnalystAI,
  log: DigestLogger
): Promise<DigestTopicMatches[]> {
  const limit = Math.max(1, maxEntries * 3);
  const matches: DigestTopicMatches[] = [];

  for (const topic of topics) {
    log(`Finding vector matches for digest topic "${topic}"`);
    const embedding = await ai.embed(topic);
    matches.push({
      topic,
      matches: await recentVectorMatches(embedding, hours, limit, referenceTime)
    });
  }

  return matches;
}
