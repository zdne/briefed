-- Supports read-only archive retrieval for the idea-discovery MCP tools
-- (list_archive_items, search_archive, get_archive_items).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Deterministic content hash for detecting evidence-bearing changes to a
-- record's source text. Generated (not app-computed) so it can never drift
-- from content_text. digest() is IMMUTABLE, so this is safe as STORED.
-- Fingerprints content_text only — it does NOT cover title, author,
-- published_at, or any other metadata; an edit to those fields alone leaves
-- this hash unchanged. Do not treat it as a whole-record version hash.
ALTER TABLE content
  ADD COLUMN IF NOT EXISTS content_hash text
    GENERATED ALWAYS AS (encode(digest(content_text, 'sha256'), 'hex')) STORED;

-- Lexical search support. The two-argument to_tsvector(regconfig, text) form
-- is IMMUTABLE (unlike the one-argument form, which is STABLE because it
-- depends on the session's default_text_search_config), so with an explicit
-- configuration it can back a generated column directly — no trigger needed.
-- See https://www.postgresql.org/docs/current/textsearch-tables.html.
-- Verified on PostgreSQL 17 (this project's pgvector/pgvector:pg17 image):
-- pg_proc lists to_tsvector(regconfig, text) as provolatile = 'i' (immutable).
-- ADD COLUMN ... STORED rewrites the table, so existing rows are backfilled
-- automatically — no manual UPDATE needed.
ALTER TABLE content
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
      to_tsvector('english'::regconfig, coalesce(title, '') || ' ' || coalesce(content_text, ''))
    ) STORED;

CREATE INDEX IF NOT EXISTS content_search_vector_idx ON content USING GIN (search_vector);

-- Keyset pagination for list_archive_items, ordered by (updated_at, id).
-- A B-tree index can be scanned in either direction, so this serves the
-- ascending (updated_at, id) scan regardless of column order. This index
-- speeds up that scan; it is not required for keyset pagination's
-- correctness, which holds even as a sequential scan + sort.
CREATE INDEX IF NOT EXISTS content_updated_at_id_idx ON content (updated_at, id);
