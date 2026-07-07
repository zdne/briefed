# How Briefed.sh Works

Briefed.sh supports multiple optional collectors: direct RSS/Atom polling, Gmail newsletter sync, TwitterAPI.io list sync, and Feedbin sync. Postgres and pgvector provide the local archive, OpenAI provides embeddings, and OpenAI or Anthropic provide language-model synthesis.

Direct RSS/Atom items, Gmail newsletters, Twitter/X list tweets, and Feedbin entries are normalized into the same `content` table. Source identity fields keep collectors separate while shared embeddings make every collector searchable through queries and eligible for briefings.

```text
RSS/Atom feeds ────┐
Gmail newsletters ─┤
TwitterAPI.io ─────┤
Feedbin API ───────┘
        │
        └─ sync CLIs ─> normalize/dedupe ─> Postgres + pgvector ─┬─ CLI query/digest render
                                      │                          ├─ HTTP API query
                                      │                          └─ local MCP tools
                                      │                             ├─ brief: vector query archive
                                      │                             ├─ briefing: read stored digest
                                      │                             └─ create_briefing: query PG + synthesize + store
                                      ├─ OpenAI embeddings
                                      └─ LLM enrichment and synthesis
```

## Direct RSS/Atom Sync

`npm run cli -- sync-rss` imports feeds from `feeds.json`, or from a path supplied with `--feeds`.

The feed config is JSON so agents can manage it deterministically:

```json
{
  "version": 1,
  "feeds": [
    {
      "title": "AI Agents",
      "url": "https://www.reddit.com/r/AI_Agents.rss",
      "category": "reddit",
      "enabled": true
    }
  ]
}
```

RSS sync fetches enabled feeds sequentially, sends a configured user agent, applies per-request timeouts, and waits `RSS_FETCH_DELAY_MS` between feeds. Reddit feeds use the larger `RSS_REDDIT_FETCH_DELAY_MS` inter-feed delay, which defaults to 10 seconds. This is separate from `RSS_REQUEST_TIMEOUT_MS`, which is the HTTP request timeout.

`REDDIT_RSS_USER` and `REDDIT_RSS_FEED` are recommended for Reddit feeds. Get these account-scoped values from an authenticated Reddit RSS URL such as `https://www.reddit.com/r/example.rss?user=<user>&feed=<feed>`. Briefed.sh appends them only to outbound Reddit RSS requests. They are not stored in `feeds.json`, source keys, canonical URLs, or logs. Without them, Reddit RSS is likely to hit rate limits. Before fetching Reddit RSS, the client also bootstraps cookies from `https://www.reddit.com/` and sends the resulting cookie names only to Reddit requests.

When `REDDIT_RSS_DEBUG=true`, debug logs include redacted request URLs, `has_user`, `has_feed`, feed token length, request headers with cookie values redacted, Reddit cookie names, response status, content type, `retry-after`, and Reddit `x-ratelimit-*` headers. If a stale Reddit domain retry blocks testing, remove the `sync_state` row for `rss:domain:reddit.com:state`.

RSS stores items with `source_key = 'rss:feed:<feed_hash>'`. Each feed has JSON state in `sync_state` under `rss:feed:<feed_hash>:state`, including recent item IDs, newest published timestamp, last success, last error, retry-after, auth mode, and overflow count.

The collector uses feed-provided content only. It does not fetch original article pages in v1. It processes at most `RSS_MAX_ITEMS_PER_FEED` newest matching items per feed per run. Use `npm run cli -- sync-rss --hours 48` for the first run to avoid importing large historical feeds.

HTTP 429 is treated as a soft per-feed failure. Briefed.sh records retry-after state, skips that feed while retry-after is active, and continues syncing other feeds. Reddit 429s also set a shared `rss:domain:reddit.com:state` retry window so the same run does not hammer the next subreddit feed immediately.

## Feedbin Sync Pipeline

Feedbin is one optional collector. Use it when you want Feedbin as an input source; use direct RSS and Gmail when you want Briefed to collect feeds and newsletters directly.

Run:

```bash
npm run sync-feedbin
```

The sync command:

1. Reads the last successful Feedbin cursor from `sync_state`.
2. Requests Feedbin entries created after that timestamp.
3. Follows Feedbin pagination and reports total and per-entry progress.
4. Normalizes each entry:
   - Converts HTML into plain text.
   - Removes common tracking parameters from canonical URLs.
   - Preserves the original Feedbin JSON.
5. Stores or updates the entry in `content`.
6. Deduplicates entries using Feedbin entry ID and canonical URL.
7. Selects the entry's enrichment strategy.
8. Stores enrichment results and an embedding.
9. Advances the Feedbin cursor only after the complete sync finishes.

It is safe to interrupt sync with `Ctrl-C`. Already processed entries remain stored, but the cursor is not advanced. The next sync may revisit those entries, and deduplication prevents duplicate rows.

Feedbin limits pages to 100 entries. Briefed.sh follows Feedbin's pagination links and refuses to advance the cursor if Feedbin reports more matching records than were fetched.

To clear a bad cursor and safely rescan the full Feedbin archive:

```bash
npm run cli -- sync-feedbin --reset-cursor
```

Existing entries are deduplicated during the rescan.

For a recent-only initial sync or backfill:

```bash
npm run cli -- sync-feedbin --hours 48
npm run cli -- sync-feedbin --days 7
```

These options temporarily override the starting cursor without changing the stored cursor before processing. After all matching pages finish successfully, Briefed.sh stores the newest fetched Feedbin timestamp as the next incremental cursor. This is normally close to the present, but deliberately uses Feedbin's timestamp rather than the local clock to avoid skipping entries.

If a recent-only sync is interrupted, the previous stored cursor remains unchanged. Resume using the same lookback option. If Feedbin returns no matching entries, Briefed.sh also leaves the existing cursor unchanged.

## Gmail Newsletter Sync

`npm run cli -- sync-gmail` imports newsletters from a configured Gmail query or label.

Gmail setup uses a Google OAuth Desktop client:

1. Create/select a Google Cloud project.
2. Enable the Gmail API.
3. Configure OAuth consent, add your account as a test user, and include `https://www.googleapis.com/auth/gmail.readonly`.
4. Create an OAuth client with application type `Desktop app`.
5. Put the client values in `.env`.
6. Run `npm run gmail-auth` to generate `GMAIL_REFRESH_TOKEN`.

Configure OAuth refresh-token credentials plus one message selector:

```env
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_LABEL=newsletter
GMAIL_MAX_MESSAGES=1
```

`GMAIL_LABEL` defaults to `newsletter` and is converted to a Gmail query like `label:newsletter`. Use `GMAIL_QUERY=label:newsletters` when you need a full Gmail search expression instead.

The `gmail-auth` helper is intentionally separate from Gmail sync: it starts a temporary `127.0.0.1` callback server, prints a Google OAuth URL with the readonly Gmail scope and PKCE challenge, waits for the browser loopback callback, exchanges the code, prints `GMAIL_REFRESH_TOKEN=...`, and exits. No tunnel is needed when the browser and CLI run on the same machine.

Gmail sync lists matching messages, fetches full payloads, parses the subject, sender, snippet, internal date, and text body, then stores each message with `source_key = 'gmail:query:<query_hash>'`. It uses Gmail internal date as the v1 cursor in `sync_state` and advances the cursor only after selected messages are processed. HTML bodies are converted to text when no plain-text body is available.

## Twitter/X List Sync

`npm run sync-twitter` imports the configured Twitter/X lists through TwitterAPI.io.

Configure:

```env
TWITTERAPI_IO_API_KEY=...
TWITTERAPI_LIST_IDS=2062878395029983324
TWITTERAPI_LIST_MAX_PAGES=3
TWITTERAPI_LIST_MAX_TWEETS=200
```

For each list, Briefed.sh stores the newest successfully processed tweet ID in `sync_state` under `twitterapi:list:<list_id>:latest_id`. A normal run fetches newest tweets first and stops when it reaches that stored tweet. If the stored tweet is not reached, sync continues only up to the configured page and tweet limits. The sync summary records pages fetched, tweets returned and processed, whether a next cursor was present, and the reason the list stopped.

Twitter/X entries use `source_key = 'twitterapi:list:<list_id>'`, `source_item_id = '<tweet_id>'`, and `source_type = 'twitter'`. Normalization keeps the tweet author, URL, text, quoted or retweeted tweet text, and attached article title or preview when present. Twitter/X entries are embedding-only by default because `twitter` is included in `LIGHTWEIGHT_SOURCE_TYPES`.

## Source Detection

Briefed.sh currently assigns one of four `source_type` values:

- `article`: entries that are not classified as a known lightweight source.
- `reddit`: canonical URLs on a Reddit hostname with a path beginning with `/r/`.
- `hackernews`: canonical URLs on `news.ycombinator.com/item` with an `id` query parameter.
- `twitter`: posts imported from Twitter/X list APIs.

This source type controls the default enrichment policy. It does not prevent an entry from appearing in queries or briefings.

## Enrichment Modes

Each entry records an `enrichment_mode`:

- `full`: LLM analysis plus embedding.
- `embedded_only`: embedding without individual LLM analysis.

### Full Enrichment

Full enrichment makes two AI requests per entry.

First, the configured LLM receives the title and normalized text and returns:

- `summary`: a concise factual summary.
- `topics`: short lowercase topic tags.
- `entities`: important named entities and their types.

Briefed.sh validates the response, normalizes and deduplicates tags/entities, and caps them at 10 topics and 30 entities. Excess valid items are trimmed instead of failing the complete enrichment.

Second, OpenAI creates a 1,536-dimension embedding from the title, generated summary, topics, and full text.

Full enrichment is the default for article entries.

### Lightweight Embedding-Only Strategy

Reddit, Hacker News, and Twitter/X feeds can be high volume, and their entries are often post or discussion wrappers rather than complete source articles. Individually summarizing every item would increase LLM calls, token usage, and sync duration before the MVP has demonstrated that item-level analysis is valuable.

By default:

```env
LIGHTWEIGHT_SOURCE_TYPES=reddit,hackernews,twitter
```

For each lightweight item, Briefed.sh stores:

- Source identity and original JSON. Every entry uses `source_key` and `source_item_id`; for example, Feedbin entries use `source_key = 'feedbin:feed:<feed_id>'`, RSS entries use `source_key = 'rss:feed:<feed_hash>'`, Gmail entries use `source_key = 'gmail:query:<query_hash>'`, and Twitter/X list entries can use `source_key = 'twitterapi:list:<list_id>'`.
- Canonical URL, title, author, and timestamps.
- Original HTML and normalized full post text.
- Source-provided summary when available.
- An OpenAI embedding generated from the title and full post text.
- `analyst_summary` copied from the source-provided summary.
- Empty generated topic tags and entities.
- `source_type = 'reddit'`, `source_type = 'hackernews'`, or `source_type = 'twitter'`.
- `enrichment_mode = 'embedded_only'`.
- `enrichment_status = 'complete'`.

This keeps lightweight entries semantically searchable and eligible for briefings while avoiding one LLM analysis call per item.

RSS/Feedbin Reddit content generally contains the original post body, but it does not contain comments, discussion summaries, scores, or reliable engagement signals.

RSS/Feedbin Hacker News content is normally the HN item or discussion wrapper, not the full linked article.

## Upgrading Lightweight Enrichment

The lightweight policy is reversible. Stored embedding-only entries can be upgraded to full enrichment without fetching them from the original collector again.

```bash
# Fully enrich the newest 20 eligible Reddit entries
npm run cli -- enrich --source reddit --limit 20

# Fully enrich the newest 20 eligible Hacker News entries
npm run cli -- enrich --source hackernews --limit 20

# Fully enrich the newest 20 eligible Twitter/X entries
npm run cli -- enrich --source twitter --limit 20

# Fully enrich up to 100 Reddit entries collected in the last seven days
npm run cli -- enrich --source reddit --limit 100 --hours 168

# Fully enrich every eligible stored Reddit entry
npm run cli -- enrich --source reddit --all
```

The command selects newest entries first. It upgrades `embedded_only` entries, retries pending or failed entries, and retries entries stuck in `processing` for more than 15 minutes.

To change which non-article source types use embedding-only sync:

```env
LIGHTWEIGHT_SOURCE_TYPES=reddit,hackernews,twitter
```

Remove a source from this list to fully enrich it during future syncs.

Completed fully enriched entries are not downgraded if the setting later changes back to `embedded_only`.

## Semantic Queries

Run:

```bash
npm run cli -- query "What changed in AI agent observability?"
npm run cli -- query-followup "Which of these seem most important?"
```

Or send a request to `POST /query`.

Briefed.sh:

1. Creates an OpenAI embedding for the question.
2. Uses pgvector cosine similarity to retrieve relevant archived entries.
3. Sends the retrieved titles, summaries, URLs, and dates to the configured LLM.
4. Returns a synthesized answer with `[1]`-style citations and a source list.

Both fully enriched and embedding-only lightweight entries participate in semantic retrieval.

The CLI renders queries as Markdown by default, including clickable source links, authors, dates, summaries, and similarity scores. Query answers are prompted to stay brief: 3-5 cited bullets, with an optional short list of best sources to open. Query results are saved as Markdown under `QUERY_OUTPUT_DIR` unless `--no-save` is supplied. Saved Markdown is not echoed to stdout. Use `--format json` for machine-readable stdout, or `--save-json` to also write a visible JSON sidecar. CLI query progress logs are written to stderr so stdout remains usable for Markdown or JSON piping.

`npm run cli -- query-followup "<question>"` uses the latest saved query session as context. Briefed.sh stores that context in a hidden `.latest.json` state file in `QUERY_OUTPUT_DIR`. It reuses the previous answer and sources, calls the LLM for synthesis, and saves the follow-up as a new query session. It does not run a new embedding search.

## Daily Briefing

Run:

```bash
npm run digest
npm run digest -- --style warm
npm run digest -- --emit-canonical
npm run digest -- --hours 48
npm run digest -- --hours 24 --days-ago 3
npm run digest -- --canonical-only
npm run cli -- digest canonical
```

The briefing command:

1. Loads completed entries published during the lookback period.
2. Loads a broader recent candidate pool controlled by `DIGEST_CANDIDATE_LIMIT`.
3. Uses vector search for each configured required topic and focus area.
4. Selects protected topic buckets, then fills the remaining budget with newest-published general entries.
5. Sends selected titles, stored summaries, URLs, and dates to the configured LLM.
6. Asks the LLM to create a canonical source-grounded briefing.
7. Stores the canonical briefing in the local `digests` table.
8. Unless `--canonical-only` is set, asks the LLM for a friendly Markdown rewrite.
9. Writes the briefing Markdown file. With `--emit-canonical`, it also writes the canonical Markdown; when `--output` is supplied, the canonical file is written beside that output path.

Embedding-only lightweight entries remain eligible for the briefing. The briefing sees their source-provided summaries rather than individually generated LLM summaries. Their embeddings are still used for required-topic and focus-area source selection.

To prevent unexpectedly large or expensive LLM requests, Briefed.sh sends at most `DIGEST_MAX_ENTRIES` selected entries. The default is `200`. Briefing logs report the total eligible count, candidate count, and final required-topic, focus-area, and general source counts.

Briefing topic config protects important topics during selection and shapes the synthesis prompt:

```env
DIGEST_REQUIRED_TOPICS=agentic payments, agentic B2B, agentic commerce, personal memory
DIGEST_FOCUS_AREAS=MCP, AI observability, agent frameworks
```

Required topics always appear under a required watchlist section. If the selected sources have no meaningful update for one of those topics, the briefing explicitly says there was no signal in the window. Focus areas are softer interests; the briefing highlights them only when there is meaningful source-backed signal.

Each briefing is stored in Postgres in canonical form and written as a timestamped Markdown file under `DIGEST_OUTPUT_DIR`. The default CLI output is a friendly briefing; `--emit-canonical` writes the canonical Markdown alongside the friendly output, while `--canonical-only` and `digest canonical` write only the canonical Markdown with Obsidian-compatible frontmatter, briefing body, and clickable sources. Inline canonical citations use Obsidian heading links such as `[[#Source 32|32]]`, and source titles link to original URLs. Point `DIGEST_OUTPUT_DIR` at an Obsidian vault folder to make generated briefings appear there without an additional integration.

CLI Markdown is the default and is written to a file without echoing the document to stdout. `--format json` prints machine-readable output. Progress logs are written to stderr so JSON stdout remains parseable.

`npm run cli -- digest canonical` re-renders the latest stored canonical briefing from Postgres without calling the LLM. Use `--id <briefing_id>` to render a specific stored briefing. MCP briefing tools continue to create and return canonical briefing Markdown, not the CLI-only friendly rewrite.

## Local And External Data

The normalized archive, generated enrichment, embeddings, cursors, and briefings are stored locally in Postgres.

External requests still occur:

- Feedbin supplies entries when Feedbin sync is used.
- RSS/Atom feed hosts supply entries when direct RSS sync is used.
- Gmail supplies messages when newsletter sync is used.
- TwitterAPI.io supplies configured Twitter/X list timelines.
- OpenAI receives text for embeddings.
- The configured LLM provider receives text for full enrichment, queries, and briefings.
