# Features

Tracker of potential features to add to pnd:

## Current

- [x] Better markdown reports 
- [x] Steer the digest with topics that i am interested in 
- [x] Access twitter using [xurl](https://github.com/xdevplatform/xurl)
- [x] Prioritize sources
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

  There is no limit like:

  DIGEST_MAX_ENTRIES_PER_SOURCE_KEY=50

  So one noisy source can still dominate if it has many matching/new entries. Example: one Twitter list or one Feedbin feed could take a lot of the general
  fill.

  2. Author diversity caps

  There is no limit like:

  DIGEST_MAX_ENTRIES_PER_AUTHOR=5

  So if one author posts 30 relevant tweets/articles, many of them can land in the digest.

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
    apply source/author caps
    still keep newest/relevant articles in the mix

  Why it matters: with Twitter added, volume jumps. Without diversity and engagement scoring, digest selection can overrepresent high-volume feeds or prolific
  posters. The current system protects topics; the next refinement would protect signal quality and variety.
