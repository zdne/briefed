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
| `npm run cli -- query "<question>"` | Query the archive from the terminal |
| `npm run digest` | Generate and store a digest for the last 24 hours |
| `npm run cli -- digest --hours 48` | Generate a digest with a custom lookback |
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
- `OPENAI_EMBEDDING_MODEL`: defaults to `text-embedding-3-small`; storage is fixed at 1536 dimensions.
- `QUERY_LIMIT`: default number of vector matches passed to answer synthesis.

## API

- `GET /health`: checks database connectivity.
- `POST /query`: accepts `{"question":"...","limit":8}`.

## Data Model

- `content`: normalized source content, enrichment output, and vector embedding.
- `sync_state`: exact Feedbin incremental-sync cursor.
- `digests`: generated daily digest history and referenced content IDs.

Failed enrichments remain stored with `enrichment_status = 'failed'` and an error message for operational inspection and a future retry worker.

Sync prints Feedbin's total matching entry count plus per-entry counts and percentages while fetching and enriching. It is safe to interrupt with `Ctrl-C`: persisted entries remain stored, the cursor advances only after a complete run, and deduplication makes the next run idempotent.

Digest generation prints progress while loading sources, waiting for LLM synthesis, and storing the completed digest.

## Current MVP Boundaries

- Enrichment runs serially during sync to keep rate-limit behavior predictable.
- Feedbin content is used as delivered; external full-text extraction is not fetched.
- The pgvector column is fixed to 1536 dimensions.
- Digests are stored and printed; delivery to email or chat is not included.
