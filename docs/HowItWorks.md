# How Briefed Works

Briefed collects content from optional sources — RSS/Atom feeds, Gmail newsletters, Twitter/X lists, and Feedbin — normalizes everything into a shared Postgres archive, enriches entries with OpenAI embeddings and LLM summaries, and generates briefings grounded in your configured topics.

```text
RSS/Atom feeds ────┐
Gmail newsletters ─┤
TwitterAPI.io ─────┤  sync → normalize → Postgres + pgvector
Feedbin API ───────┘  (optional)               │
                                               ├─ MCP tools (brief / briefing / create_briefing)
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

---

## Source Types and Enrichment

### Source types

Each entry is assigned one of four `source_type` values:

- `article` — entries not classified as a known lightweight source
- `reddit` — canonical URLs on a Reddit hostname with a path beginning with `/r/`
- `hackernews` — canonical URLs on `news.ycombinator.com/item` with an `id` query parameter
- `twitter` — posts imported from Twitter/X list APIs

Source type controls the default enrichment policy.

### Enrichment modes

Each entry records an `enrichment_mode`:

**`full`** — Two AI calls per entry:
1. LLM receives title + normalized text and returns `summary`, `topics` (3-8 lowercase tags, capped at 10), and `entities` (up to 30 named entities with types).
2. OpenAI creates a 1,536-dimension embedding from the title, generated summary, topics, and full text.

Default for `article` entries.

**`embedded_only`** — One AI call per entry:
1. OpenAI creates a 1,536-dimension embedding from title + full text.
2. Source-provided summary is copied to `analyst_summary`; topic tags and entities are empty.

Default for `reddit`, `hackernews`, and `twitter` (controlled by `LIGHTWEIGHT_SOURCE_TYPES`). These sources are often high-volume post or discussion wrappers; skipping per-item LLM analysis keeps sync fast and cost predictable.

Both modes participate in vector search and briefing source selection.

### Upgrading embedded-only entries

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

**Bucket controls:**

| Variable | Default | Effect |
|---|---|---|
| `DIGEST_REQUIRED_TOPIC_MIN_ENTRIES` | 6 | Minimum sources reserved per required topic |
| `DIGEST_REQUIRED_TOPIC_MAX_ENTRIES` | 16 | Maximum sources per required topic |
| `DIGEST_FOCUS_AREA_MIN_ENTRIES` | 3 | Minimum sources reserved per focus area |
| `DIGEST_FOCUS_AREA_MAX_ENTRIES` | 10 | Maximum sources per focus area |
| `DIGEST_REQUIRED_TOPIC_MIN_SCORE` | 0.25 | Minimum cosine similarity for required-topic matches |
| `DIGEST_FOCUS_AREA_MIN_SCORE` | 0.35 | Minimum cosine similarity for focus-area matches |
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
4. Generates a friendly Markdown rewrite (unless `--canonical-only`).
5. Writes the Markdown file to `DIGEST_OUTPUT_DIR`.

**Output modes:**

```bash
npm run digest                        # friendly Markdown
npm run digest -- --style warm        # warmer newsletter tone
npm run digest -- --emit-canonical    # friendly + canonical Markdown
npm run digest -- --canonical-only    # canonical Markdown only (Obsidian-friendly)
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
2. Uses pgvector cosine similarity to retrieve up to `QUERY_LIMIT` relevant entries.
3. Sends retrieved titles, summaries, URLs, and dates to the LLM.
4. Returns a cited answer with `[1]`-style inline citations and a source list.

Query output is saved as Markdown under `QUERY_OUTPUT_DIR` by default. Use `--no-save` to print to stdout instead. Use `--format json` for machine-readable output. Progress logs go to stderr.

`query-followup` uses the latest saved query session as context (stored in `.latest.json` in `QUERY_OUTPUT_DIR`). It reuses the prior answer and sources without running a new embedding search.

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
| `DATABASE_URL` | `postgres://pnd:pnd@localhost:5432/pnd` | Postgres connection string |
| `PG_POOL_MAX` | `3` | Max Postgres pool connections per process |
| `PORT` | `3000` | HTTP server port |
| `OPENAI_API_KEY` | — | Required for embeddings |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model (fixed at 1536 dimensions) |
| `LLM_PROVIDER` | `openai` | `openai` or `anthropic` |
| `OPENAI_LLM_MODEL` | `gpt-4.1-mini` | OpenAI model for enrichment and synthesis |
| `ANTHROPIC_API_KEY` | — | Required when `LLM_PROVIDER=anthropic` |
| `ANTHROPIC_LLM_MODEL` | `claude-3-5-haiku-latest` | Anthropic model for enrichment and synthesis |
| `LIGHTWEIGHT_SOURCE_TYPES` | `reddit,hackernews,twitter` | Source types that use embedding-only enrichment |
| `QUERY_LIMIT` | `8` | Default vector matches passed to query synthesis |
| `DIGEST_HOURS` | `24` | Default briefing lookback window |
| `DIGEST_CANDIDATE_LIMIT` | `1000` | Newest completed entries loaded before topic selection |
| `DIGEST_MAX_ENTRIES` | `200` | Hard cap on entries sent to one briefing prompt |
| `DIGEST_REQUIRED_TOPIC_MIN_ENTRIES` | `6` | Minimum sources reserved per required topic |
| `DIGEST_REQUIRED_TOPIC_MAX_ENTRIES` | `16` | Maximum sources per required topic |
| `DIGEST_FOCUS_AREA_MIN_ENTRIES` | `3` | Minimum sources reserved per focus area |
| `DIGEST_FOCUS_AREA_MAX_ENTRIES` | `10` | Maximum sources per focus area |
| `DIGEST_REQUIRED_TOPIC_MIN_SCORE` | `0.25` | Minimum cosine similarity for required-topic matches |
| `DIGEST_FOCUS_AREA_MIN_SCORE` | `0.35` | Minimum cosine similarity for focus-area matches |
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
