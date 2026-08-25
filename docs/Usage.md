# Briefed Usage Reference

## CLI Commands

| Command | Purpose |
|---|---|
| `npm run sync` | Sync every enabled collector |
| `npm run sync -- --hours 48` | Sync with a lookback |
| `npm run digest` | Generate and write the canonical briefing (Obsidian-friendly) for the last 24h |
| `npm run digest -- --hours 48` | Custom lookback |
| `npm run digest -- --friendly` | Also render a reader-friendly Markdown rewrite with the LLM |
| `npm run digest -- --hours 24 --days-ago 3` | Briefing window ending 3 days ago |
| `npm run cli -- query "<question>"` | Query the archive |
| `npm run cli -- query-followup "<question>"` | Follow-up on latest saved query |
| `npm run cli -- digest canonical` | Re-render latest stored briefing without calling LLM |
| `npm run cli -- digest canonical --id 4` | Re-render a specific stored briefing |
| `npm run cli -- digest friendly --id 4 --style warm` | Re-render as warm friendly Markdown |
| `npm run cli -- sync-rss --hours 48` | Sync RSS feeds only |
| `npm run cli -- sync-gmail --hours 48` | Sync Gmail newsletters only |
| `npm run sync-twitter` | Sync Twitter/X lists only |
| `npm run sync-feedbin` | Sync Feedbin |
| `npm run cli -- sync-feedbin --hours 48` | Feedbin sync with lookback |
| `npm run cli -- sync-feedbin --reset-cursor` | Clear cursor and rescan full Feedbin archive |
| `npm run cli -- clip --url <url>` | Clip a URL, or mark it as clipped if already archived |
| `npm run cli -- clip --url <url> --note "..."` | Clip a URL with a note |
| `npm run cli -- clip --text "..."` | Clip raw text to the archive |
| `npm run cli -- clip --citation <n> --note "..."` | Mark "Source N" from the latest briefing as clipped |
| `npm run cli -- clip --citation <n> --digest-id <id>` | Mark "Source N" from a specific briefing |
| `npm run cli -- clips` | List 10 most recently saved items |
| `npm run cli -- clips "<query>"` | Search saved items semantically |
| `npm run cli -- enrich --source reddit --limit 20` | Upgrade embedded-only entries to full enrichment |
| `npm run cli -- graph-candidates` | Propose data/agentic-payments-graph.yaml updates from the archive, with interactive per-item review |
| `npm run cli -- graph-candidates --dry-run` | Preview proposals without writing to the graph file |
| `npm run cli -- graph-audit-sources` | Report suspect sourcing in data/agentic-payments-graph.yaml (Google News wrappers, missing publisher, primary/secondary domain mismatches) — report only, never writes |
| `npm run cli -- graph-audit-sources --no-resolve` | Same, without live Google News resolution attempts |
| `npm run mcp` | Start the stdio MCP server |
| `npm run db:migrate` | Apply SQL migrations |
| `npm test` | Run unit tests |

## MCP Tools

| Tool | Use for |
|---|---|
| `brief` | Ad hoc question over the archive with citations |
| `briefing` | Show the latest (or a specific) stored briefing |
| `clip` | Save a URL or text to the archive, or mark an existing item as clipped by URL/citation |
| `clips` | List or search everything saved (fresh clips and marked items) |
| `get_user_config` | Read current collector and topic config |
| `update_user_config` | Replace full config |
| `update_collectors` | Replace collectors section |
| `update_briefing_preferences` | Replace required topics and focus areas |

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://pnd:pnd@localhost:5432/pnd` | Postgres connection string. For Neon: `postgresql://<user>:<pass>@ep-xxx.region.aws.neon.tech/neondb?sslmode=require` |
| `PG_POOL_MAX` | `3` | Max Postgres pool connections per process. Set to `2` for Neon free tier. |
| `PORT` | `3000` | HTTP server port |
| `OPENAI_API_KEY` | — | Required for embeddings |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model (fixed at 1536 dimensions) |
| `LLM_PROVIDER` | `openai` | `openai` or `anthropic` |
| `OPENAI_LLM_MODEL` | `gpt-4.1-mini` | OpenAI model for enrichment and synthesis |
| `ANTHROPIC_API_KEY` | — | Required when `LLM_PROVIDER=anthropic` |
| `ANTHROPIC_LLM_MODEL` | `claude-3-5-haiku-latest` | Anthropic model for enrichment and synthesis |
| `LIGHTWEIGHT_SOURCE_TYPES` | `reddit,hackernews,twitter` | Source types that use embedding-only enrichment |
| `QUERY_LIMIT` | `8` | Default vector matches passed to query synthesis |
| `QUERY_CLIP_BOOST` | `0.05` | Similarity bonus for clipped items in query retrieval (`0` disables) |
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
