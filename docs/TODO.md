# Features

Tracker of potential features to add to brief:

## Interim TODO
- [ ] check why "Square launches agentic commerce integrations with ChatGPT, Claude - Digital Commerce 360" PG: 7356 is not in the digest

## Current

- [x] Better markdown reports 
- [x] Steer the briefing with topics that i am interested in
- [x] Access twitter using [xurl](https://github.com/xdevplatform/xurl)
- [x] Prioritize sources
- [x] Basic briefing diversity caps
- [x] Basic briefing relevance thresholds
- [x] Local MCP
- [ ] MCP / CLI feedback "hey i dont like this story in here" 

## Later / TBD

- [ ] Twitter engagement scoring: Further improvement to briefing pre-qualification (see below)
- [ ] TBD: Hook Apify to read LinkedIn posts
- [ ] Run sync / briefing periodically
- [ ] TBD: Remote MCP
- [ ] TBD: Turn this into a service

---

## Notes on features

### Further improvement to briefing pre-qualification
• Right now selection is bucket-based, but not yet quality/diversity-balanced inside those buckets.

  Current behavior:

  required topic buckets
    -> focus area buckets
    -> newest general fill

  Within each bucket:

  - exact text/topic/entity matches come first,
  - then vector matches above configured score thresholds,
  - duplicates are removed,
  - per-topic max caps are applied.

  Current controls:

  DIGEST_REQUIRED_TOPIC_MIN_SCORE=0.25
  DIGEST_FOCUS_AREA_MIN_SCORE=0.35
  DIGEST_IMPORTANT_GENERAL_MIN_SCORE=3

  Implemented controls:

  1. Source diversity caps

  There are source-type and source-key limits:

  DIGEST_MAX_REDDIT_ENTRIES=25
  DIGEST_MAX_TWITTER_ENTRIES=20
  DIGEST_MAX_ARTICLE_ENTRIES=80
  DIGEST_MAX_HACKERNEWS_ENTRIES=15
  DIGEST_MAX_ENTRIES_PER_SOURCE_KEY=20

  This prevents one source type or one noisy source key from dominating if it has many matching/new entries.

  2. Author diversity caps

  There is an author limit:

  DIGEST_MAX_ENTRIES_PER_AUTHOR=4

  This limits repeated posts from one author in a single briefing.

  Remaining work:

  1. Twitter engagement scoring

  For Twitter/X entries, we currently treat them mostly like any other embedded item. We do not yet inspect fields like:

  likeCount
  retweetCount
  replyCount
  bookmarkCount
  viewCount

  So a semantically relevant but low-signal tweet can rank similarly to a highly engaged tweet, except for recency/vector similarity/exact match.

  The intended next layer would be:

  required topics:
    allow low-engagement matches if semantically close/exact

  focus/general:
    prefer higher engagement Twitter posts
    source/author caps already apply
    still keep newest/relevant articles in the mix

  Why it matters: with Twitter added, volume jumps. Without diversity and engagement scoring, briefing selection can overrepresent high-volume feeds or prolific
  posters. The current system protects topics; the next refinement would protect signal quality and variety.
