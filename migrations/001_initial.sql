CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS content (
  id bigserial PRIMARY KEY,
  source_key text NOT NULL,
  source_item_id text NOT NULL,
  canonical_url text,
  title text,
  author text,
  source_summary text,
  content_text text NOT NULL,
  published_at timestamptz,
  collected_at timestamptz NOT NULL,
  raw_entry jsonb NOT NULL,
  analyst_summary text,
  topic_tags text[] NOT NULL DEFAULT '{}',
  entities jsonb NOT NULL DEFAULT '[]',
  embedding vector(1536),
  enrichment_status text NOT NULL DEFAULT 'pending'
    CHECK (enrichment_status IN ('pending', 'processing', 'complete', 'failed')),
  enrichment_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS content_source_item_unique
  ON content (source_key, source_item_id);

CREATE UNIQUE INDEX IF NOT EXISTS content_canonical_url_unique
  ON content (canonical_url)
  WHERE canonical_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS content_collected_at_idx
  ON content (collected_at DESC);

CREATE INDEX IF NOT EXISTS content_published_at_idx
  ON content (published_at DESC);

CREATE INDEX IF NOT EXISTS content_embedding_hnsw_idx
  ON content USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS sync_state (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS digests (
  id bigserial PRIMARY KEY,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  content_ids bigint[] NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
