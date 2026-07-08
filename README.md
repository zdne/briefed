# Briefed

**Your agent's morning read.**

Briefed syncs your feeds, newsletters, and social sources, enriches each entry with AI, and generates a daily briefing grounded in your configured topics. Use it via MCP (e.g. in Claude), or from the CLI to Obsidian Markdown.

Supported sources:

- RSS/Atom feeds 
  - including Reddit and Google News
- Email newsletters
- Twitter/X lists
- Feedbin.com

## Prerequisites

- Node.js 22+
- Docker + Compose (for Postgres)
- OpenAI API key — always required for embeddings
- OpenAI or Anthropic API key for enrichment and synthesis

## Setup

```bash
cp .env.example .env
cp briefed.config.example.json briefed.config.json
# Add API keys to .env; configure feeds and topics in briefed.config.json

docker compose up -d postgres
npm install
npm run db:migrate
npm run sync -- --hours 48
```

After a system restart: `docker compose up -d postgres` (on macOS with Colima: `colima start` first).

## MCP with Claude

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "brief": {
      "command": "/absolute/path/to/briefed/node_modules/.bin/tsx",
      "args": ["/absolute/path/to/briefed/src/mcp.ts"],
      "env": {
        "NODE_ENV": "production",
        "DOTENV_CONFIG_PATH": "/absolute/path/to/briefed/.env",
        "USER_CONFIG_PATH": "/absolute/path/to/briefed/briefed.config.json"
      }
    }
  }
}
```

Use absolute paths throughout — MCP hosts don't inherit your shell environment or `PATH`.

Restart Claude Desktop. Example prompts:

- "What's my latest briefing?"
- "Give me a brief on agentic payments"
- "Create a briefing for the last 48 hours"
- "Brief me on recent topics from Twitter"
- "Add 'agent memory' to my required topics"

**MCP tools:**

| Tool | Use for |
|---|---|
| `brief` | Ad hoc question over the archive with citations |
| `briefing` | Show the latest (or a specific) stored briefing |
| `create_briefing` | Generate a new briefing — calls the LLM, takes 30-60s |
| `get_user_config` | Read current collector and topic config |
| `update_user_config` | Replace full config |
| `update_collectors` | Replace collectors section |
| `update_briefing_preferences` | Replace required topics and focus areas |

## Daily Workflow

```bash
npm run sync            # sync all enabled collectors
npm run digest          # generate briefing for last 24h, write Markdown
npm run cli -- query "What changed in AI infrastructure this week?"
```

Automate with cron:

```cron
*/15 * * * * cd /path/to/briefed && npm run sync >> /var/log/briefed-sync.log 2>&1
0 7  * * * cd /path/to/briefed && npm run digest >> /var/log/briefed-digest.log 2>&1
```

## Configuration

**`briefed.config.json`** — collector settings and briefing topics. Edit directly or via MCP tools.

```json
{
  "version": 1,
  "collectors": {
    "rss":     { "enabled": true, "feeds": [{ "title": "...", "url": "...", "enabled": true }] },
    "gmail":   { "enabled": true, "label": "newsletter", "query": null },
    "twitter": { "enabled": true, "listIds": ["..."] },
    "feedbin": { "enabled": false }
  },
  "briefing": {
    "requiredTopics": ["agentic payments", "agentic B2B"],
    "focusAreas":     ["MCP", "AI observability"]
  }
}
```

`requiredTopics` always appear in the briefing with explicit "no signal" when nothing matches. `focusAreas` appear only when there is meaningful signal.

**`.env`** — secrets and operational limits. Key values:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `OPENAI_API_KEY` | Required — used for embeddings |
| `LLM_PROVIDER` | `openai` (default) or `anthropic` |
| `ANTHROPIC_API_KEY` | Required when `LLM_PROVIDER=anthropic` |
| `DIGEST_OUTPUT_DIR` | Briefing output directory (default `output/briefings`) |
| `QUERY_OUTPUT_DIR` | Query output directory (default `output/queries`) |

Point `DIGEST_OUTPUT_DIR` at an Obsidian vault folder to get briefings there without extra steps.

See `.env.example` for all variables and their defaults.

## Collector Setup

### RSS feeds

Add feeds to `collectors.rss.feeds` in `briefed.config.json` — each entry needs `title`, `url`, and `"enabled": true`. RSS works out of the box with no extra credentials.

**Reddit RSS** requires credentials to avoid rate limits. Get them from an authenticated Reddit RSS URL (`https://www.reddit.com/prefs/feeds`):

```
https://www.reddit.com/r/example.rss?user=<user>&feed=<feed>
```

Add to `.env`: `REDDIT_RSS_USER=...` and `REDDIT_RSS_FEED=...`

### Gmail newsletters

1. Create a Google Cloud project, enable the Gmail API, configure OAuth consent with scope `https://www.googleapis.com/auth/gmail.readonly`, and create a Desktop app OAuth client.
2. Add to `.env`: `GMAIL_CLIENT_ID=...` and `GMAIL_CLIENT_SECRET=...`
3. Set `"gmail": { "enabled": true, "label": "newsletter" }` in `briefed.config.json`.
4. Run `npm run gmail-auth` — opens a browser URL, then prints `GMAIL_REFRESH_TOKEN` to add to `.env`.

### Twitter/X lists

1. Get a [TwitterAPI.io](https://twitterapi.io) API key, add `TWITTERAPI_IO_API_KEY=...` to `.env`.
2. Add list IDs to `briefed.config.json`: `"twitter": { "enabled": true, "listIds": ["..."] }`

### Feedbin (optional)

Add `FEEDBIN_EMAIL` and `FEEDBIN_PASSWORD` to `.env`, set `"feedbin": { "enabled": true }` in `briefed.config.json`, then run `npm run sync-feedbin -- --hours 48` for the initial sync.

## Commands

| Command | Purpose |
|---|---|
| `npm run sync` | Sync every enabled collector |
| `npm run sync -- --hours 48` | Sync with a lookback |
| `npm run digest` | Generate and write a friendly briefing for the last 24h |
| `npm run digest -- --hours 48` | Custom lookback |
| `npm run cli -- query "<question>"` | Query the archive |
| `npm run cli -- query-followup "<question>"` | Follow-up on latest saved query |
| `npm run digest -- --canonical-only` | Write only the canonical Markdown (Obsidian-friendly) |
| `npm run digest -- --emit-canonical` | Write both friendly and canonical Markdown |
| `npm run cli -- digest canonical` | Re-render latest stored briefing without calling LLM |
| `npm run cli -- digest canonical --id 4` | Re-render a specific stored briefing |
| `npm run digest -- --hours 24 --days-ago 3` | Briefing window ending 3 days ago |
| `npm run cli -- digest friendly --id 4 --style warm` | Re-render as warm friendly Markdown |
| `npm run cli -- sync-rss --hours 48` | Sync RSS feeds only |
| `npm run cli -- sync-gmail --hours 48` | Sync Gmail newsletters only |
| `npm run sync-twitter` | Sync Twitter/X lists only |
| `npm run cli -- enrich --source reddit --limit 20` | Upgrade embedded-only entries to full enrichment |
| `npm run sync-feedbin` | Sync Feedbin |
| `npm run cli -- sync-feedbin --hours 48` | Feedbin sync with lookback |
| `npm run cli -- sync-feedbin --reset-cursor` | Clear cursor and rescan full Feedbin archive |
| `npm run mcp` | Start the stdio MCP server |
| `npm run db:migrate` | Apply SQL migrations |
| `npm test` | Run unit tests |

## Reference

[`docs/HowItWorks.md`](docs/HowItWorks.md) covers enrichment modes, source types, source selection strategy, all CLI flags, all `.env` variables, and operational details.

## Author

[Zdenek Z Nemec](https://zdne.org) · [@zdne](https://x.com/zdne)

## License

MIT — see [LICENSE](LICENSE).
