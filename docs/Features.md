# Features

Tracker of potential features to add to pnd:

## Current

- [x] Better markdown reports 
- [x] Steer the digest with topics that i am interested in 
- [x] Access twitter using [xurl](https://github.com/xdevplatform/xurl)
- [x] Prioritize sources
- [x] Basic digest diversity caps
- [ ] Further improvement to digest pre-qualification (see below)

## Later / TBD

- [ ] Turn this into a service
- [ ] Run sync / digest periodically
- [ ] Web UI
- [ ] MCP

---

## Notes on features

### Further improvement to digest pre-qualification
• Right now selection is bucket-based, but not yet quality/diversity-balanced inside those buckets.

  Current behavior:

  required topic buckets
    -> focus area buckets
    -> newest general fill

  Within each bucket:

  - exact text/topic/entity matches come first,
  - then vector matches,
  - duplicates are removed,
  - per-topic max caps are applied.

  What it does not do yet:

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

  This limits repeated posts from one author in a single digest.

  3. Twitter engagement scoring

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

  Why it matters: with Twitter added, volume jumps. Without diversity and engagement scoring, digest selection can overrepresent high-volume feeds or prolific
  posters. The current system protects topics; the next refinement would protect signal quality and variety.
