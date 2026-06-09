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
  requiredTopicMinScore?: number;
  focusAreaMinScore?: number;
  importantGeneralMinScore?: number;
  importantGeneralMaxEntries: number;
  generalMaxEntries: number;
  sourceTypeMaxEntries?: Partial<Record<DigestCandidate["sourceType"], number>>;
  maxEntriesPerSourceKey?: number;
  maxEntriesPerAuthor?: number;
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
  signalLabel?: "important_general" | "strategic_analysis" | "general";
}

interface SelectionBucket {
  topic: string;
  bucket: "required" | "focus";
  candidates: DigestCandidate[];
  minEntries: number;
  maxEntries: number;
  minScore: number;
}

interface SelectionState {
  selected: SelectedDigestSource[];
  seen: Set<string>;
  seenContentKeys: Set<string>;
  sourceTypeCounts: Map<DigestCandidate["sourceType"], number>;
  sourceKeyCounts: Map<string, number>;
  authorCounts: Map<string, number>;
}

export function selectDigestSources(
  recentCandidates: DigestCandidate[],
  requiredTopicMatches: DigestTopicMatches[],
  focusAreaMatches: DigestTopicMatches[],
  options: DigestSelectionOptions
): DigestSelectionResult {
  const state: SelectionState = {
    selected: [],
    seen: new Set<string>(),
    seenContentKeys: new Set<string>(),
    sourceTypeCounts: new Map<DigestCandidate["sourceType"], number>(),
    sourceKeyCounts: new Map<string, number>(),
    authorCounts: new Map<string, number>()
  };

  const requiredCount = addTopicBuckets(state, buildBuckets(
    recentCandidates,
    requiredTopicMatches,
    "required",
    options.requiredTopicMinEntries,
    options.requiredTopicMaxEntries,
    options.requiredTopicMinScore ?? 0
  ), options);

  const focusCount = addTopicBuckets(state, buildBuckets(
    recentCandidates,
    focusAreaMatches,
    "focus",
    options.focusAreaMinEntries,
    options.focusAreaMaxEntries,
    options.focusAreaMinScore ?? 0
  ), options);

  const importantGeneralLimit = Math.min(options.importantGeneralMaxEntries, options.maxEntries - state.selected.length);
  let importantGeneralCount = 0;
  for (const candidate of rankedImportantGeneralCandidates(recentCandidates, options.importantGeneralMinScore ?? 1)) {
    if (importantGeneralCount >= importantGeneralLimit || state.selected.length >= options.maxEntries) break;
    if (!addSelected(state, candidate, {
      bucket: "important_general",
      signalLabel: importantGeneralLabel(candidate)
    }, options)) continue;
    importantGeneralCount += 1;
  }

  const generalLimit = Math.min(options.generalMaxEntries, options.maxEntries - state.selected.length);
  let generalCount = 0;
  for (const candidate of rankedGeneralCandidates(recentCandidates)) {
    if (generalCount >= generalLimit || state.selected.length >= options.maxEntries) break;
    if (generalQualityScore(candidate) <= -4) continue;
    if (!addSelected(state, candidate, {
      bucket: "general",
      signalLabel: generalSelectionLabel(candidate)
    }, options)) continue;
    generalCount += 1;
  }

  return {
    sources: state.selected.map((selection) => selection.source),
    selectedSources: state.selected,
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
  maxEntries: number,
  minScore: number
): SelectionBucket[] {
  return topicMatches.map((topicMatch) => ({
    topic: topicMatch.topic,
    bucket,
    candidates: rankedTopicCandidates(recentCandidates, topicMatch, minScore),
    minEntries,
    maxEntries,
    minScore
  }));
}

function rankedTopicCandidates(
  recentCandidates: DigestCandidate[],
  topicMatch: DigestTopicMatches,
  minScore: number
): DigestCandidate[] {
  const exactMatches = recentCandidates.filter((candidate) => candidateMatchesTopic(candidate, topicMatch.topic));
  const vectorMatches = topicMatch.matches.filter((candidate) =>
    candidate.score >= minScore && candidateHasTopicAnchor(candidate, topicMatch.topic)
  );
  const combined = [...exactMatches, ...vectorMatches];
  const seen = new Set<string>();

  return combined.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function addTopicBuckets(
  state: SelectionState,
  buckets: SelectionBucket[],
  options: DigestSelectionOptions
): number {
  let added = 0;

  for (const bucket of buckets) {
    const target = Math.min(bucket.maxEntries, Math.max(bucket.minEntries, bucket.candidates.length));
    let bucketAdded = 0;

    for (const candidate of bucket.candidates) {
      if (bucketAdded >= target || state.selected.length >= options.maxEntries) break;
      if (!addSelected(state, candidate, { bucket: bucket.bucket, topic: bucket.topic }, options)) continue;
      bucketAdded += 1;
      added += 1;
    }
  }

  return added;
}

function addSelected(
  state: SelectionState,
  candidate: DigestCandidate,
  selection: Omit<SelectedDigestSource, "source">,
  options: DigestSelectionOptions
): boolean {
  if (state.seen.has(candidate.id)) return false;
  const contentKey = candidateContentKey(candidate);
  if (contentKey && state.seenContentKeys.has(contentKey)) return false;
  if (state.selected.length >= options.maxEntries) return false;
  if (exceedsCaps(state, candidate, options)) return false;

  state.selected.push({ source: candidate, ...selection });
  state.seen.add(candidate.id);
  if (contentKey) state.seenContentKeys.add(contentKey);
  increment(state.sourceTypeCounts, candidate.sourceType);
  increment(state.sourceKeyCounts, candidate.sourceKey);
  const authorKey = normalizedAuthor(candidate.author);
  if (authorKey) increment(state.authorCounts, authorKey);
  return true;
}

function exceedsCaps(
  state: SelectionState,
  candidate: DigestCandidate,
  options: DigestSelectionOptions
): boolean {
  const sourceTypeCap = options.sourceTypeMaxEntries?.[candidate.sourceType];
  if (sourceTypeCap !== undefined && currentCount(state.sourceTypeCounts, candidate.sourceType) >= sourceTypeCap) {
    return true;
  }

  if (
    options.maxEntriesPerSourceKey !== undefined &&
    currentCount(state.sourceKeyCounts, candidate.sourceKey) >= options.maxEntriesPerSourceKey
  ) {
    return true;
  }

  const authorKey = normalizedAuthor(candidate.author);
  return Boolean(
    authorKey &&
    options.maxEntriesPerAuthor !== undefined &&
    currentCount(state.authorCounts, authorKey) >= options.maxEntriesPerAuthor
  );
}

function currentCount<T>(counts: Map<T, number>, key: T): number {
  return counts.get(key) ?? 0;
}

function increment<T>(counts: Map<T, number>, key: T): void {
  counts.set(key, currentCount(counts, key) + 1);
}

function normalizedAuthor(author: string | null): string | null {
  const value = author?.trim().toLowerCase();
  return value || null;
}

function candidateContentKey(candidate: DigestCandidate): string | null {
  const title = normalizeText(stripPublisherSuffix(candidate.title ?? ""));
  return title || null;
}

function stripPublisherSuffix(title: string): string {
  return title.replace(/\s+-\s+[^-]+$/u, "").trim();
}

function candidateMatchesTopic(candidate: DigestCandidate, topic: string): boolean {
  const needle = normalizeText(topic);
  if (!needle || !isSpecificTopic(needle)) return false;
  return exactSearchableText(candidate).includes(needle);
}

function candidateHasTopicAnchor(candidate: DigestCandidate, topic: string): boolean {
  const normalizedTopic = normalizeText(topic);
  const text = exactSearchableText(candidate);
  if (requiresAgenticAnchor(normalizedTopic)) {
    const anchors = topicAnchorTerms(normalizedTopic);
    return text.includes(normalizedTopic) || (hasAgenticConcept(text) && anchors.some((anchor) => text.includes(anchor)));
  }

  const anchors = topicAnchorTerms(topic);
  if (anchors.length === 0) return true;
  return anchors.some((anchor) => text.includes(anchor));
}

function topicAnchorTerms(topic: string): string[] {
  return normalizeText(topic)
    .split(" ")
    .filter(Boolean)
    .filter((term) => !["agentic", "ai", "artificial", "intelligence"].includes(term));
}

function requiresAgenticAnchor(topic: string): boolean {
  return topic.split(" ").includes("agentic") && topicAnchorTerms(topic).length > 0;
}

function hasAgenticConcept(text: string): boolean {
  return /\b(agent|agents|agentic|autonomous|automation|automated|ai|llm|llms|model|models)\b/.test(text);
}

function rankedImportantGeneralCandidates(candidates: DigestCandidate[], minScore: number): DigestCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, score: importantGeneralScore(candidate), index }))
    .filter((item) => item.score >= minScore)
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

  score += scoreMatches(text, strategicAnalysisPatterns());

  score += scoreMatches(text, [
    /\b(google|apple|amazon|aws|microsoft|openai|anthropic|meta|visa|mastercard|paypal|stripe|american express|amex|alipay|worldpay)\b/g
  ]) * 2;

  score += scoreMatches(rawText, [
    /\b(likecount|retweetcount|replycount|bookmarkcount|viewcount)\b/g
  ]);

  if (candidate.sourceType === "twitter" && twitterEngagement(candidate.rawEntry) >= 100) score += 2;

  return score;
}

function rankedGeneralCandidates(candidates: DigestCandidate[]): DigestCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, score: generalQualityScore(candidate), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.candidate);
}

function generalQualityScore(candidate: DigestCandidate): number {
  const text = searchableText(candidate);
  const summaryLength = normalizeText(candidate.summary ?? "").length;
  let score = 0;

  if (candidate.sourceType === "article" && summaryLength >= 80) score += 1;
  if (normalizedAuthor(candidate.author)) score += 2;
  if (summaryLength >= 80) score += 1;
  if (summaryLength >= 160) score += 1;
  if (candidate.topicTags.length > 0) score += 1;
  if (entitySearchParts(candidate.entities).length > 0) score += 1;

  score += scoreMatches(text, strategicAnalysisPatterns()) * 2;
  score += scoreMatches(text, [
    /\b(strategy|strategic|market structure|newsletter|analysis|economics|business model|buyer|buyers)\b/g
  ]);

  score -= scoreMatches(text, [
    /\b(is hiring|hiring|job|jobs)\b/g
  ]) * 4;
  score -= scoreMatches(text, [
    /\bcomments?\b/g,
    /\blacks detailed content\b/g,
    /\bno further analysis\b/g,
    /\blikely discusses\b/g
  ]) * 3;

  return score;
}

function importantGeneralLabel(candidate: DigestCandidate): SelectedDigestSource["signalLabel"] {
  return isStrategicAnalysis(candidate) ? "strategic_analysis" : "important_general";
}

function generalSelectionLabel(candidate: DigestCandidate): SelectedDigestSource["signalLabel"] {
  return isStrategicAnalysis(candidate) ? "strategic_analysis" : "general";
}

function isStrategicAnalysis(candidate: DigestCandidate): boolean {
  const text = searchableText(candidate);
  return scoreMatches(text, strategicAnalysisPatterns()) >= 2 || (
    normalizedAuthor(candidate.author) !== null &&
    normalizeText(candidate.summary ?? "").length >= 120 &&
    scoreMatches(text, strategicAnalysisPatterns()) >= 1
  );
}

function strategicAnalysisPatterns(): RegExp[] {
  return [
    /\bpricing\b/g,
    /\bcosts?\b/g,
    /\bunit economics\b/g,
    /\bsubstitution\b/g,
    /\bfrontier models?\b/g,
    /\bopen-source models?\b/g,
    /\bmodel routing\b/g,
    /\btoken usage\b/g,
    /\befficiency\b/g,
    /\bai buyers\b/g
  ];
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

function exactSearchableText(candidate: DigestCandidate): string {
  const parts = [
    candidate.title,
    candidate.summary,
    ...candidate.topicTags,
    ...entitySearchParts(candidate.entities)
  ];

  return normalizeText(parts.filter((part): part is string => Boolean(part)).join(" "));
}

function isSpecificTopic(topic: string): boolean {
  return topic.split(" ").filter(Boolean).length >= 2 || topic.length >= 4;
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
