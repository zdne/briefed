 # Thin Agent-First PND Plan

  ## Summary

  - Use Neon Free Postgres with pgvector as the shared cloud database.
  - Keep local CLI sync/digest for now; no hosted cron yet.
  - Add local MCP as the first agent-facing surface.
  - Keep Obsidian Markdown export local-only.
  - Keep Docker/Colima Postgres as the OSS/dev/offline fallback.

  ## Key Changes

  - Database:
      - Create a Neon Free Postgres project.
      - Run existing migrations; CREATE EXTENSION IF NOT EXISTS vector enables pgvector.
      - Point local .env DATABASE_URL at Neon.
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
          - npm run cli -- digest render
          - npm run cli -- digest render --id <id>

  - MCP server:
      - Add npm run mcp.
      - Initial tools:
          - health: check DB connectivity.
          - query_archive: ask a question over the archive with citations.
          - create_digest: create/store digest with { hours?, daysAgo? }.
          - latest_digest: render latest or selected stored digest with { id? }.

      - create_digest is slow/expensive because it calls the LLM; document expected wait.
      - MCP is local-only, unauthenticated, and must bind to localhost/stdio only.
      - Defer search_sources, get_source, auth, job IDs, remote MCP, and hosted API.

  - Future:
      - Add hosted scheduling later via Render Cron or GitHub Actions.
      - Add hosted agent access later via Render Web Service or remote MCP.
      - Upgrade Neon or move to paid Render/DigitalOcean Postgres when storage, restore, or compute limits matter.
      - Add auth before exposing any remote MCP/API.

  ## Test Plan

  - Verify local Docker PG:
      - migrations
      - query/digest smoke test

  - Verify Neon:
      - migrations
      - migrated data count sanity check
      - CLI query against Neon
      - CLI digest render against Neon

  - Verify MCP against Neon DATABASE_URL:
      - health
      - query_archive
      - create_digest
      - latest_digest

  - Run:
      - npm run typecheck
      - npm test

  ## Assumptions

  - Neon Free is acceptable for prototype shared state.
  - No hosted cron yet.
  - No public MCP/API yet.
  - Obsidian export stays local.
  - Docker/Colima PG remains supported for contributors and offline use.
  