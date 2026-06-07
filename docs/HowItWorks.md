# How PND Works

PND uses Feedbin as its collector, Postgres and pgvector as its local archive, OpenAI for embeddings, and OpenAI or Anthropic for language-model synthesis.

## Sync Pipeline

Run:

```bash
npm run sync
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

Feedbin limits pages to 100 entries. PND follows Feedbin's pagination links and refuses to advance the cursor if Feedbin reports more matching records than were fetched.

To clear a bad cursor and safely rescan the full Feedbin archive:

```bash
npm run cli -- sync --reset-cursor
```

Existing entries are deduplicated during the rescan.

For a recent-only initial sync or backfill:

```bash
npm run cli -- sync --hours 48
npm run cli -- sync --days 7
```

These options temporarily override the starting cursor without changing the stored cursor before processing. After all matching pages finish successfully, PND stores the newest fetched Feedbin timestamp as the next incremental cursor. This is normally close to the present, but deliberately uses Feedbin's timestamp rather than the local clock to avoid skipping entries.

If a recent-only sync is interrupted, the previous stored cursor remains unchanged. Resume using the same lookback option. If Feedbin returns no matching entries, PND also leaves the existing cursor unchanged.

## Twitter/X List Sync

`npm run sync-twitter` imports the configured Twitter/X lists through TwitterAPI.io.

Configure:

```env
TWITTERAPI_IO_API_KEY=...
TWITTERAPI_LIST_IDS=2062878395029983324
TWITTERAPI_LIST_MAX_PAGES=3
TWITTERAPI_LIST_MAX_TWEETS=200
```

For each list, PND stores the newest successfully processed tweet ID in `sync_state` under `twitterapi:list:<list_id>:latest_id`. A normal run fetches newest tweets first and stops when it reaches that stored tweet. If the stored tweet is not reached, sync continues only up to the configured page and tweet limits.

Twitter/X entries use `source_key = 'twitterapi:list:<list_id>'`, `source_item_id = '<tweet_id>'`, and `source_type = 'twitter'`. They are embedding-only by default because `twitter` is included in `LIGHTWEIGHT_SOURCE_TYPES`.

## Source Detection

PND currently assigns one of four `source_type` values:

- `article`: entries that are not classified as a known lightweight source.
- `reddit`: canonical URLs on a Reddit hostname with a path beginning with `/r/`.
- `hackernews`: canonical URLs on `news.ycombinator.com/item` with an `id` query parameter.
- `twitter`: posts imported from Twitter/X list APIs.

This source type controls the default enrichment policy. It does not prevent an entry from appearing in queries or digests.

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

PND validates the response, normalizes and deduplicates tags/entities, and caps them at 10 topics and 30 entities. Excess valid items are trimmed instead of failing the complete enrichment.

Second, OpenAI creates a 1,536-dimension embedding from the title, generated summary, topics, and full text.

Full enrichment is the default for article entries.

### Lightweight Embedding-Only Strategy

Reddit, Hacker News, and Twitter/X feeds can be high volume, and their entries are often post or discussion wrappers rather than complete source articles. Individually summarizing every item would increase LLM calls, token usage, and sync duration before the MVP has demonstrated that item-level analysis is valuable.

By default:

```env
LIGHTWEIGHT_SOURCE_TYPES=reddit,hackernews,twitter
```

For each lightweight item, PND stores:

- Source identity and original JSON. Every entry uses `source_key` and `source_item_id`; for example, Feedbin entries use `source_key = 'feedbin:feed:<feed_id>'`, while Twitter/X list entries can use `source_key = 'twitterapi:list:<list_id>'`.
- Canonical URL, title, author, and timestamps.
- Original HTML and normalized full post text.
- Feedbin-provided summary.
- An OpenAI embedding generated from the title and full post text.
- `analyst_summary` copied from Feedbin's summary.
- Empty generated topic tags and entities.
- `source_type = 'reddit'`, `source_type = 'hackernews'`, or `source_type = 'twitter'`.
- `enrichment_mode = 'embedded_only'`.
- `enrichment_status = 'complete'`.

This keeps lightweight entries semantically searchable and eligible for digests while avoiding one LLM analysis call per item.

Feedbin's Reddit content generally contains the original post body, but it does not contain comments, discussion summaries, scores, or reliable engagement signals.

Feedbin's Hacker News content is normally the HN item or discussion wrapper, not the full linked article.

## Upgrading Lightweight Enrichment

The lightweight policy is reversible. Stored embedding-only entries can be upgraded to full enrichment without fetching them from Feedbin again.

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

PND:

1. Creates an OpenAI embedding for the question.
2. Uses pgvector cosine similarity to retrieve relevant archived entries.
3. Sends the retrieved titles, summaries, URLs, and dates to the configured LLM.
4. Returns a synthesized answer with `[1]`-style citations and a source list.

Both fully enriched and embedding-only lightweight entries participate in semantic retrieval.

The CLI renders queries as Markdown by default, including clickable source links, authors, dates, summaries, and similarity scores. Query answers are prompted to stay brief: 3-5 cited bullets, with an optional short list of best sources to open. Query results are saved as Markdown under `QUERY_OUTPUT_DIR` unless `--no-save` is supplied. Saved Markdown is not echoed to stdout. Use `--format json` for machine-readable stdout, or `--save-json` to also write a visible JSON sidecar. CLI query progress logs are written to stderr so stdout remains usable for Markdown or JSON piping.

`npm run cli -- query-followup "<question>"` uses the latest saved query session as context. PND stores that context in a hidden `.latest.json` state file in `QUERY_OUTPUT_DIR`. It reuses the previous answer and sources, calls the LLM for synthesis, and saves the follow-up as a new query session. It does not run a new embedding search.

## Daily Digest

Run:

```bash
npm run digest
npm run cli -- digest --hours 48
npm run cli -- digest render
```

The digest command:

1. Loads completed entries published during the lookback period.
2. Loads a broader recent candidate pool controlled by `DIGEST_CANDIDATE_LIMIT`.
3. Uses vector search for each configured required topic and focus area.
4. Selects protected topic buckets, then fills the remaining budget with newest-published general entries.
5. Sends selected titles, stored summaries, URLs, and dates to the configured LLM.
6. Asks the LLM to group related developments, highlight signals, and cite sources.
7. Stores the digest in the local `digests` table.
8. Writes the digest Markdown file.

Embedding-only lightweight entries remain eligible for the digest. The digest sees their source-provided summaries rather than individually generated LLM summaries. Their embeddings are still used for required-topic and focus-area source selection.

To prevent unexpectedly large or expensive LLM requests, PND sends at most `DIGEST_MAX_ENTRIES` selected entries. The default is `200`. Digest logs report the total eligible count, candidate count, and final required-topic, focus-area, and general source counts.

Digest topic config protects important topics during selection and shapes the synthesis prompt:

```env
DIGEST_REQUIRED_TOPICS=agentic payments, agentic B2B, agentic commerce, personal memory
DIGEST_FOCUS_AREAS=MCP, AI observability, agent frameworks
```

Required topics always appear under a required watchlist section. If the selected sources have no meaningful update for one of those topics, the digest explicitly says there was no signal in the window. Focus areas are softer interests; the digest highlights them only when there is meaningful source-backed signal.

Each digest is stored in Postgres and written as a timestamped Markdown file under `DIGEST_OUTPUT_DIR`. The Markdown contains Obsidian-compatible frontmatter, the digest body, and clickable sources. Inline citations use Obsidian heading links such as `[[#Source 32|32]]`, and source titles link to original URLs. Point `DIGEST_OUTPUT_DIR` at an Obsidian vault folder to make generated digests appear there without an additional integration.

CLI Markdown is the default and is written to a file without echoing the document to stdout. `--format json` prints machine-readable output. Progress logs are written to stderr so JSON stdout remains parseable.

`npm run cli -- digest render` re-renders the latest stored digest from Postgres without calling the LLM. Use `--id <digest_id>` to render a specific stored digest.

## Local And External Data

The normalized archive, generated enrichment, embeddings, cursors, and digests are stored locally in Postgres.

External requests still occur:

- Feedbin supplies entries.
- OpenAI receives text for embeddings.
- The configured LLM provider receives text for full enrichment, queries, and digests.
