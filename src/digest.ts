import { AnalystAI } from "./ai.js";
import { config } from "./config.js";
import {
  countRecentContent,
  recentDigestHistoryCandidates,
  recentDigestCandidates,
  recentVectorMatches,
  saveDigest
} from "./db.js";
import {
  type DigestTopicMatches,
  selectDigestSources
} from "./digest-selection.js";
import { loadUserConfig } from "./user-config.js";

export type DigestLogger = (message: string) => void;

export async function createDigest(
  hours: number,
  ai: AnalystAI,
  log: DigestLogger = () => {},
  referenceTime = new Date()
) {
  const end = referenceTime;
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
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
    log("No entries available; briefing generation skipped");
    return {
      id: null,
      periodStart: null,
      periodEnd: null,
      body: "No enriched entries were published during this period.",
      sources: []
    };
  }

  const userConfig = await loadUserConfig();
  const requiredTopicMatches = await vectorMatchesForTopics(
    userConfig.briefing.requiredTopics,
    config.DIGEST_REQUIRED_TOPIC_MAX_ENTRIES,
    hours,
    referenceTime,
    ai,
    log
  );
  const focusAreaMatches = await vectorMatchesForTopics(
    userConfig.briefing.focusAreas,
    config.DIGEST_FOCUS_AREA_MAX_ENTRIES,
    hours,
    referenceTime,
    ai,
    log
  );
  const priorDigestCandidates = await recentDigestHistoryCandidates(
    config.DIGEST_REPEAT_LOOKBACK_HOURS,
    referenceTime,
    start,
    end
  );
  if (priorDigestCandidates.length > 0) {
    log(
      `Loaded ${priorDigestCandidates.length} recent briefing source(s) for repeat detection ` +
      `over ${config.DIGEST_REPEAT_LOOKBACK_HOURS} hours`
    );
  }
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
    maxEntriesPerAuthor: config.DIGEST_MAX_ENTRIES_PER_AUTHOR,
    priorDigestCandidates,
    maxFollowupsPerEvent: config.DIGEST_MAX_FOLLOWUPS_PER_EVENT
  });
  const sources = selection.sources;
  log(
    `Selected ${sources.length} briefing sources: ` +
    `${selection.requiredCount} required-topic, ${selection.focusCount} focus-area, ` +
    `${selection.importantGeneralCount} important-general, ${selection.generalCount} general`
  );

  log(`Generating briefing with ${sources.length} sources using the configured LLM`);
  const body = await ai.digest(sources, hours, {
    requiredTopics: userConfig.briefing.requiredTopics,
    focusAreas: userConfig.briefing.focusAreas,
    sourceContexts: selection.selectedSources.map((selectedSource) => ({
      bucket: selectedSource.bucket,
      topic: selectedSource.topic,
      signalLabel: selectedSource.signalLabel
    }))
  });
  log("Briefing generation complete; storing result");
  const id = await saveDigest(start, end, sources.map((source) => source.id), body);
  log(`Stored briefing ${id}`);
  log("Briefing complete");

  return {
    id,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    candidateCount: candidates.length,
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
    log(`Finding vector matches for briefing topic "${topic}"`);
    const embedding = await ai.embed(topic);
    matches.push({
      topic,
      matches: await recentVectorMatches(embedding, hours, limit, referenceTime)
    });
  }

  return matches;
}
