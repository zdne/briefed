DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'content'
      AND column_name = 'feedbin_created_at'
  ) THEN
    ALTER TABLE content RENAME COLUMN feedbin_created_at TO collected_at;
  END IF;
END $$;

DROP INDEX IF EXISTS content_feedbin_created_at_idx;
DROP INDEX IF EXISTS content_source_enrichment_idx;

CREATE INDEX IF NOT EXISTS content_collected_at_idx
  ON content (collected_at DESC);

CREATE INDEX IF NOT EXISTS content_source_enrichment_idx
  ON content (source_type, enrichment_mode, collected_at DESC);
