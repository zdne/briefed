# PND: Feedbin-First Synthetic Analyst

PND polls Feedbin, normalizes and enriches new entries, stores them in Postgres with pgvector, and answers questions over the archive with source citations.

## Architecture

```text
Feedbin API -> sync CLI -> Postgres/pgvector -> LLM enrichment + OpenAI embeddings
                                                       |
                                              CLI and POST /query
```

The MVP uses Feedbin's `GET /v2/entries.json?since=...` endpoint and preserves the exact newest `created_at` timestamp as its next cursor. Entries are deduplicated by both Feedbin entry ID and canonicalized URL.

## Prerequisites

- Node.js 22+
- Docker with Compose
- Feedbin account
- OpenAI API key for embeddings
- OpenAI or Anthropic API key for enrichment and answer synthesis

## Setup

```bash
cp .env.example .env
# Fill in Feedbin and model-provider credentials.

docker compose up -d postgres
npm install
npm run db:migrate
npm run sync
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
| `npm run cli -- enrich --source reddit --limit 20` | Fully enrich the newest 20 eligible Reddit entries |
| `npm run cli -- enrich --source reddit --limit 100 --hours 168` | Fully enrich up to 100 Reddit entries from the last seven days |
| `npm run cli -- enrich --source reddit --all` | Fully enrich every eligible stored Reddit entry |
| `npm run cli -- enrich --source article --limit 20` | Retry or fully enrich eligible non-Reddit entries |
| `npm run cli -- query "<question>"` | Query the archive from the terminal |
| `npm run cli -- query "<question>" --format json` | Return machine-readable query JSON |
| `npm run cli -- query "<question>" --output output/query.md` | Write a query result to Markdown |
| `npm run digest` | Generate and store a digest for the last 24 hours |
| `npm run cli -- digest render` | Re-render the latest stored digest as Markdown without calling the LLM |
| `npm run cli -- digest render --id 4` | Re-render a specific stored digest |
| `npm run cli -- digest --hours 48` | Generate a digest with a custom lookback |
| `npm run cli -- digest --format json` | Print machine-readable digest JSON while still writing Markdown |
| `npm run dev` | Start the API with reload |
| `npm test` | Run unit tests |

Run sync and digest from cron, a systemd timer, or a scheduler:

```cron
*/15 * * * * cd /path/to/pnd && /usr/bin/npm run sync >> /var/log/pnd-sync.log 2>&1
0 7 * * * cd /path/to/pnd && /usr/bin/npm run digest >> /var/log/pnd-digest.log 2>&1
```

## Configuration

See [`.env.example`](.env.example). Important values:

- `FEEDBIN_EMAIL`, `FEEDBIN_PASSWORD`: Feedbin HTTP Basic Auth credentials.
- `OPENAI_API_KEY`: always required because embeddings use OpenAI.
- `LLM_PROVIDER`: `openai` or `anthropic`.
- `REDDIT_ENRICHMENT_MODE`: defaults to `embedded_only`; set to `full` to fully enrich Reddit during sync.
- `OPENAI_EMBEDDING_MODEL`: defaults to `text-embedding-3-small`; storage is fixed at 1536 dimensions.
- `QUERY_LIMIT`: default number of vector matches passed to answer synthesis.
- `DIGEST_MAX_ENTRIES`: maximum newest completed entries sent to one digest request; defaults to `200`.
- `DIGEST_OUTPUT_DIR`: directory for generated digest Markdown; defaults to `output/digests`.

## API

- `GET /health`: checks database connectivity.
- `POST /query`: accepts `{"question":"...","limit":8}`.

## Data Model

- `content`: normalized source content, enrichment output, and vector embedding.
- `sync_state`: exact Feedbin incremental-sync cursor.
- `digests`: generated daily digest history and referenced content IDs.

Failed enrichments remain stored with `enrichment_status = 'failed'` and an error message for operational inspection and a future retry worker.

Sync prints Feedbin's total matching entry count plus per-entry counts and percentages while fetching and enriching. It is safe to interrupt with `Ctrl-C`: persisted entries remain stored, the cursor advances only after a complete run, and deduplication makes the next run idempotent.

If a cursor must be rebuilt, run `npm run cli -- sync --reset-cursor`. Existing entries are deduplicated, but missing older entries are fetched and processed. Sync refuses to advance the cursor if Feedbin reports more records than pagination returned.

For an MVP focused on recent digests, avoid a complete historical backfill:

```bash
# Fetch the last 48 hours, then continue incrementally on later normal syncs
npm run cli -- sync --hours 48

# Fetch the last seven days
npm run cli -- sync --days 7
```

After a successful lookback sync, the stored cursor advances to the newest Feedbin entry fetched, which is normally close to the present. If interrupted, the existing stored cursor remains unchanged; resume with the same `--hours` or `--days` option. If no matching entries are returned, the existing cursor is left unchanged.

Digest generation prints progress while loading sources, waiting for LLM synthesis, and storing the completed digest.
It sends at most `DIGEST_MAX_ENTRIES` newest eligible entries to the LLM and logs when older eligible entries are omitted.

## Markdown Output

Queries and digests print readable Markdown by default. Use `--format json` for automation.

Digests are always stored in Postgres and written as timestamped Markdown files under `DIGEST_OUTPUT_DIR`. Files include Obsidian-compatible frontmatter, the generated digest, and clickable source citations. Inline citations emitted as `[32]`, `(32)`, or grouped forms such as `(27, 62)` are normalized into Obsidian heading links such as `[[#Source 32|32]]`; the source title opens the original URL.

To write digests directly into an Obsidian vault, set an absolute folder path:

```env
DIGEST_OUTPUT_DIR=/Users/you/Documents/MyVault/PND/Digests
```

Override the configured directory for one digest:

```bash
npm run cli -- digest --output /path/to/digest.md
```

Re-render an existing stored digest without running the LLM again:

```bash
npm run cli -- digest render
npm run cli -- digest render --id 4
npm run cli -- digest render --output /path/to/digest.md
```

Queries are printed to the terminal and are only saved when `--output` is provided:

```bash
npm run cli -- query "What changed in AI agent observability?"
npm run cli -- query "What changed in AI agent observability?" --output output/queries/observability.md
npm run cli -- query "What changed in AI agent observability?" --format json
```

Query progress logs are written to stderr, so Markdown and JSON stdout remain clean for piping.

## Reddit Strategy

Reddit feeds can produce many entries, and individually summarizing every post adds cost and makes initial syncs slow. By default, Reddit entries use `embedded_only` processing:

- Store the complete Feedbin entry, normalized post text, title, author, URL, and Feedbin summary.
- Generate and store an OpenAI embedding from the title and full post text.
- Copy the Feedbin summary into `analyst_summary`.
- Leave generated topic tags and entities empty.
- Keep the post available to semantic queries and daily digests.

Non-Reddit entries continue to receive full LLM enrichment. Fully enrich selected stored Reddit posts later:

```bash
# Fully enrich the newest 20 embedded-only Reddit entries
npm run cli -- enrich --source reddit --limit 20

# Fully enrich up to 100 Reddit entries collected in the last seven days
npm run cli -- enrich --source reddit --limit 100 --hours 168

# Upgrade every stored embedded-only Reddit entry to full enrichment
npm run cli -- enrich --source reddit --all
```

To fully enrich Reddit entries during future syncs, set:

```env
REDDIT_ENRICHMENT_MODE=full
```

Completed fully enriched entries are never downgraded. The selective `enrich` command upgrades `embedded_only` entries, retries failed or pending entries, and recovers entries stuck in `processing` for more than 15 minutes.

See [`docs/HowItWorks.md`](docs/HowItWorks.md) for the processing and Reddit-policy details.

## Current MVP Boundaries

- Enrichment runs serially during sync to keep rate-limit behavior predictable.
- Feedbin content is used as delivered; external full-text extraction is not fetched.
- The pgvector column is fixed to 1536 dimensions.
- Digests are stored and printed; delivery to email or chat is not included.
