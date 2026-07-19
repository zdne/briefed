# How Briefed Works

Briefed collects content from optional sources — RSS/Atom feeds, Gmail newsletters, Twitter/X lists, and Feedbin — normalizes everything into a shared Postgres archive, enriches entries with OpenAI embeddings and LLM summaries, and generates briefings grounded in your configured topics.

```text
RSS/Atom feeds ────┐
Gmail newsletters ─┤
TwitterAPI.io ─────┤  sync → normalize → Postgres + pgvector
Feedbin API ───────┘  (optional)               │
                                               ├─ MCP tools (brief / briefing)
                                        OpenAI embeddings    ├─ CLI digest → Markdown
                                        LLM enrichment       └─ CLI query → Markdown
```

`npm run sync` reads `briefed.config.json` and runs every enabled collector. `--hours` and `--days` apply as lookbacks to RSS, Gmail, and Feedbin; Twitter/X uses a stored latest-tweet cursor. The aggregate sync reports per-collector results as JSON, records failures, continues to later collectors, and exits nonzero if any enabled collector failed.

---

## Collectors

### Direct RSS/Atom

`npm run cli -- sync-rss` polls feeds from `collectors.rss.feeds` in `briefed.config.json`. Feeds are fetched sequentially with a configurable inter-feed delay. Reddit feeds use the longer `RSS_REDDIT_FETCH_DELAY_MS` delay (default 10s).

The collector uses feed-provided content only — it does not fetch original article pages. It processes at most `RSS_MAX_ITEMS_PER_FEED` newest matching items per feed per run. For an initial sync of a large feed archive, use `--hours 48` to avoid importing everything at once.

HTTP 429 is a soft per-feed failure: Briefed records a retry-after, skips that feed while the retry window is active, and continues with remaining feeds. Reddit 429s also set a shared `rss:domain:reddit.com:state` retry window so consecutive subreddit feeds aren't hammered in the same run.

**Reddit RSS credentials** are strongly recommended. Without `REDDIT_RSS_USER` and `REDDIT_RSS_FEED`, Reddit RSS frequently hits rate limits. Get them from an authenticated Reddit RSS URL at `https://www.reddit.com/prefs/feeds`. Briefed appends them only to outbound Reddit RSS requests — they are not stored in source keys, canonical URLs, or logs.

When `REDDIT_RSS_DEBUG=true`, logs include redacted request URLs, request headers, cookie names, response status, content-type, `retry-after`, and `x-ratelimit-*` headers. To clear a stale Reddit domain retry, delete the `sync_state` row for `rss:domain:reddit.com:state`.

RSS feed state is stored in `sync_state` under `rss:feed:<feed_hash>:state` as JSON, including recent item IDs, newest published timestamp, last success, last error, retry-after, and overflow count.

### Gmail newsletters

`npm run cli -- sync-gmail` imports newsletters matching a configured Gmail query or label.

Gmail sync lists matching messages, fetches full payloads, parses subject/sender/snippet/internal-date/body, and stores each message with `source_key = 'gmail:query:<query_hash>'`. HTML bodies are converted to text when no plain-text body is available. The cursor is Gmail internal date, stored in `sync_state` and advanced only after all selected messages are processed.

The `gmail-auth` helper starts a temporary `127.0.0.1` callback server, prints an OAuth URL, waits for the browser loopback, exchanges the code, and prints `GMAIL_REFRESH_TOKEN`. No tunnel is needed when the browser and CLI are on the same machine.

### Twitter/X lists

`npm run sync-twitter` imports configured Twitter/X lists through TwitterAPI.io.

For each list, Briefed stores the newest successfully processed tweet ID in `sync_state` under `twitterapi:list:<list_id>:latest_id`. A normal run fetches newest tweets first and stops when it reaches that stored tweet. If the stored tweet is not reached, sync stops at the configured page/tweet limits. Twitter/X entries use `source_key = 'twitterapi:list:<list_id>'` and `source_type = 'twitter'`.

### Feedbin (optional)

`npm run sync-feedbin` syncs Feedbin entries using HTTP Basic Auth credentials.

1. Reads the last successful Feedbin cursor from `sync_state`.
2. Requests Feedbin entries created after that timestamp, following pagination.
3. Normalizes each entry: converts HTML to plain text, removes tracking parameters from canonical URLs, preserves original JSON.
4. Upserts into `content`, deduplicating by Feedbin entry ID and canonical URL.
5. Enriches or embeds each new entry.
6. Advances the cursor only after the complete sync finishes.

Feedbin limits pages to 100 entries. Briefed refuses to advance the cursor if Feedbin reports more records than pagination returned.

Safe to interrupt with Ctrl-C — stored entries remain, cursor is not advanced, the next run deduplicates. To clear a bad cursor and rescan the full archive:

```bash
npm run cli -- sync-feedbin --reset-cursor
```

### Manual clipping

`npm run cli -- clip` and the `clip` MCP tool save a URL or text directly to the archive, bypassing the collector schedule. They can also **mark an existing archive item as clipped** by id — flagging something already collected (an article read in a briefing, for example) for later retrieval, without re-fetching or re-enriching it.

**URL clips** — Briefed fetches the page, extracts the title, and converts the HTML body to plain text (15s timeout). Deduplicated by a hash of the URL: re-clipping the same URL upserts the existing entry.

**Text clips** — Text is stored directly with no fetch. Deduplicated by a hash of the content.

**Marking by id** — `clip --id <n>` stamps `clipped_at` (and optionally `clip_note`) on the existing `content` row. The item keeps its original `source_type` and content. Marking is idempotent: re-marking updates the note without changing the original clip time. Content ids are returned in the structured results of the `brief`, `briefing`, and `clips` MCP tools, so an agent can resolve "clip source 3 from my briefing" to an id and mark it.

URL/text clips accept an optional `--title` override; all forms accept an optional `--note`. For new clips the note is appended to the content before enrichment and also stored in `source_summary`; for marked items it is stored as the clip note.

```bash
npm run cli -- clip --url https://example.com/article
npm run cli -- clip --url https://example.com/article --note "relevant to agentic payments"
npm run cli -- clip --text "interesting finding..." --title "My note"
npm run cli -- clip --id 10234 --note "revisit for research"
```

**Cloudflare and bot-challenge pages**

Some sites return HTTP 200 with a Cloudflare or bot-challenge page rather than a real error. Briefed detects this by inspecting the response body for known patterns (`cf-browser-verification`, `cf_chl_` tokens, cookies-required messages, "Attention Required! | Blocked"). When detected:

- The fetched content is discarded — the challenge page is not stored or enriched.
- The canonical URL is preserved — the clip exists in the archive and is findable.
- `fetchBlocked: true` is returned. Via MCP, the agent receives a message suggesting it use `web_search` to retrieve the content and re-clip with `--text`. Via CLI, a warning is printed.

**Effect on briefings and queries**

Clipped state is tracked by `clipped_at` on the `content` row, orthogonal to `source_type`:

- **Fresh URL/text clips** get `source_type = 'clip'`, are always fully enriched, and receive a fixed priority in digest selection — regardless of keyword score, they are placed in the `important_general` bucket before any keyword-scored entries, so they appear in the next briefing.
- **Marked existing items** keep their original `source_type` and are **permanently excluded from future briefings** — they were already briefed once, and marking retires them from digest candidacy (both the recency pool and topic vector matches). There is no unclip command; clearing `clipped_at` via SQL is the escape hatch.
- **`brief` queries boost clipped items**: `retrieveRelevant` adds `QUERY_CLIP_BOOST` (default 0.05, `0` disables) to the similarity score of any clipped row, so saved items outrank equally relevant unclipped content. Query results carry a `clipped: true` flag per source. The boost is applied in process after an index-friendly over-fetch (3× limit) so the HNSW embedding index stays usable.

**Retrieval**

```bash
npm run cli -- clips                    # list 10 most recently saved items
npm run cli -- clips --limit 20         # list more
npm run cli -- clips "agentic payments" # semantic search over saved items
```

The list covers everything saved — fresh clips and marked items alike — ordered by when you saved them (`clipped_at DESC`).

Via MCP: the `clips` tool accepts an optional `query` for semantic search or returns a chronological list when omitted.

---

## Source Types and Enrichment

### Source types

Each entry is assigned one of five `source_type` values:

- `article` — entries not classified as a known lightweight source
- `reddit` — canonical URLs on a Reddit hostname with a path beginning with `/r/`
- `hackernews` — canonical URLs on `news.ycombinator.com/item` with an `id` query parameter
- `twitter` — posts imported from Twitter/X list APIs
- `clip` — manually saved URLs or text via the `clip` command or MCP tool

Source type controls the default enrichment policy.

### Enrichment modes

Each entry records an `enrichment_mode`:

**`full`** — Two AI calls per entry:
1. LLM receives title + normalized text and returns `summary`, `topics` (3-8 lowercase tags, capped at 10), and `entities` (up to 30 named entities with types).
2. OpenAI creates a 1,536-dimension embedding from the title, generated summary, topics, and full text.

Default for `article` and `clip` entries. Clips always use full enrichment regardless of `LIGHTWEIGHT_SOURCE_TYPES`.

**`embedded_only`** — One AI call per entry:
1. OpenAI creates a 1,536-dimension embedding from title + full text.
2. Source-provided summary is copied to `analyst_summary`; topic tags and entities are empty.

Default for `reddit`, `hackernews`, and `twitter` (controlled by `LIGHTWEIGHT_SOURCE_TYPES`). These sources are often high-volume post or discussion wrappers; skipping per-item LLM analysis keeps sync fast and cost predictable.

Both modes participate in vector search and briefing source selection.

### Automatic upgrade during sync

When a new lightweight entry is synced, Briefed embeds its title and content and checks cosine similarity against all configured topics (required topics + focus areas). If the similarity meets `ENRICHMENT_TOPIC_UPGRADE_THRESHOLD` (default 0.35), the entry is automatically upgraded to full enrichment — LLM summary, topic tags, and entities — without requiring a separate `enrich` run. Entries below the threshold are stored as `embedded_only` as usual.

This means on-topic posts (e.g. "New payments wallet for agents") receive a full summary and are considered alongside articles in briefing selection, while off-topic posts (e.g. "Built an MCP server for MyFitnessPal" when fitness is not a configured topic) remain `embedded_only` and are filtered at selection time.

### Upgrading embedded-only entries manually

Stored `embedded_only` entries can be upgraded to full enrichment without re-fetching from the source:

```bash
npm run cli -- enrich --source reddit --limit 20
npm run cli -- enrich --source hackernews --limit 20
npm run cli -- enrich --source twitter --limit 20
npm run cli -- enrich --source reddit --limit 100 --hours 168
npm run cli -- enrich --source reddit --all
```

The command selects newest entries first, upgrades `embedded_only`, retries failed or pending entries, and recovers entries stuck in `processing` for more than 15 minutes.

To change which non-article source types use embedding-only sync, set `LIGHTWEIGHT_SOURCE_TYPES` in `.env` and remove a type from the list to fully enrich it during future syncs. Completed full-enrichment entries are never downgraded.

---

## Source Selection for Briefings

Briefing source selection runs before LLM synthesis to prevent high-volume sources from drowning out important topics.

1. Load up to `DIGEST_CANDIDATE_LIMIT` enriched entries published in the briefing lookback window.
2. For each `requiredTopic`, embed the topic phrase and vector-search recent entries to fill a protected bucket.
3. For each `focusArea`, do the same with a smaller budget.
4. Fill the remaining budget with newest general entries, subject to source-type and author caps.
5. Deduplicate across buckets while preserving bucket priority (required → focus → general).

Selection counts are logged: required-topic count, focus-area count, important-general count, general count.

**Domain relevance filter:** terms are extracted from all configured topic names (stripping common English grammar words). Entries in the general and important-general buckets that contain none of these terms receive a score penalty and are skipped when the feed is focused on a specific domain. This prevents off-topic content from filling "Other Items" when all configured topics are domain-specific.

**Cross-topic filter:** when a vector match scores much higher for a different topic than the one it was retrieved for, it is rejected from the current topic's bucket. Specifically, a candidate is rejected if its similarity to topic T is less than `DIGEST_TOPIC_BEST_MATCH_RATIO × best_score_across_all_topics`. This catches cases where a topic shares a broad concept (e.g. "agentic") with a specialized topic (e.g. "Agentic Payments") — an article about workplace AI that happens to score 0.32 for "Agentic Payments" but 0.45 for "Agentic AI" would be filtered from the payments bucket since 0.32 < 0.45 × 0.75. Exact text matches (articles that contain the topic name verbatim) are never filtered.

**Bucket controls:**

| Variable | Default | Effect |
|---|---|---|
| `DIGEST_REQUIRED_TOPIC_MIN_ENTRIES` | 3 | Minimum sources reserved per required topic |
| `DIGEST_REQUIRED_TOPIC_MAX_ENTRIES` | 5 | Maximum sources per required topic |
| `DIGEST_FOCUS_AREA_MIN_ENTRIES` | 2 | Minimum sources reserved per focus area |
| `DIGEST_FOCUS_AREA_MAX_ENTRIES` | 4 | Maximum sources per focus area |
| `DIGEST_REQUIRED_TOPIC_MIN_SCORE` | 0.30 | Minimum cosine similarity for required-topic matches |
| `DIGEST_FOCUS_AREA_MIN_SCORE` | 0.35 | Minimum cosine similarity for focus-area matches |
| `DIGEST_TOPIC_BEST_MATCH_RATIO` | 0.75 | Cross-topic filter: reject a vector match if its score for this topic < ratio × best score across all topics |
| `DIGEST_IMPORTANT_GENERAL_MIN_SCORE` | 3 | Minimum keyword score for important-general entries |
| `DIGEST_IMPORTANT_GENERAL_MAX_ENTRIES` | 12 | Cap on important-general entries |
| `DIGEST_GENERAL_MAX_ENTRIES` | 120 | Cap on general fill entries |

**Diversity caps:**

| Variable | Default | Effect |
|---|---|---|
| `DIGEST_MAX_ARTICLE_ENTRIES` | 80 | Cap on article-type entries per briefing |
| `DIGEST_MAX_REDDIT_ENTRIES` | 25 | Cap on Reddit entries per briefing |
| `DIGEST_MAX_HACKERNEWS_ENTRIES` | 15 | Cap on Hacker News entries per briefing |
| `DIGEST_MAX_TWITTER_ENTRIES` | 20 | Cap on Twitter entries per briefing |
| `DIGEST_MAX_ENTRIES_PER_SOURCE_KEY` | 20 | Cap per feed/list/source key per briefing |
| `DIGEST_MAX_ENTRIES_PER_AUTHOR` | 4 | Cap per normalized author per briefing |
| `DIGEST_MAX_ENTRIES` | 200 | Hard cap on total entries sent to one briefing prompt |
| `DIGEST_REPEAT_LOOKBACK_HOURS` | 72 | Hours of prior briefing history checked for repeat suppression |
| `DIGEST_MAX_FOLLOWUPS_PER_EVENT` | 1 | Max follow-up sources allowed for a recently briefed event |

---

## Briefing Output

The briefing command:

1. Loads candidates and runs topic-aware selection.
2. Sends selected entries to the configured LLM for a canonical source-grounded briefing.
3. Stores the canonical briefing in the `digests` table.
4. Writes the canonical Markdown file to `DIGEST_OUTPUT_DIR`.
5. Generates a friendly Markdown rewrite too, if `--friendly` was passed.

**Output modes:**

```bash
npm run digest                        # canonical Markdown only (Obsidian-friendly)
npm run digest -- --friendly          # friendly + canonical Markdown
npm run digest -- --friendly --style warm    # warmer newsletter tone
npm run cli -- digest canonical       # re-render latest stored briefing without LLM
npm run cli -- digest canonical --id 4
npm run cli -- digest friendly --id 4 --style warm
```

Point `DIGEST_OUTPUT_DIR` at an Obsidian vault folder for automatic Obsidian-compatible briefings. Canonical output uses Obsidian heading links (`[[#Source 32|32]]`) and frontmatter.

---

## Semantic Queries

```bash
npm run cli -- query "What changed in AI agent observability?"
npm run cli -- query-followup "Which of these seem most important?"
```

Query flow:
1. Embeds the question with OpenAI.
2. Uses pgvector cosine similarity to retrieve up to `QUERY_LIMIT` relevant entries; clipped items get a `QUERY_CLIP_BOOST` similarity bonus so saved sources rank higher.
3. Sends retrieved titles, summaries, URLs, and dates to the LLM.
4. Returns a cited answer with `[1]`-style inline citations and a source list.

Query output is saved as Markdown under `QUERY_OUTPUT_DIR` by default. Use `--no-save` to print to stdout instead. Use `--format json` for machine-readable output. Progress logs go to stderr.

`query-followup` uses the latest saved query session as context (stored in `.latest.json` in `QUERY_OUTPUT_DIR`). It reuses the prior answer and sources without running a new embedding search.

---

## MCP Server

`npm run mcp` starts a Model Context Protocol server that exposes the Briefed archive to any MCP-capable agent (Claude, Claude Code, etc.). Connect it by pointing your MCP client at the process using the `mcp` script.

### Available tools (`brief:*`)

| Tool | Purpose |
|---|---|
| `brief` | Semantic query over the archive — citations, similarity scores, source metadata |
| `briefing` | Render the latest stored digest (or a specific one by id) |
| `clip` | Save a URL or freeform text to the archive; returns `fetchBlocked` if Cloudflare intercepted |
| `clips` | List recent clips or semantic-search across them |
| `get_user_config` | Read the full user config (topics, feeds, collectors) |
| `update_user_config` | Full-replacement write of the user config |
| `update_collectors` | Full-replacement write of the collectors section only |
| `update_briefing_preferences` | Full-replacement write of requiredTopics + focusAreas only |
| `health` | Returns DB connectivity, row counts, and last-sync timestamps |

All update tools are **full-replacement**: they overwrite the entire section, not individual fields. Always call `get_user_config` first and echo every unchanged field back verbatim. Omitting a feed deletes it.

### `briefed-setup` skill

`briefed-setup.skill` is a Claude Code skill file that guides a Claude agent through first-time setup and ongoing optimization of Briefed. Load it in Claude Code with `/run briefed-setup` (or the equivalent in your MCP client).

**First-time setup:** the skill interviews the user about their professional focus, core beats, and background interests; translates them into `requiredTopics` and `focusAreas` with vocabulary tuned to match how trade press actually writes; and proposes a minimal collector set (RSS feeds, Google News query feeds, Reddit subs, Gmail label, Twitter list). It writes preferences and collectors via the MCP tools and verifies both writes landed.

**Ongoing optimization:** the skill audits an existing config by sampling signal quality per required topic via `brief` (reading per-source similarity scores), reviewing the latest `briefing` for empty sections, and diagnosing root causes (label mismatch, missing dedicated feed, umbrella/duplicate topic, high-volume noise feed). It proposes a diff before writing anything.

Key rules the skill enforces:
- Topics are **embedding queries** — label specificity and phrasing directly determine which articles surface
- Every required topic should have at least one dedicated quoted Google News feed; relying on general sources for a required topic leads to empty sections
- Disable (`enabled: false`), don't delete underperforming feeds — preserves audit trail
- Never remove Gmail or Twitter collectors without explicit user instruction

---

## Data Model

- **`content`** — normalized source content, enrichment output, and vector embedding.
- **`sync_state`** — KV store for collector cursors and per-feed state.
- **`digests`** — generated briefing body and referenced content IDs.

Failed enrichments are stored with `enrichment_status = 'failed'` and an error message for inspection and future retry.

---

## All Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://pnd:pnd@localhost:5432/pnd` | Postgres connection string. For Neon: `postgresql://<user>:<pass>@ep-xxx.region.aws.neon.tech/neondb?sslmode=require` |
| `PG_POOL_MAX` | `3` | Max Postgres pool connections per process. Set to `2` for Neon free tier. |
| `PG_QUERY_TIMEOUT_MS` | `30000` | Client- and server-side query timeout (ms). Prevents hung queries from stalling the sync when Neon drops a connection silently. |
| `PORT` | `3000` | HTTP server port |
| `OPENAI_API_KEY` | — | Required for embeddings |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model (fixed at 1536 dimensions) |
| `LLM_PROVIDER` | `openai` | `openai` or `anthropic` |
| `OPENAI_LLM_MODEL` | `gpt-4.1-mini` | OpenAI model for enrichment and synthesis |
| `ANTHROPIC_API_KEY` | — | Required when `LLM_PROVIDER=anthropic` |
| `ANTHROPIC_LLM_MODEL` | `claude-3-5-haiku-latest` | Anthropic model for enrichment and synthesis |
| `LIGHTWEIGHT_SOURCE_TYPES` | `reddit,hackernews,twitter` | Source types that use embedding-only enrichment |
| `ENRICHMENT_TOPIC_UPGRADE_THRESHOLD` | `0.35` | Cosine similarity threshold for auto-upgrading lightweight posts to full enrichment at sync time |
| `QUERY_LIMIT` | `8` | Default vector matches passed to query synthesis |
| `QUERY_CLIP_BOOST` | `0.05` | Similarity bonus for clipped items in query retrieval (`0` disables) |
| `DIGEST_HOURS` | `24` | Default briefing lookback window |
| `DIGEST_CANDIDATE_LIMIT` | `1000` | Newest completed entries loaded before topic selection |
| `DIGEST_MAX_ENTRIES` | `200` | Hard cap on entries sent to one briefing prompt |
| `DIGEST_REQUIRED_TOPIC_MIN_ENTRIES` | `3` | Minimum sources reserved per required topic |
| `DIGEST_REQUIRED_TOPIC_MAX_ENTRIES` | `5` | Maximum sources per required topic |
| `DIGEST_FOCUS_AREA_MIN_ENTRIES` | `2` | Minimum sources reserved per focus area |
| `DIGEST_FOCUS_AREA_MAX_ENTRIES` | `4` | Maximum sources per focus area |
| `DIGEST_REQUIRED_TOPIC_MIN_SCORE` | `0.30` | Minimum cosine similarity for required-topic matches |
| `DIGEST_FOCUS_AREA_MIN_SCORE` | `0.35` | Minimum cosine similarity for focus-area matches |
| `DIGEST_TOPIC_BEST_MATCH_RATIO` | `0.75` | Cross-topic filter ratio; set to 1.0 to disable |
| `DIGEST_IMPORTANT_GENERAL_MIN_SCORE` | `3` | Minimum keyword score for important-general entries |
| `DIGEST_IMPORTANT_GENERAL_MAX_ENTRIES` | `12` | Cap on important-general entries per briefing |
| `DIGEST_GENERAL_MAX_ENTRIES` | `120` | Cap on general fill entries per briefing |
| `DIGEST_MAX_ARTICLE_ENTRIES` | `80` | Cap on article entries per briefing |
| `DIGEST_MAX_REDDIT_ENTRIES` | `25` | Cap on Reddit entries per briefing |
| `DIGEST_MAX_HACKERNEWS_ENTRIES` | `15` | Cap on Hacker News entries per briefing |
| `DIGEST_MAX_TWITTER_ENTRIES` | `20` | Cap on Twitter entries per briefing |
| `DIGEST_MAX_ENTRIES_PER_SOURCE_KEY` | `20` | Cap per source key (feed/list) per briefing |
| `DIGEST_MAX_ENTRIES_PER_AUTHOR` | `4` | Cap per normalized author per briefing |
| `DIGEST_REPEAT_LOOKBACK_HOURS` | `72` | Hours of prior briefing history for repeat suppression |
| `DIGEST_MAX_FOLLOWUPS_PER_EVENT` | `1` | Max follow-up sources per recently briefed event |
| `DIGEST_OUTPUT_DIR` | `output/briefings` | Directory for generated briefing Markdown |
| `QUERY_OUTPUT_DIR` | `output/queries` | Directory for generated query Markdown |
| `RSS_FETCH_DELAY_MS` | `1500` | Inter-feed delay for RSS (ms) |
| `RSS_REDDIT_FETCH_DELAY_MS` | `10000` | Inter-feed delay for Reddit RSS (ms) |
| `RSS_MAX_ITEMS_PER_FEED` | `50` | Max items processed per feed per run |
| `RSS_USER_AGENT` | `briefed-rss/0.1` | User-Agent header for RSS requests |
| `RSS_REQUEST_TIMEOUT_MS` | `15000` | HTTP request timeout for RSS fetches (ms) |
| `REDDIT_RSS_USER` | — | Reddit RSS credential (from authenticated RSS URL) |
| `REDDIT_RSS_FEED` | — | Reddit RSS credential (from authenticated RSS URL) |
| `REDDIT_RSS_DEBUG` | `false` | Log redacted Reddit RSS request/response details |
| `GMAIL_CLIENT_ID` | — | Google OAuth client ID |
| `GMAIL_CLIENT_SECRET` | — | Google OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | — | Gmail OAuth refresh token (from `npm run gmail-auth`) |
| `GMAIL_MAX_MESSAGES` | `50` | Max Gmail messages fetched per sync |
| `TWITTERAPI_IO_API_KEY` | — | TwitterAPI.io API key |
| `TWITTERAPI_IO_BASE_URL` | `https://api.twitterapi.io` | TwitterAPI.io base URL |
| `TWITTERAPI_LIST_MAX_PAGES` | `3` | Max pages fetched per Twitter list per sync |
| `TWITTERAPI_LIST_MAX_TWEETS` | `200` | Max tweets processed per Twitter list per sync |
| `FEEDBIN_EMAIL` | — | Feedbin account email |
| `FEEDBIN_PASSWORD` | — | Feedbin account password |
| `FEEDBIN_BASE_URL` | `https://api.feedbin.com/v2` | Feedbin API base URL |
| `USER_CONFIG_PATH` | `briefed.config.json` | Path to user config file |
