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
  priorDigestCandidates?: DigestCandidate[];
  maxFollowupsPerEvent?: number;
  domainRelevanceTerms?: string[];
  topicBestMatchRatio?: number;
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
  freshnessLabel?: "fresh" | "follow_up";
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
  seenTitleKeys: Set<string>;
  eventClusters: EventCluster[];
  priorEventClusters: EventCluster[];
  followupCounts: Map<EventCluster, number>;
  sourceTypeCounts: Map<DigestCandidate["sourceType"], number>;
  sourceKeyCounts: Map<string, number>;
  authorCounts: Map<string, number>;
}

interface EventCluster {
  entities: Set<string>;
  keywords: Set<string>;
  factKeys: Set<string>;
  candidates: DigestCandidate[];
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
    seenTitleKeys: new Set<string>(),
    eventClusters: [],
    priorEventClusters: buildPriorEventClusters(options.priorDigestCandidates ?? []),
    followupCounts: new Map<EventCluster, number>(),
    sourceTypeCounts: new Map<DigestCandidate["sourceType"], number>(),
    sourceKeyCounts: new Map<string, number>(),
    authorCounts: new Map<string, number>()
  };

  const domainRelevanceTerms = options.domainRelevanceTerms ?? [];
  const topicBestMatchRatio = options.topicBestMatchRatio ?? 1;
  const bestTopicScore = new Map<string, number>();
  for (const { matches } of [...requiredTopicMatches, ...focusAreaMatches]) {
    for (const candidate of matches) {
      const current = bestTopicScore.get(candidate.id) ?? 0;
      if (candidate.score > current) bestTopicScore.set(candidate.id, candidate.score);
    }
  }

  addTopicBuckets(state, buildBuckets(
    recentCandidates,
    requiredTopicMatches,
    "required",
    options.requiredTopicMinEntries,
    options.requiredTopicMaxEntries,
    options.requiredTopicMinScore ?? 0,
    domainRelevanceTerms,
    bestTopicScore,
    topicBestMatchRatio
  ), options);

  const focusMatchesWithoutRequiredOverlap = focusAreaMatches.filter((focusArea) =>
    !requiredTopicMatches.some((requiredTopic) => topicsOverlap(focusArea.topic, requiredTopic.topic))
  );
  addTopicBuckets(state, buildBuckets(
    recentCandidates,
    focusMatchesWithoutRequiredOverlap,
    "focus",
    options.focusAreaMinEntries,
    options.focusAreaMaxEntries,
    options.focusAreaMinScore ?? 0,
    domainRelevanceTerms,
    bestTopicScore,
    topicBestMatchRatio
  ), options);

  const importantGeneralLimit = Math.min(options.importantGeneralMaxEntries, options.maxEntries - state.selected.length);
  let importantGeneralCount = 0;
  for (const candidate of rankedImportantGeneralCandidates(recentCandidates, options.importantGeneralMinScore ?? 1, options.domainRelevanceTerms ?? [])) {
    if (importantGeneralCount >= importantGeneralLimit || state.selected.length >= options.maxEntries) break;
    const freshness = classifyFreshness(state, candidate, options);
    if (freshness.label === "stale_repeat") continue;
    if (!addSelected(state, candidate, {
      bucket: "important_general",
      signalLabel: importantGeneralLabel(candidate),
      freshnessLabel: freshness.label
    }, options)) continue;
    importantGeneralCount += 1;
  }

  const generalLimit = Math.min(options.generalMaxEntries, options.maxEntries - state.selected.length);
  let generalCount = 0;
  for (const candidate of rankedGeneralCandidates(recentCandidates)) {
    if (generalCount >= generalLimit || state.selected.length >= options.maxEntries) break;
    if (generalQualityScore(candidate) <= -4) continue;
    if (domainRelevanceTerms.length > 0 && !hasDomainMatch(searchableText(candidate), domainRelevanceTerms)) continue;
    const freshness = classifyFreshness(state, candidate, options);
    if (freshness.label === "stale_repeat") continue;
    if (!addSelected(state, candidate, {
      bucket: "general",
      signalLabel: generalSelectionLabel(candidate),
      freshnessLabel: freshness.label
    }, options)) continue;
    generalCount += 1;
  }

  const selectedSources = assignMostSpecificTopics(
    state.selected,
    requiredTopicMatches.map((match) => match.topic),
    focusAreaMatches.map((match) => match.topic)
  );

  return {
    sources: selectedSources.map((selection) => selection.source),
    selectedSources,
    requiredCount: selectedSources.filter((selection) => selection.bucket === "required").length,
    focusCount: selectedSources.filter((selection) => selection.bucket === "focus").length,
    importantGeneralCount: selectedSources.filter((selection) => selection.bucket === "important_general").length,
    generalCount: selectedSources.filter((selection) => selection.bucket === "general").length
  };
}

function assignMostSpecificTopics(
  selected: SelectedDigestSource[],
  requiredTopics: string[],
  focusAreas: string[]
): SelectedDigestSource[] {
  return selected.map((selection) => {
    if (selection.bucket !== "focus" && selection.bucket !== "important_general" && selection.bucket !== "general") {
      return selection;
    }

    const required = bestTopicAssignment(selection.source, requiredTopics);
    if (required && required.score >= 5) {
      return { ...selection, bucket: "required", topic: required.topic };
    }

    if (selection.bucket === "important_general" || selection.bucket === "general") {
      const focus = bestTopicAssignment(selection.source, focusAreas);
      if (focus && focus.score >= 5) return { ...selection, bucket: "focus", topic: focus.topic };
    }

    return selection;
  });
}

function bestTopicAssignment(
  candidate: DigestCandidate,
  topics: string[]
): { topic: string; score: number } | null {
  return topics
    .map((topic, index) => ({ topic, score: candidateTopicAssignmentScore(candidate, topic), index }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || topicSpecificity(b.topic) - topicSpecificity(a.topic) || a.index - b.index)
    .at(0) ?? null;
}

function candidateTopicAssignmentScore(candidate: DigestCandidate, topic: string): number {
  const normalizedTopic = normalizeText(topic);
  const text = exactSearchableText(candidate);
  if (normalizedTopic.includes("payment") && !hasPaymentTopicAnchor(text)) return 0;
  const anchors = topicAnchorTerms(normalizedTopic);
  let score = text.includes(normalizedTopic) ? 8 : 0;

  score += anchors.filter((anchor) => text.includes(anchor)).length * 2;
  if (normalizedTopic.includes("agentic") && hasAgenticConcept(text)) score += 2;
  score += specialTopicScore(text, normalizedTopic);

  return score;
}

function topicSpecificity(topic: string): number {
  return topicAnchorTerms(topic).length;
}

// domain-specific: synonym expansions for specific topic types; add branches here when a topic needs richer keyword matching than its name alone provides
function specialTopicScore(text: string, topic: string): number {
  if (topic.includes("payment")) {
    return scoreMatches(text, [
      /\b(payments?|checkout|wallet|wallets|signer|signers|credential|credentials|stablecoin|settlement)\b/g
    ]) * 2;
  }
  if (topic.includes("commerce")) {
    return scoreMatches(text, [
      /\b(commerce|shopping|checkout|retail|marketplace|merchant|purchase|buying)\b/g
    ]) * 2;
  }
  if (topic.includes("memory")) {
    return scoreMatches(text, [
      /\b(memory|recall|deletion|retention|remember|notes?|simplenote)\b/g
    ]) * 2;
  }
  if (topic.includes("procurement")) {
    return scoreMatches(text, [
      /\b(procurement|buyers?|vendor|vendors?|sourcing|purchasing|rfp|evaluation)\b/g
    ]) * 2;
  }
  const terms = topicAnchorTerms(topic);
  if (terms.length === 0) return 0;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return scoreMatches(text, [new RegExp(`\\b(${escaped})\\b`, "g")]) * 2;
}

function hasPaymentTopicAnchor(text: string): boolean {
  return /\b(payments?|checkout|wallet|wallets|signer|signers|stablecoin|settlement|merchant|merchants)\b/g.test(text);
}

function buildBuckets(
  recentCandidates: DigestCandidate[],
  topicMatches: DigestTopicMatches[],
  bucket: "required" | "focus",
  minEntries: number,
  maxEntries: number,
  minScore: number,
  domainRelevanceTerms: string[],
  bestTopicScore: Map<string, number>,
  topicBestMatchRatio: number
): SelectionBucket[] {
  return topicMatches.map((topicMatch) => ({
    topic: topicMatch.topic,
    bucket,
    candidates: rankedTopicCandidates(recentCandidates, topicMatch, minScore, domainRelevanceTerms, bestTopicScore, topicBestMatchRatio),
    minEntries,
    maxEntries,
    minScore
  }));
}

function rankedTopicCandidates(
  recentCandidates: DigestCandidate[],
  topicMatch: DigestTopicMatches,
  minScore: number,
  domainRelevanceTerms: string[],
  bestTopicScore: Map<string, number>,
  topicBestMatchRatio: number
): DigestCandidate[] {
  const exactMatches = recentCandidates.filter((candidate) => candidateMatchesTopic(candidate, topicMatch.topic));
  const vectorMatches = topicMatch.matches.filter((candidate) => {
    if (candidate.score < minScore) return false;
    if (!candidateHasTopicAnchor(candidate, topicMatch.topic)) return false;
    const best = bestTopicScore.get(candidate.id);
    return best === undefined || candidate.score >= best * topicBestMatchRatio;
  });
  const combined = [...exactMatches, ...vectorMatches];
  const seen = new Set<string>();

  return combined
    .map((candidate, index) => ({
      candidate,
      group: exactMatches.some((match) => match.id === candidate.id) ? 0 : 1,
      index
    }))
    .filter((item) => {
      if (seen.has(item.candidate.id)) return false;
      seen.add(item.candidate.id);
      return true;
    })
    .filter((item) => hasInformativeTitle(item.candidate, topicMatch.topic, domainRelevanceTerms))
    .sort((a, b) =>
      a.group - b.group ||
      representativeSort(b.candidate, a.candidate) ||
      b.candidate.score - a.candidate.score ||
      a.index - b.index
    )
    .map((item) => item.candidate);
}

function hasInformativeTitle(candidate: DigestCandidate, topic: string, domainRelevanceTerms: string[]): boolean {
  if ((candidate.summary ?? "").length >= 20) return true;
  const titleText = normalizeText(candidate.title ?? "");
  const words = titleText.split(/\s+/).filter(Boolean);
  const anchors = new Set(topicAnchorTerms(topic));
  const informative = words.filter((w) => !anchors.has(w));
  if (informative.length >= 4) return true;
  const otherDomainTerms = domainRelevanceTerms.filter((t) => !anchors.has(t));
  return hasDomainMatch(titleText, otherDomainTerms);
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
    let freshSelected = 0;

    for (const candidate of bucket.candidates) {
      if (bucketAdded >= target || state.selected.length >= options.maxEntries) break;
      const freshness = classifyFreshness(state, candidate, options);
      if (freshness.label !== "fresh") continue;
      if (!addSelected(state, candidate, {
        bucket: bucket.bucket,
        topic: bucket.topic,
        freshnessLabel: freshness.label
      }, options)) continue;
      bucketAdded += 1;
      freshSelected += 1;
      added += 1;
    }

    if (freshSelected > 0) continue;

    for (const candidate of bucket.candidates) {
      if (bucketAdded >= target || state.selected.length >= options.maxEntries) break;
      const freshness = classifyFreshness(state, candidate, options);
      if (freshness.label !== "follow_up") continue;
      if (!addSelected(state, candidate, {
        bucket: bucket.bucket,
        topic: bucket.topic,
        freshnessLabel: freshness.label
      }, options)) continue;
      bucketAdded += 1;
      added += 1;
    }
  }

  return added;
}

type FreshnessClassification =
  | { label: "fresh" }
  | { label: "follow_up"; cluster: EventCluster }
  | { label: "stale_repeat"; cluster: EventCluster };

function classifyFreshness(
  state: SelectionState,
  candidate: DigestCandidate,
  options: DigestSelectionOptions
): FreshnessClassification {
  const signature = eventSignature(candidate);
  const cluster = state.priorEventClusters.find((item) => sameCoverageEvent(item, signature));
  if (!cluster) return { label: "fresh" };
  if (!materiallyDistinctFact(cluster, signature)) return { label: "stale_repeat", cluster };
  if (currentCount(state.followupCounts, cluster) >= (options.maxFollowupsPerEvent ?? Number.POSITIVE_INFINITY)) {
    return { label: "stale_repeat", cluster };
  }
  return { label: "follow_up", cluster };
}

function addSelected(
  state: SelectionState,
  candidate: DigestCandidate,
  selection: Omit<SelectedDigestSource, "source">,
  options: DigestSelectionOptions
): boolean {
  if (state.seen.has(candidate.id)) return false;
  const titleKey = candidateTitleKey(candidate);
  if (titleKey && state.seenTitleKeys.has(titleKey)) return false;
  if (exceedsEventClusterCap(state, candidate)) return false;
  if (state.selected.length >= options.maxEntries) return false;
  if (exceedsCaps(state, candidate, options)) return false;

  state.selected.push({ source: candidate, ...selection });
  state.seen.add(candidate.id);
  if (titleKey) state.seenTitleKeys.add(titleKey);
  recordEventCluster(state, candidate);
  if (selection.freshnessLabel === "follow_up") {
    const signature = eventSignature(candidate);
    const priorCluster = state.priorEventClusters.find((item) => sameCoverageEvent(item, signature));
    if (priorCluster) increment(state.followupCounts, priorCluster);
  }
  increment(state.sourceTypeCounts, candidate.sourceType);
  increment(state.sourceKeyCounts, candidate.sourceKey);
  const authorKey = normalizedAuthor(candidate.author);
  if (authorKey) increment(state.authorCounts, authorKey);
  return true;
}

function buildPriorEventClusters(candidates: DigestCandidate[]): EventCluster[] {
  const clusters: EventCluster[] = [];
  for (const candidate of candidates) {
    const signature = eventSignature(candidate);
    const cluster = clusters.find((item) => sameCoverageEvent(item, signature));
    if (!cluster) {
      clusters.push(signature);
      continue;
    }
    for (const factKey of signature.factKeys) cluster.factKeys.add(factKey);
    for (const keyword of signature.keywords) cluster.keywords.add(keyword);
    for (const entity of signature.entities) cluster.entities.add(entity);
    cluster.candidates.push(candidate);
  }
  return clusters;
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

function candidateTitleKey(candidate: DigestCandidate): string | null {
  const title = normalizeEventText(stripPublisherSuffix(candidate.title ?? ""));
  return title || null;
}

function stripPublisherSuffix(title: string): string {
  return title.replace(/\s+-\s+[^-]+$/u, "").trim();
}

function exceedsEventClusterCap(state: SelectionState, candidate: DigestCandidate): boolean {
  const signature = eventSignature(candidate);
  const cluster = state.eventClusters.find((item) => sameCoverageEvent(item, signature));
  if (!cluster) return false;
  if (cluster.candidates.length >= 2) return true;
  return !materiallyDistinctFact(cluster, signature);
}

function recordEventCluster(state: SelectionState, candidate: DigestCandidate): void {
  const signature = eventSignature(candidate);
  const cluster = state.eventClusters.find((item) => sameCoverageEvent(item, signature));
  if (cluster) {
    cluster.candidates.push(candidate);
    for (const factKey of signature.factKeys) cluster.factKeys.add(factKey);
    for (const keyword of signature.keywords) cluster.keywords.add(keyword);
    for (const entity of signature.entities) cluster.entities.add(entity);
    return;
  }

  state.eventClusters.push({
    entities: signature.entities,
    keywords: signature.keywords,
    factKeys: signature.factKeys,
    candidates: [candidate]
  });
}

function sameCoverageEvent(cluster: EventCluster, signature: EventCluster): boolean {
  const sharedEntities = intersectionSize(cluster.entities, signature.entities);
  if (sharedEntities < 1) return false;

  const keywordOverlap = intersectionSize(cluster.keywords, signature.keywords);
  const smallerKeywordSetSize = Math.min(cluster.keywords.size, signature.keywords.size);
  return keywordOverlap >= 4 || (smallerKeywordSetSize >= 4 && keywordOverlap / smallerKeywordSetSize >= 0.6);
}

function materiallyDistinctFact(cluster: EventCluster, signature: EventCluster): boolean {
  if (signature.factKeys.size === 0) return false;
  for (const factKey of signature.factKeys) {
    if (!cluster.factKeys.has(factKey)) return true;
  }
  return false;
}

function eventSignature(candidate: DigestCandidate): EventCluster {
  const text = normalizeEventText([
    stripPublisherSuffix(candidate.title ?? ""),
    candidate.summary,
    ...entitySearchParts(candidate.entities)
  ].filter((part): part is string => Boolean(part)).join(" "));
  return {
    entities: majorEntityTerms(candidate),
    keywords: eventKeywords(text),
    factKeys: materialFactKeys(text),
    candidates: [candidate]
  };
}

function majorEntityTerms(candidate: DigestCandidate): Set<string> {
  const entities = entityNameParts(candidate.entities)
    .map(normalizeEntityTerm)
    .filter((value): value is string => Boolean(value));
  const text = normalizeEventText(`${candidate.title ?? ""} ${candidate.summary ?? ""}`);
  // domain-specific: companies tracked as named actors for event clustering
  const knownEntities = [
    "openai",
    "visa",
    "mastercard",
    "ripple",
    "trustap",
    "fastly",
    "skyfire",
    "google",
    "paypal",
    "stripe",
    "worldpay",
    "amazon",
    "microsoft",
    "anthropic"
  ].filter((entity) => text.includes(entity));
  return new Set([...entities, ...knownEntities]);
}

function entityNameParts(entities: unknown): string[] {
  if (!Array.isArray(entities)) return [];
  return entities.flatMap((entity) => {
    if (!entity || typeof entity !== "object") return [];
    const maybeEntity = entity as { name?: unknown };
    return typeof maybeEntity.name === "string" ? [maybeEntity.name] : [];
  });
}

function normalizeEntityTerm(value: string): string | null {
  const normalized = normalizeEventText(value);
  if (!normalized || EVENT_STOPWORDS.has(normalized)) return null;
  return normalized;
}

function eventKeywords(text: string): Set<string> {
  return new Set(text
    .split(" ")
    .map((term) => term.replace(/s$/u, ""))
    .filter((term) => term.length >= 4 && !EVENT_STOPWORDS.has(term))
    .slice(0, 30));
}

function materialFactKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const groups: Array<[string, RegExp]> = [
    ["checkout", /\bcheckout\b|\bcheckouts\b/u],
    ["stablecoin", /\bstablecoins?\b|\busdc\b|\busdt\b/u],
    ["tokenization", /\btokeni[sz]ation\b|\btokeni[sz]ed\b|\btokens?\b/u],
    ["protocol", /\bprotocol\b|\bstandard\b|\bframework\b/u]
  ];
  for (const [key, pattern] of groups) {
    if (pattern.test(text)) keys.add(key);
  }
  return keys;
}

function intersectionSize<T>(left: Set<T>, right: Set<T>): number {
  let size = 0;
  for (const item of left) {
    if (right.has(item)) size += 1;
  }
  return size;
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

const TOPIC_GENERIC_WORDS = new Set([
  "agentic", "ai", "artificial", "intelligence",
  "and", "or", "with", "for", "in", "of", "the", "a", "an",
  "area", "focus", "watchlist"
]);

function topicAnchorTerms(topic: string): string[] {
  return normalizeText(topic)
    .split(" ")
    .filter(Boolean)
    .filter((term) => !TOPIC_GENERIC_WORDS.has(term));
}

function topicsOverlap(left: string, right: string): boolean {
  const leftTerms = topicOverlapTerms(left);
  const rightTerms = topicOverlapTerms(right);
  if (leftTerms.size === 0 || rightTerms.size === 0) return false;
  const shared = intersectionSize(leftTerms, rightTerms);
  return shared === Math.min(leftTerms.size, rightTerms.size);
}

function topicOverlapTerms(topic: string): Set<string> {
  return new Set(normalizeText(topic)
    .split(" ")
    .filter(Boolean)
    .filter((term) => !TOPIC_GENERIC_WORDS.has(term)));
}

function requiresAgenticAnchor(topic: string): boolean {
  return topic.split(" ").includes("agentic") && topicAnchorTerms(topic).length > 0;
}

function hasAgenticConcept(text: string): boolean {
  return /\b(agent|agents|agentic|autonomous|automation|automated|ai|llm|llms|model|models)\b/.test(text);
}

function rankedImportantGeneralCandidates(candidates: DigestCandidate[], minScore: number, domainRelevanceTerms: string[]): DigestCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, score: importantGeneralScore(candidate, domainRelevanceTerms), index }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score || representativeSort(b.candidate, a.candidate) || a.index - b.index)
    .map((item) => item.candidate);
}

function importantGeneralScore(candidate: DigestCandidate, domainRelevanceTerms: string[]): number {
  if (candidate.sourceType === "clip") return 1000;
  const text = searchableText(candidate);
  const rawText = rawEntrySearchText(candidate.rawEntry);
  let score = 0;

  score += scoreMatches(text, [
    /\b(standard|standards|protocol|specification|framework|alliance|fido)\b/g,
    /\b(security|authentication|authorization|fraud|token|tokens|identity|trust|permission|permissions|vulnerability|vulnerabilities|backdoor|cve|cert)\b/g,
    /\b(regulation|regulatory|governance|compliance|policy)\b/g,
    /\b(launch|launched|release|released|introduced|published|donated|open sourced|open-source)\b/g,
    /\b(integration|integrated|partnered|partnership|collaboration|collaborates)\b/g
  ]);

  score += scoreMatches(text, strategicAnalysisPatterns());

  // domain-specific: companies whose mentions double the importance score
  score += scoreMatches(text, [
    /\b(google|apple|amazon|aws|microsoft|openai|anthropic|meta|visa|mastercard|paypal|stripe|american express|amex|alipay|worldpay)\b/g
  ]) * 2;

  score += scoreMatches(rawText, [
    /\b(likecount|retweetcount|replycount|bookmarkcount|viewcount)\b/g
  ]);

  if (candidate.sourceType === "twitter" && twitterEngagement(candidate.rawEntry) >= 100) score += 2;
  if (isSecurityAdvisory(candidate)) score += 5;
  score -= communityMetaPenalty(candidate);

  if (domainRelevanceTerms.length > 0 && !hasDomainMatch(text, domainRelevanceTerms)) score -= 5;

  return score;
}

function hasDomainMatch(text: string, domainTerms: string[]): boolean {
  const words = new Set(text.split(/\W+/).filter(Boolean));
  return domainTerms.some((term) => words.has(term));
}

function rankedGeneralCandidates(candidates: DigestCandidate[]): DigestCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, score: generalQualityScore(candidate), index }))
    .sort((a, b) => b.score - a.score || representativeSort(b.candidate, a.candidate) || a.index - b.index)
    .map((item) => item.candidate);
}

function representativeSort(left: DigestCandidate, right: DigestCandidate): number {
  return sameEventCandidates(left, right) ? representativeScore(left) - representativeScore(right) : 0;
}

function sameEventCandidates(left: DigestCandidate, right: DigestCandidate): boolean {
  const leftSignature = eventSignature(left);
  const rightSignature = eventSignature(right);
  return sameCoverageEvent(leftSignature, rightSignature);
}

function representativeScore(candidate: DigestCandidate): number {
  const summaryLength = normalizeText(candidate.summary ?? "").length;
  let score = 0;
  if (isSourcefulUrl(candidate.canonicalUrl)) score += 8;
  if (!isGoogleNewsWrapper(candidate.canonicalUrl)) score += 4;
  if (summaryLength >= 160) score += 3;
  else if (summaryLength >= 80) score += 2;
  else if (summaryLength >= 40) score += 1;
  if (entitySearchParts(candidate.entities).length > 0) score += 1;
  return score;
}

function isSourcefulUrl(input: string | null): boolean {
  if (!input) return false;
  try {
    const hostname = new URL(input).hostname.replace(/^www\./u, "");
    return OFFICIAL_OR_SOURCEFUL_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function isGoogleNewsWrapper(input: string | null): boolean {
  if (!input) return false;
  try {
    return new URL(input).hostname.replace(/^www\./u, "") === "news.google.com";
  } catch {
    return false;
  }
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
  if (isSecurityAdvisory(candidate)) score += 6;

  score -= scoreMatches(text, [
    /\b(is hiring|hiring|job|jobs)\b/g
  ]) * 4;
  score -= scoreMatches(text, [
    /\bcomments?\b/g,
    /\blacks detailed content\b/g,
    /\bno further analysis\b/g,
    /\blikely discusses\b/g
  ]) * 3;
  score -= communityMetaPenalty(candidate);

  if ((candidate.sourceType === "reddit" || candidate.sourceType === "hackernews" || candidate.sourceType === "twitter") && summaryLength < 40) score -= 2;

  return score;
}

function isSecurityAdvisory(candidate: DigestCandidate): boolean {
  const text = searchableText(candidate);
  return /\b(vulnerability|vulnerabilities|backdoor|cve|cert|security advisory|unauthorized remote access)\b/g.test(text) ||
    isOfficialSecurityDomain(candidate.canonicalUrl);
}

function isOfficialSecurityDomain(input: string | null): boolean {
  if (!input) return false;
  try {
    const hostname = new URL(input).hostname.replace(/^www\./u, "");
    return hostname === "kb.cert.org" || hostname.endsWith(".cert.org") || hostname === "cisa.gov";
  } catch {
    return false;
  }
}

// domain-specific: patterns that signal low-value community meta content
function communityMetaPenalty(candidate: DigestCandidate): number {
  const text = searchableText(candidate);
  return scoreMatches(text, [
    /\bhall of fame\b/g,
    /\bmodel civil war\b/g,
    /\bcommunity drama\b/g,
    /\brate limits?\b/g,
    /\bbypass(?:ed|ing)?\b/g,
    /\bab test\b/g,
    /\ba\/b\b/g,
    /\bcomplaint\b/g,
    /\boverrode my settings\b/g,
    /\bno response\b/g,
    /\bstill (no|waiting)\b/g,
    /\bwhy (is|isn't|won't|doesn't)\b/g
  ]) * 2;
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

// domain-specific: vocabulary that signals an article is strategic analysis rather than news
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

function normalizeEventText(value: string): string {
  return normalizeText(value)
    .normalize("NFKD")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/gu, " ")
    .replace(/\b20\d{2}\b/gu, " ")
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\b(?:announces?|announced|launches?|launched|introduces?|introduced|unveils?|unveiled|rolls?|rolled|partners?|partnered|reports?|reported|says|said|new|latest|update|updates|press|release|pr)\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const EVENT_STOPWORDS = new Set([
  "about",
  "after",
  "agent",
  "agentic",
  "also",
  "amid",
  "and",
  "article",
  "from",
  "into",
  "its",
  "more",
  "news",
  "open",
  "over",
  "said",
  "says",
  "that",
  "the",
  "their",
  "this",
  "through",
  "with"
]);

const OFFICIAL_OR_SOURCEFUL_DOMAINS = [
  "openai.com",
  "visa.com",
  "mastercard.com",
  "ripple.com",
  "trustap.com",
  "fastly.com",
  "skyfire.xyz",
  "paypal.com",
  "stripe.com",
  "worldpay.com",
  "googleblog.com",
  "blog.google",
  "microsoft.com",
  "anthropic.com",
  "sec.gov"
];
