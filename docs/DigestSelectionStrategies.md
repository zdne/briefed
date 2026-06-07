# Digest Selection Strategies

As PND adds sources, a 24-hour window can contain far more entries than should be sent to one digest prompt. The digest needs a selection stage before synthesis so high-volume sources do not drown out important topics.

## Current Behavior

Current digest generation is simple:

1. Load completed entries published during the lookback window.
2. Sort by `published_at DESC`.
3. Take `DIGEST_MAX_ENTRIES`.
4. Send those entries to the LLM.

This is predictable, but it can miss important required or focus topics when the newest entries are dominated by Twitter/X, Reddit, or another high-volume source.

## Strategy 1: Source Caps

Use deterministic per-source caps before the final prompt.

Example config:

```env
DIGEST_CANDIDATE_LIMIT=1000
DIGEST_MAX_ENTRIES=200
DIGEST_MAX_ARTICLE_ENTRIES=120
DIGEST_MAX_REDDIT_ENTRIES=40
DIGEST_MAX_HACKERNEWS_ENTRIES=40
DIGEST_MAX_TWITTER_ENTRIES=60
DIGEST_MAX_ENTRIES_PER_AUTHOR=5
DIGEST_MAX_ENTRIES_PER_SOURCE_KEY=50
```

For Twitter/X, apply basic engagement thresholds before source caps:

```env
DIGEST_TWITTER_MIN_LIKES=10
DIGEST_TWITTER_MIN_BOOKMARKS=2
DIGEST_TWITTER_MIN_VIEWS=1000
```

Pros:

- Cheap and deterministic.
- Easy to explain in logs.
- Prevents one source type from flooding the digest.

Cons:

- Can still miss required topics if those entries fall below source caps or engagement thresholds.
- Engagement-heavy social posts can crowd out low-engagement but strategically important topics.

## Strategy 2: Topic-Protected Selection

Recommended next step.

Treat `DIGEST_REQUIRED_TOPICS` and `DIGEST_FOCUS_AREAS` as selection requirements, not only synthesis instructions.

Pipeline:

1. Load a broad candidate pool, for example `DIGEST_CANDIDATE_LIMIT=1000`.
2. For each required topic, run vector search over recent entries and reserve matching sources.
3. For each focus area, run vector search over recent entries with a smaller reserved budget.
4. Fill remaining budget with source-balanced general signal.
5. Send the selected entries to the digest LLM.

Example config:

```env
DIGEST_CANDIDATE_LIMIT=1000
DIGEST_MAX_ENTRIES=200
DIGEST_REQUIRED_TOPIC_MIN_ENTRIES=8
DIGEST_FOCUS_AREA_MIN_ENTRIES=4
DIGEST_REQUIRED_TOPIC_MAX_ENTRIES=20
DIGEST_FOCUS_AREA_MAX_ENTRIES=12
```

Selection buckets:

- Required topic buckets: one bucket per `DIGEST_REQUIRED_TOPICS` item.
- Focus area buckets: one bucket per `DIGEST_FOCUS_AREAS` item.
- General bucket: source-balanced newest/high-signal entries.

An entry can satisfy more than one bucket but should only be included once in the final source list.

Pros:

- Strongly reduces the chance of missing a critical required topic.
- Keeps the digest aligned with durable user priorities.
- Still leaves room for unexpected general developments.

Cons:

- Requires topic matching before digest synthesis.
- Needs careful logging to explain why entries were selected.

## Topic Matching Options

### Keyword Match

Match topic strings against title, source summary, analyst summary, topic tags, entities, and content text.

Pros:

- Simple and cheap.
- Works immediately.

Cons:

- Brittle for synonyms and indirect references.

### Embedding Similarity

Embed each required topic/focus area and use vector search to retrieve matching recent entries.

Example:

```text
embed("agentic payments")
-> vector search over completed entries from the digest lookback window
-> reserve top matches for the "agentic payments" digest bucket
```

Pros:

- Better recall for paraphrases and adjacent language.
- Uses embeddings already stored for each entry.
- Works for embedding-only Twitter, Reddit, and Hacker News entries that do not have LLM-generated topic tags.

Cons:

- Needs threshold tuning.
- Can pull semantically adjacent but irrelevant entries.

### Hybrid Match

Use embedding similarity as the primary retrieval mechanism, with keyword matches as a boost and exact-match safety net.

Recommended approach:

1. For each topic/focus phrase, run vector search constrained to the digest lookback window.
2. Boost entries with exact keyword/entity/topic-tag matches.
3. Always include high-confidence exact matches if they pass basic quality checks.
4. Apply source and author diversity within each topic bucket.

## Recommended MVP Implementation

Implement vector-first topic-protected selection with conservative defaults:

```env
DIGEST_CANDIDATE_LIMIT=1000
DIGEST_MAX_ENTRIES=200
DIGEST_REQUIRED_TOPIC_MIN_ENTRIES=6
DIGEST_REQUIRED_TOPIC_MAX_ENTRIES=16
DIGEST_FOCUS_AREA_MIN_ENTRIES=3
DIGEST_FOCUS_AREA_MAX_ENTRIES=10
DIGEST_GENERAL_MAX_ENTRIES=120
DIGEST_MAX_ENTRIES_PER_AUTHOR=5
DIGEST_MAX_ENTRIES_PER_SOURCE_KEY=50
```

Algorithm:

1. Fetch up to `DIGEST_CANDIDATE_LIMIT` recent completed entries with source metadata and raw source JSON.
2. Embed each configured required topic and focus area, caching topic embeddings during the digest run.
3. For each required topic:
   - Vector-search recent entries using the topic embedding.
   - Boost exact keyword/entity/topic-tag matches.
   - Include high-confidence exact matches even if engagement is low.
   - Keep at least `DIGEST_REQUIRED_TOPIC_MIN_ENTRIES` when enough matches exist.
   - Cap at `DIGEST_REQUIRED_TOPIC_MAX_ENTRIES`.
4. For each focus area:
   - Vector-search recent entries using the focus-area embedding.
   - Boost exact keyword/entity/topic-tag matches.
   - Keep at least `DIGEST_FOCUS_AREA_MIN_ENTRIES` when enough matches exist.
   - Cap at `DIGEST_FOCUS_AREA_MAX_ENTRIES`.
5. Fill the remaining budget with general high-signal entries using source caps, author caps, and recency.
6. Deduplicate sources while preserving bucket priority.
7. Log selection counts by bucket and source type.

Example log:

```text
920 eligible entries found
selected 42 required-topic entries across 5 topics
selected 18 focus-area entries across 4 areas
selected 120 general entries
final digest source count: 180
omitted 740 entries by topic/source/author limits
```

## Implementation Notes

- `recentContent()` should return source metadata: `source_type`, `source_key`, raw source JSON, topic tags, and entities.
- Add a recent vector-search query that filters by `published_at`, `enrichment_status = 'complete'`, and non-null `embedding`.
- Twitter/X selection can inspect `raw_entry.likeCount`, `bookmarkCount`, `viewCount`, and `retweetCount`.
- Required topic buckets should bypass engagement thresholds. A low-engagement tweet can still be useful if it is semantically close to or exactly matches a required topic.
- Final source ordering should put required-topic selections first, then focus selections, then general selections.
- The digest prompt should receive bucket labels so the LLM knows which selected sources support required topics.
