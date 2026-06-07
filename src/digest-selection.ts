import type { DigestCandidate } from "./types.js";

export interface DigestTopicMatches {
  topic: string;
  matches: DigestCandidate[];
}

export interface DigestSelectionOptions {
  maxEntries: number;
  requiredTopicMinEntries: number;
  requiredTopicMaxEntries: number;
  focusAreaMinEntries: number;
  focusAreaMaxEntries: number;
  importantGeneralMaxEntries: number;
  generalMaxEntries: number;
}

export interface DigestSelectionResult {
  sources: DigestCandidate[];
  selectedSources: SelectedDigestSource[];
  requiredCount: number;
  focusCount: number;
  importantGeneralCount: number;
  generalCount: number;
}

export interface SelectedDigestSource {
  source: DigestCandidate;
  bucket: "required" | "focus" | "important_general" | "general";
  topic?: string;
}

interface SelectionBucket {
  topic: string;
  bucket: "required" | "focus";
  candidates: DigestCandidate[];
  minEntries: number;
  maxEntries: number;
}

export function selectDigestSources(
  recentCandidates: DigestCandidate[],
  requiredTopicMatches: DigestTopicMatches[],
  focusAreaMatches: DigestTopicMatches[],
  options: DigestSelectionOptions
): DigestSelectionResult {
  const selected: SelectedDigestSource[] = [];
  const seen = new Set<string>();

  const requiredCount = addTopicBuckets(selected, seen, buildBuckets(
    recentCandidates,
    requiredTopicMatches,
    "required",
    options.requiredTopicMinEntries,
    options.requiredTopicMaxEntries
  ), options.maxEntries);

  const focusCount = addTopicBuckets(selected, seen, buildBuckets(
    recentCandidates,
    focusAreaMatches,
    "focus",
    options.focusAreaMinEntries,
    options.focusAreaMaxEntries
  ), options.maxEntries);

  const importantGeneralLimit = Math.min(options.importantGeneralMaxEntries, options.maxEntries - selected.length);
  let importantGeneralCount = 0;
  for (const candidate of rankedImportantGeneralCandidates(recentCandidates)) {
    if (importantGeneralCount >= importantGeneralLimit || selected.length >= options.maxEntries) break;
    if (seen.has(candidate.id)) continue;
    selected.push({ source: candidate, bucket: "important_general" });
    seen.add(candidate.id);
    importantGeneralCount += 1;
  }

  const generalLimit = Math.min(options.generalMaxEntries, options.maxEntries - selected.length);
  let generalCount = 0;
  for (const candidate of recentCandidates) {
    if (generalCount >= generalLimit || selected.length >= options.maxEntries) break;
    if (seen.has(candidate.id)) continue;
    selected.push({ source: candidate, bucket: "general" });
    seen.add(candidate.id);
    generalCount += 1;
  }

  return {
    sources: selected.map((selection) => selection.source),
    selectedSources: selected,
    requiredCount,
    focusCount,
    importantGeneralCount,
    generalCount
  };
}

function buildBuckets(
  recentCandidates: DigestCandidate[],
  topicMatches: DigestTopicMatches[],
  bucket: "required" | "focus",
  minEntries: number,
  maxEntries: number
): SelectionBucket[] {
  return topicMatches.map((topicMatch) => ({
    topic: topicMatch.topic,
    bucket,
    candidates: rankedTopicCandidates(recentCandidates, topicMatch),
    minEntries,
    maxEntries
  }));
}

function rankedTopicCandidates(
  recentCandidates: DigestCandidate[],
  topicMatch: DigestTopicMatches
): DigestCandidate[] {
  const exactMatches = recentCandidates.filter((candidate) => candidateMatchesTopic(candidate, topicMatch.topic));
  const combined = [...exactMatches, ...topicMatch.matches];
  const seen = new Set<string>();

  return combined.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function addTopicBuckets(
  selected: SelectedDigestSource[],
  seen: Set<string>,
  buckets: SelectionBucket[],
  maxEntries: number
): number {
  let added = 0;

  for (const bucket of buckets) {
    const target = Math.min(bucket.maxEntries, Math.max(bucket.minEntries, bucket.candidates.length));
    let bucketAdded = 0;

    for (const candidate of bucket.candidates) {
      if (bucketAdded >= target || selected.length >= maxEntries) break;
      if (seen.has(candidate.id)) continue;
      selected.push({ source: candidate, bucket: bucket.bucket, topic: bucket.topic });
      seen.add(candidate.id);
      bucketAdded += 1;
      added += 1;
    }
  }

  return added;
}

function candidateMatchesTopic(candidate: DigestCandidate, topic: string): boolean {
  const needle = normalizeText(topic);
  if (!needle) return false;
  return searchableText(candidate).includes(needle);
}

function rankedImportantGeneralCandidates(candidates: DigestCandidate[]): DigestCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, score: importantGeneralScore(candidate), index }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.candidate);
}

function importantGeneralScore(candidate: DigestCandidate): number {
  const text = searchableText(candidate);
  const rawText = rawEntrySearchText(candidate.rawEntry);
  let score = 0;

  score += scoreMatches(text, [
    /\b(standard|standards|protocol|specification|framework|alliance|fido)\b/g,
    /\b(security|authentication|authorization|fraud|token|tokens|identity|trust|permission|permissions)\b/g,
    /\b(regulation|regulatory|governance|compliance|policy)\b/g,
    /\b(launch|launched|release|released|introduced|published|donated|open sourced|open-source)\b/g,
    /\b(integration|integrated|partnered|partnership|collaboration|collaborates)\b/g
  ]);

  score += scoreMatches(text, [
    /\b(google|apple|amazon|aws|microsoft|openai|anthropic|meta|visa|mastercard|paypal|stripe|american express|amex|alipay|worldpay)\b/g
  ]) * 2;

  score += scoreMatches(rawText, [
    /\b(likecount|retweetcount|replycount|bookmarkcount|viewcount)\b/g
  ]);

  if (candidate.sourceType === "twitter" && twitterEngagement(candidate.rawEntry) >= 100) score += 2;

  return score;
}

function scoreMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((score, pattern) => score + (text.match(pattern)?.length ?? 0), 0);
}

function twitterEngagement(rawEntry: unknown): number {
  if (!rawEntry || typeof rawEntry !== "object") return 0;
  const entry = rawEntry as Record<string, unknown>;
  return ["likeCount", "retweetCount", "replyCount", "bookmarkCount"].reduce((total, key) => {
    const value = entry[key];
    return total + (typeof value === "number" ? value : 0);
  }, 0);
}

function searchableText(candidate: DigestCandidate): string {
  const parts = [
    candidate.title,
    candidate.summary,
    candidate.contentText,
    ...candidate.topicTags,
    ...entitySearchParts(candidate.entities),
    rawEntrySearchText(candidate.rawEntry)
  ];

  return normalizeText(parts.filter((part): part is string => Boolean(part)).join(" "));
}

function entitySearchParts(entities: unknown): string[] {
  if (!Array.isArray(entities)) return [];
  return entities.flatMap((entity) => {
    if (!entity || typeof entity !== "object") return [];
    const maybeEntity = entity as { name?: unknown; type?: unknown };
    return [maybeEntity.name, maybeEntity.type].filter((value): value is string => typeof value === "string");
  });
}

function rawEntrySearchText(rawEntry: unknown): string {
  if (!rawEntry || typeof rawEntry !== "object") return "";
  const entry = rawEntry as Record<string, unknown>;
  return [entry.text, entry.full_text, entry.name, entry.username]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
