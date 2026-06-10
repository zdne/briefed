 # Thin Agent-First Briefed.sh Plan

  ## Summary

  - Use Neon Free Postgres with pgvector as the shared cloud database.
  - Keep local CLI sync/briefing for now; no hosted cron yet.
  - Add local MCP as the first agent-facing surface.
  - Keep Obsidian Markdown export local-only.
  - Keep Docker/Colima Postgres as the OSS/dev/offline fallback.

  ## Key Changes

  - Database:
      - Create a Neon Free Postgres project.
      - Run existing migrations; CREATE EXTENSION IF NOT EXISTS vector enables pgvector.
      - Point local .env DATABASE_URL at Neon's pooled connection string (PgBouncer endpoint), not the direct URL; the pooled URL is better for the long-running MCP server.
      - Add explicit pool sizing, default PG_POOL_MAX=3, because MCP is long-running.
      - Document Neon Free limits: 0.5 GB storage/project, monthly compute quota, scale-to-zero latency, limited restore window.
      - Treat Neon Free as prototype shared state, not final production infrastructure.

  - Local Postgres:
      - Keep Docker/Colima Postgres as local OSS/dev storage.
      - Once Neon is configured, local PG is no longer the shared source of truth.
      - Local PG can still be used offline by changing DATABASE_URL.

  - Data migration:
      - Default path: migrate existing local data to Neon with pg_dump/pg_restore.
      - Restore into an empty Neon database before normal use.
      - If migration is skipped, document it as a clean start.

  - Local workflow:
      - Continue running locally:
          - npm run cli -- sync
          - npm run cli -- sync-twitter
          - npm run cli -- digest --hours 24

      - These write to Neon when DATABASE_URL points there.
      - Continue local Obsidian export:
          - npm run cli -- digest canonical
          - npm run cli -- digest canonical --id <id>

  - MCP server:
      - Add npm run mcp entrypoint (tsx src/mcp.ts) using @modelcontextprotocol/sdk.
      - Initial tools:
          - health: check DB connectivity.
          - brief: ask a question over the archive with citations.
          - create_briefing: create/store briefing with { hours?, daysAgo? }.
          - briefing: render latest or selected stored briefing with { id? }.

      - create_briefing is slow/expensive because it calls the LLM; document expected wait.
      - MCP is local-only, unauthenticated, and must bind to localhost/stdio only.
      - Defer search_sources, get_source, auth, job IDs, remote MCP, and hosted API.

  - Future:
      - Add hosted scheduling later via GitHub Actions scheduled workflows (lowest friction) or Fly.io (if all-in-one hosting is preferred).
      - Add hosted agent access later via remote MCP; requires OAuth and HTTPS — meaningfully different from local stdio MCP.
      - Upgrade Neon or move to Fly.io Postgres (all-in-one: DB + cron + MCP hosting) or DigitalOcean Managed Postgres when storage, restore, or compute limits matter. Keep Render on the list.
      - Add auth before exposing any remote MCP/API.

  ## Test Plan

  - Verify local Docker PG:
      - migrations
      - query/briefing smoke test

  - Verify Neon:
      - migrations
      - migrated data count sanity check
      - CLI query against Neon
      - CLI briefing canonical against Neon

  - Verify MCP against Neon DATABASE_URL using mcp-inspector or Claude Desktop config:
      - health
      - brief
      - create_briefing
      - briefing

  - Run:
      - npm run typecheck
      - npm test

  ## Assumptions

  - Neon Free is acceptable for prototype shared state.
  - No hosted cron yet.
  - No public MCP/API yet.
  - Obsidian export stays local.
  - Docker/Colima PG remains supported for contributors and offline use.
  