# Briefed

**Your agent's morning read.**

Briefed syncs your feeds, newsletters, and social sources, enriches each entry with AI, and generates a daily briefing grounded in your configured topics. Use it via MCP in Claude, or from the CLI to Obsidian Markdown.

Supported sources: RSS/Atom (including Reddit and Google News), Gmail newsletters, Twitter/X lists, Feedbin

## Prerequisites

- Node.js 22+
- Postgres with pgvector — local Docker or a cloud provider like [Neon](https://neon.tech)
- OpenAI API key (embeddings) + OpenAI or Anthropic key (enrichment)

## Setup

```bash
cp .env.example .env
cp briefed.config.example.json briefed.config.json
# Add API keys to .env; configure feeds and topics in briefed.config.json

docker compose up -d postgres   # or set DATABASE_URL in .env to use Neon
npm install
npm run db:migrate
npm run sync -- --hours 48
```

See [`.env.example`](.env.example) for all variables. For Neon, set `DATABASE_URL` and `PG_POOL_MAX=2` — no Docker needed.

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

**Tip:** Once the MCP server is connected (see below), ask Claude to run the `briefed-setup` skill — it interviews you about your interests, picks topic labels, and configures your feeds automatically.

**`.env`** — secrets and operational limits. Key values:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (local default or Neon `postgresql://...?sslmode=require`) |
| `OPENAI_API_KEY` | Required — used for embeddings |
| `LLM_PROVIDER` | `openai` (default) or `anthropic` |
| `ANTHROPIC_API_KEY` | Required when `LLM_PROVIDER=anthropic` |
| `DIGEST_OUTPUT_DIR` | Briefing output directory (default `output/briefings`) |
| `QUERY_OUTPUT_DIR` | Query output directory (default `output/queries`) |

## Usage

### CLI

```bash
npm run sync            # sync all enabled collectors
npm run digest          # generate briefing for last 24h
npm run cli -- query "What changed in AI infrastructure this week?"
```

Point `DIGEST_OUTPUT_DIR` in `.env` at an Obsidian vault folder to get briefings there without extra steps.

**Automate with launchd (macOS):**

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.briefed.daily.plist
```

Runs sync + digest daily at 6am. Fires at next wake if the Mac was asleep.

**Automate with cron (Linux):**

```cron
0 6 * * * cd /path/to/briefed && (npm run sync; npm run digest) >> /var/log/briefed.log 2>&1
```

Use `;` rather than `&&` between sync and digest — `sync` exits non-zero if any individual collector fails (e.g. an expired OAuth token), even when the others succeed, and you still want a briefing from whatever did sync.

### MCP (Claude app)

Works with any local MCP-compatible host — Claude Desktop, Cursor, Windsurf, or similar. The config below is for Claude Desktop.

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Use absolute paths — MCP hosts don't inherit your shell `PATH`. Restart Claude Desktop.

Example prompts:

> - "What's my latest briefing?"
> - "Give me a brief on agentic payments"
> - "Create a briefing for the last 48 hours"
> - "Brief me on recent topics from Twitter"
> - "Add 'agent memory' to my required topics"
> - "Clip this for me: https://..."
> - "Clip this and note it's relevant to my agentic payments watchlist: https://..."
> - "Save this to my archive: [pasted text]"
> - "What have I clipped recently?"
> - "Find what I clipped about MCP"

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

## Reference

- [`docs/Usage.md`](docs/Usage.md) — all CLI commands, MCP tools, and environment variables
- [`docs/HowItWorks.md`](docs/HowItWorks.md) — architecture, enrichment pipeline, and data model

## Author

[Zdenek "Z" Nemec](https://zdne.org) · [@zdne](https://x.com/zdne)

## License

MIT — see [LICENSE](LICENSE).
