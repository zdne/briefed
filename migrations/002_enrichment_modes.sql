ALTER TABLE content
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'article'
    CHECK (source_type IN ('article', 'reddit', 'hackernews')),
  ADD COLUMN IF NOT EXISTS enrichment_mode text NOT NULL DEFAULT 'full'
    CHECK (enrichment_mode IN ('full', 'embedded_only'));

UPDATE content
SET source_type = 'reddit'
WHERE canonical_url ~* '^https?://([^/]+\.)?reddit\.com/r/';

UPDATE content
SET source_type = 'hackernews'
WHERE canonical_url ~* '^https?://news\.ycombinator\.com/item\?'
  AND canonical_url ~* '[?&]id=';

CREATE INDEX IF NOT EXISTS content_source_enrichment_idx
  ON content (source_type, enrichment_mode, collected_at DESC);
