# Briefed.sh

**Your agent's morning read.**

Briefed is a personal news intelligence layer for you and your agents. It syncs your feeds, enriches and embeds every entry, and generates a daily briefing grounded in your interests — ready to serve via MCP. Ask questions over your archive, get cited answers, and let your agents keep you informed without the noise.

Example MCP prompt:

- "What's my latest briefing?"
- "Give me a brief on agentic payments"
- "Brief me on recent topics from Twitter."

## Architecture

```text
Feedbin API ───────┐
RSS/Atom feeds ────┤
Gmail newsletters ─┤
TwitterAPI.io ─────┘
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

The MVP uses Feedbin's `GET /v2/entries.json?since=...` endpoint, direct RSS/Atom feed polling from `feeds.json`, Gmail newsletter sync, and TwitterAPI.io list timelines as collectors. Entries are deduplicated by source identity and canonicalized URL.

## Prerequisites

- Node.js 22+
- Docker with Compose
- Colima, if using Docker through Colima on macOS
- Feedbin account, `feeds.json`, or Gmail credentials for at least one collector
- OpenAI API key for embeddings
- OpenAI or Anthropic API key for enrichment and answer synthesis

## Setup

```bash
cp .env.example .env
# Fill in model-provider credentials and at least one collector.
# For RSS, copy feeds.example.json to feeds.json and tune it.

colima start # If using Colima on macOS.
docker compose up -d postgres
npm install
npm run db:migrate
npm run cli -- sync-rss --hours 48
```

After a system restart, start Colima before bringing Postgres back up:

```bash
colima start
docker compose up -d postgres
```

If port `5432` is already occupied, start Postgres with another host port and update `DATABASE_URL`:

```bash
POSTGRES_PORT=55432 docker compose up -d postgres
```

Query from the CLI:

```bash
npm run cli -- query "What changed in AI infrastructure this week?"
```

Start and query the API:

```bash
npm run dev

curl -s http://localhost:3000/query \
  -H 'content-type: application/json' \
  -d '{"question":"What changed in AI infrastructure this week?","limit":8}'
```

The response contains an answer with `[1]`-style inline citations and a matching `sources` array.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run db:migrate` | Apply SQL migrations |
| `npm run sync` | Incrementally fetch, normalize, enrich, and embed entries |
| `npm run cli -- sync --hours 48` | Sync only entries created within the last 48 hours |
| `npm run cli -- sync --days 7` | Sync only entries created within the last seven days |
| `npm run cli -- sync --reset-cursor` | Clear the cursor and safely rescan the complete Feedbin archive |
| `npm run cli -- sync-rss --hours 48` | Sync direct RSS/Atom feeds from `feeds.json` with a lookback |
| `npm run cli -- sync-rss --feeds feeds.example.json` | Sync direct RSS/Atom feeds from a specific feed config |
| `npm run cli -- sync-gmail --hours 48` | Sync Gmail newsletters using the configured query or label |
| `npm run sync-twitter` | Sync configured Twitter/X lists through TwitterAPI.io |
| `npm run cli -- enrich --source reddit --limit 20` | Fully enrich the newest 20 eligible Reddit entries |
| `npm run cli -- enrich --source hackernews --limit 20` | Fully enrich the newest 20 eligible Hacker News entries |
| `npm run cli -- enrich --source twitter --limit 20` | Fully enrich the newest 20 eligible Twitter/X entries |
| `npm run cli -- enrich --source reddit --limit 100 --hours 168` | Fully enrich up to 100 Reddit entries from the last seven days |
| `npm run cli -- enrich --source reddit --all` | Fully enrich every eligible stored Reddit entry |
| `npm run cli -- enrich --source article --limit 20` | Retry or fully enrich eligible article entries |
| `npm run cli -- query "<question>"` | Query the archive from the terminal |
| `npm run cli -- query "<question>" --format json` | Print machine-readable query JSON |
| `npm run cli -- query "<question>" --output output/query.md` | Write a query result to Markdown |
| `npm run cli -- query-followup "<question>"` | Ask a follow-up using the latest saved query context |
| `npm run digest` | Generate, store, and write a friendly briefing for the last 24 hours |
| `npm run digest -- --style warm` | Generate a warmer friendly briefing |
| `npm run digest -- --emit-canonical` | Generate a friendly briefing and also write the canonical briefing |
| `npm run digest -- --canonical-only` | Generate and write only the canonical briefing |
| `npm run cli -- digest canonical` | Re-render the latest stored canonical briefing as Markdown without calling the LLM |
| `npm run cli -- digest canonical --id 4` | Re-render a specific stored canonical briefing |
| `npm run cli -- digest friendly` | Re-render the latest stored briefing as friendly Markdown |
| `npm run cli -- digest friendly --id 4 --style warm` | Re-render a specific stored briefing as warm friendly Markdown |
| `npm run digest -- --hours 48` | Generate a briefing with a custom lookback |
| `npm run digest -- --hours 24 --days-ago 3` | Generate a 24-hour briefing window ending three days ago |
| `npm run digest -- --format json` | Print machine-readable friendly briefing JSON while still writing Markdown |
| `npm run dev` | Start the API with reload |
| `npm run mcp` | Start the local stdio MCP server for agents |
| `npm test` | Run unit tests |

Run sync and briefing generation from cron, a systemd timer, or a scheduler:

```cron
*/15 * * * * cd /path/to/brief && /usr/bin/npm run sync-rss >> /var/log/brief-rss-sync.log 2>&1
0 7 * * * cd /path/to/brief && /usr/bin/npm run digest >> /var/log/briefing.log 2>&1
```

## Configuration

See [`.env.example`](.env.example). Important values:

- `FEEDBIN_EMAIL`, `FEEDBIN_PASSWORD`: Feedbin HTTP Basic Auth credentials.
- `RSS_FEEDS_PATH`: JSON feed-list path for direct RSS/Atom sync; defaults to `feeds.json`.
- `RSS_FETCH_DELAY_MS`, `RSS_REDDIT_FETCH_DELAY_MS`, `RSS_MAX_ITEMS_PER_FEED`, `RSS_USER_AGENT`, `RSS_REQUEST_TIMEOUT_MS`: direct RSS fetch safety limits. `RSS_REDDIT_FETCH_DELAY_MS` is the delay before Reddit feed fetches; `RSS_REQUEST_TIMEOUT_MS` is the HTTP request timeout.
- `REDDIT_RSS_USER`, `REDDIT_RSS_FEED`: recommended for Reddit feeds. These Reddit RSS preference parameters come from an authenticated Reddit RSS URL and are appended only to outbound Reddit RSS requests. Without them, Reddit RSS is likely to hit rate limits.
- `REDDIT_RSS_DEBUG`: when true, logs redacted Reddit RSS request URLs, request headers, cookie names, status, content type, and rate-limit headers.
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`: Gmail OAuth credentials for newsletter sync.
- `GMAIL_QUERY` or `GMAIL_LABEL`: Gmail search query or label used to select newsletters.
- `GMAIL_MAX_MESSAGES`: maximum Gmail messages to fetch per sync; defaults to `50`.
- `DATABASE_URL`: Postgres connection string. For shared prototype storage, use a Neon Postgres pooled connection string; local Docker Postgres remains the dev/offline default.
- `PG_POOL_MAX`: maximum Postgres pool connections per process; defaults to `3` for long-running MCP sessions.
- `TWITTERAPI_IO_API_KEY`: TwitterAPI.io key for `sync-twitter`.
- `TWITTERAPI_LIST_IDS`: comma-separated Twitter/X list IDs to sync.
- `TWITTERAPI_LIST_MAX_PAGES`, `TWITTERAPI_LIST_MAX_TWEETS`: bounded sync limits; defaults to `3` and `200`.
- `OPENAI_API_KEY`: always required because embeddings use OpenAI.
- `LLM_PROVIDER`: `openai` or `anthropic`.
- `LIGHTWEIGHT_SOURCE_TYPES`: comma-separated source types that use embedding-only sync by default; defaults to `reddit,hackernews,twitter`.
- `OPENAI_EMBEDDING_MODEL`: defaults to `text-embedding-3-small`; storage is fixed at 1536 dimensions.
- `QUERY_LIMIT`: default number of vector matches passed to answer synthesis.
- `DIGEST_MAX_ENTRIES`: hard cap on selected entries sent to one briefing request; defaults to `200`.
- `DIGEST_CANDIDATE_LIMIT`: newest completed entries loaded before topic-aware selection; defaults to `1000`.
- `DIGEST_REQUIRED_TOPIC_MIN_ENTRIES`, `DIGEST_REQUIRED_TOPIC_MAX_ENTRIES`: per-topic vector bucket sizing for required topics; defaults to `3` and `5`.
- `DIGEST_FOCUS_AREA_MIN_ENTRIES`, `DIGEST_FOCUS_AREA_MAX_ENTRIES`: per-topic vector bucket sizing for focus areas; defaults to `2` and `4`.
- `DIGEST_REQUIRED_TOPIC_MIN_SCORE`, `DIGEST_FOCUS_AREA_MIN_SCORE`: minimum vector similarity for topic matches; defaults to `0.25` and `0.35`.
- `DIGEST_IMPORTANT_GENERAL_MIN_SCORE`: minimum keyword score for important-general entries; defaults to `3`.
- `DIGEST_GENERAL_MAX_ENTRIES`: cap for newest general-fill entries after protected topic buckets; defaults to `120`.
- `DIGEST_MAX_REDDIT_ENTRIES`, `DIGEST_MAX_TWITTER_ENTRIES`, `DIGEST_MAX_ARTICLE_ENTRIES`, `DIGEST_MAX_HACKERNEWS_ENTRIES`: source-type caps for one briefing; defaults to `25`, `20`, `80`, and `15`.
- `DIGEST_MAX_ENTRIES_PER_SOURCE_KEY`: cap per feed/list/source key for one briefing; defaults to `20`.
- `DIGEST_MAX_ENTRIES_PER_AUTHOR`: cap per normalized author for one briefing; defaults to `4`.
- `DIGEST_REPEAT_LOOKBACK_HOURS`: recent stored briefing history used to suppress stale repeat coverage; defaults to `72`.
- `DIGEST_MAX_FOLLOWUPS_PER_EVENT`: max material follow-up sources allowed for a recently briefed event; defaults to `1`.
- `DIGEST_REQUIRED_TOPICS`: comma-separated durable watchlist topics that always appear in briefings, even with no new signal.
- `DIGEST_FOCUS_AREAS`: comma-separated softer interests that are highlighted only when relevant source-backed signal exists.
- `DIGEST_OUTPUT_DIR`: directory for generated briefing Markdown; defaults to `output/briefings`.
- `QUERY_OUTPUT_DIR`: directory for generated query Markdown and JSON sidecars; defaults to `output/queries`.

## API

- `GET /health`: checks database connectivity.
- `POST /query`: accepts `{"question":"...","limit":8}`.

## Local MCP

Run the local stdio MCP server:

```bash
npm run mcp
```

The MCP server is local-only and unauthenticated. Do not expose it over the public internet.

Available tools:

- `health`: checks database connectivity.
- `brief`: asks ad hoc questions over the synced archive, including articles, newsletters, Reddit, Hacker News, and Twitter/X, with citations.
- `create_briefing`: creates and stores a new time-window briefing with optional `hours` and `daysAgo`; this calls the LLM and may take 30-60 seconds.
- `briefing`: renders the latest stored briefing, or a specific stored briefing by `id`.

Example prompts that map naturally to the MCP tools:

- `brief`: "Give me a brief on agentic payments"; "Brief me on recent topics from Twitter"; "Brief me on what's happening with MCP"; "What do I know about Anthropic's latest moves?"
- `briefing`: "Give me my morning briefing"; "What's my latest briefing?"; "Show me briefing #4"; "Brief me on the last 24 hours"
- `create_briefing`: "Create a briefing for the last 48 hours"; "Generate my briefing for yesterday"; "Make a briefing for the past week"
- `health`: "Is Brief connected?"; "Check Brief health"

## Data Model

- `content`: normalized source content, enrichment output, and vector embedding.
- `sync_state`: collector cursors and per-feed state for Feedbin, RSS, Gmail, and Twitter/X.
- `digests`: generated briefing history and referenced content IDs.

Failed enrichments remain stored with `enrichment_status = 'failed'` and an error message for operational inspection and a future retry worker.

Sync prints Feedbin's total matching entry count plus per-entry counts and percentages while fetching and enriching. It is safe to interrupt with `Ctrl-C`: persisted entries remain stored, the cursor advances only after a complete run, and deduplication makes the next run idempotent.

If a cursor must be rebuilt, run `npm run cli -- sync --reset-cursor`. Existing entries are deduplicated, but missing older entries are fetched and processed. Sync refuses to advance the cursor if Feedbin reports more records than pagination returned.

For an MVP focused on recent briefings, avoid a complete historical backfill:

```bash
# Fetch the last 48 hours, then continue incrementally on later normal syncs
npm run cli -- sync --hours 48

# Fetch the last seven days
npm run cli -- sync --days 7
```

After a successful lookback sync, the stored cursor advances to the newest Feedbin entry fetched, which is normally close to the present. If interrupted, the existing stored cursor remains unchanged; resume with the same `--hours` or `--days` option. If no matching entries are returned, the existing cursor is left unchanged.

Twitter/X list sync uses TwitterAPI.io:

```bash
npm run sync-twitter
```

It reads `TWITTERAPI_LIST_IDS`, fetches newest tweets first, stops when it reaches the stored latest tweet ID for each list, and otherwise stops at `TWITTERAPI_LIST_MAX_PAGES` or `TWITTERAPI_LIST_MAX_TWEETS`. Tweets use `source_key = twitterapi:list:<list_id>` and `source_type = twitter`.

Briefing generation prints progress while loading sources, waiting for LLM synthesis, and storing the completed briefing.
It loads up to `DIGEST_CANDIDATE_LIMIT` entries published during the briefing lookback window, uses vector search to reserve source buckets for configured required topics and focus areas, then fills the remaining prompt budget with newest-published general entries. `DIGEST_MAX_ENTRIES` remains the final hard cap.

Use briefing topic config to protect important topics during source selection and shape the writeup:

```env
DIGEST_REQUIRED_TOPICS=agentic payments, agentic B2B, agentic commerce, personal memory
DIGEST_FOCUS_AREAS=MCP, AI observability, agent frameworks
```

Required topics always get a watchlist subsection. If there is no source-backed update, the briefing says so. Focus areas are included only when the selected entries contain meaningful signal.

## Markdown Output

Queries and briefings save readable Markdown by default. When Markdown is saved to a file, it is not echoed to stdout. Use `--format json` for automation.

Briefings are always stored in Postgres in canonical form. By default, the CLI writes a friendly Markdown briefing under `DIGEST_OUTPUT_DIR`; use `--canonical-only` or `digest canonical` to write the canonical Markdown with Obsidian-compatible frontmatter and source citations.

To write briefings directly into an Obsidian vault, set an absolute folder path:

```env
DIGEST_OUTPUT_DIR=/Users/you/Documents/MyVault/Briefed/Briefings
```

Override the configured directory for one briefing:

```bash
npm run digest -- --output /path/to/digest.md
```

Write the friendly briefing and canonical briefing together:

```bash
npm run digest -- --emit-canonical
```

If `--output` is supplied, the friendly briefing is written to that exact path and the canonical briefing is written beside it with the standard canonical filename.

Write only the canonical briefing, or re-render an existing stored canonical briefing without running the LLM again:

```bash
npm run digest -- --canonical-only
npm run cli -- digest canonical
npm run cli -- digest canonical --id 4
npm run cli -- digest canonical --output /path/to/digest.md
```

Re-render an existing stored briefing as friendly Markdown:

```bash
npm run cli -- digest friendly
npm run cli -- digest friendly --id 4
npm run cli -- digest friendly --id 4 --style warm
```

Queries are saved as Markdown under `QUERY_OUTPUT_DIR` by default:

```bash
npm run cli -- query "What changed in AI agent observability?"
npm run cli -- query "What changed in AI agent observability?" --output output/queries/observability.md
npm run cli -- query "What changed in AI agent observability?" --format json
npm run cli -- query "What changed in AI agent observability?" --no-save
npm run cli -- query "What changed in AI agent observability?" --save-json
```

Ask a follow-up using the latest saved query's answer and sources:

```bash
npm run cli -- query-followup "Which of these seem most important?"
```

Query progress logs are written to stderr, so Markdown and JSON stdout remain clean for piping.
Use `--no-save` to print query Markdown to stdout instead of writing it to a file.
Brief keeps a hidden `.latest.json` state file for follow-ups; visible JSON sidecars are only written with `--save-json`.

## Lightweight Source Strategy

Reddit, Hacker News, and Twitter/X feeds can produce many entries whose records are thin post or discussion wrappers. Individually summarizing every item adds cost and makes initial syncs slow. By default, these lightweight sources use `embedded_only` processing:

- Store the original source JSON, normalized post text, title, author, URL, and source summary.
- Generate and store an OpenAI embedding from the title and full post text.
- Copy the Feedbin summary into `analyst_summary`.
- Leave generated topic tags and entities empty.
- Keep the post available to semantic queries and daily briefings.

Article entries continue to receive full LLM enrichment. Fully enrich selected stored lightweight posts later:

```bash
# Fully enrich the newest 20 embedded-only Reddit entries
npm run cli -- enrich --source reddit --limit 20

# Fully enrich the newest 20 embedded-only Hacker News entries
npm run cli -- enrich --source hackernews --limit 20

# Fully enrich the newest 20 embedded-only Twitter/X entries
npm run cli -- enrich --source twitter --limit 20

# Fully enrich up to 100 Reddit entries collected in the last seven days
npm run cli -- enrich --source reddit --limit 100 --hours 168

# Upgrade every stored embedded-only Reddit entry to full enrichment
npm run cli -- enrich --source reddit --all
```

To change which non-article sources use embedding-only sync, set:

```env
LIGHTWEIGHT_SOURCE_TYPES=reddit,hackernews,twitter
```

Remove a source from this list to fully enrich it during future syncs.

Completed fully enriched entries are never downgraded. The selective `enrich` command upgrades `embedded_only` entries, retries failed or pending entries, and recovers entries stuck in `processing` for more than 15 minutes.

See [`docs/HowItWorks.md`](docs/HowItWorks.md) for the processing and lightweight-source policy details.

## Current MVP Boundaries

- Enrichment runs serially during sync to keep rate-limit behavior predictable.
- Feedbin and RSS content are used as delivered; external full-text extraction is not fetched.
- The pgvector column is fixed to 1536 dimensions.
- Digests are stored and printed; delivery to email or chat is not included.
