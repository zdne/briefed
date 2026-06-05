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
  generalMaxEntries: number;
}

export interface DigestSelectionResult {
  sources: DigestCandidate[];
  requiredCount: number;
  focusCount: number;
  generalCount: number;
}

interface SelectionBucket {
  topic: string;
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
  const selected: DigestCandidate[] = [];
  const seen = new Set<string>();

  const requiredCount = addTopicBuckets(selected, seen, buildBuckets(
    recentCandidates,
    requiredTopicMatches,
    options.requiredTopicMinEntries,
    options.requiredTopicMaxEntries
  ), options.maxEntries);

  const focusCount = addTopicBuckets(selected, seen, buildBuckets(
    recentCandidates,
    focusAreaMatches,
    options.focusAreaMinEntries,
    options.focusAreaMaxEntries
  ), options.maxEntries);

  const generalLimit = Math.min(options.generalMaxEntries, options.maxEntries - selected.length);
  let generalCount = 0;
  for (const candidate of recentCandidates) {
    if (generalCount >= generalLimit || selected.length >= options.maxEntries) break;
    if (seen.has(candidate.id)) continue;
    selected.push(candidate);
    seen.add(candidate.id);
    generalCount += 1;
  }

  return { sources: selected, requiredCount, focusCount, generalCount };
}

function buildBuckets(
  recentCandidates: DigestCandidate[],
  topicMatches: DigestTopicMatches[],
  minEntries: number,
  maxEntries: number
): SelectionBucket[] {
  return topicMatches.map((topicMatch) => ({
    topic: topicMatch.topic,
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
  selected: DigestCandidate[],
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
      selected.push(candidate);
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
