ALTER TABLE content
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS source_item_id text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'content'
      AND column_name = 'feedbin_entry_id'
  ) THEN
    UPDATE content
    SET
      source_key = 'feedbin:feed:' || feed_id::text,
      source_item_id = feedbin_entry_id::text
    WHERE source_key IS NULL
      AND source_item_id IS NULL
      AND feedbin_entry_id IS NOT NULL
      AND feed_id IS NOT NULL;
  END IF;
END $$;

ALTER TABLE content
  ALTER COLUMN source_key SET NOT NULL,
  ALTER COLUMN source_item_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS content_source_item_unique
  ON content (source_key, source_item_id);

ALTER TABLE content
  DROP CONSTRAINT IF EXISTS content_source_type_check,
  ADD CONSTRAINT content_source_type_check
    CHECK (source_type IN ('article', 'reddit', 'hackernews', 'twitter'));

DROP INDEX IF EXISTS content_canonical_url_unique;

CREATE UNIQUE INDEX IF NOT EXISTS content_canonical_url_unique
  ON content (canonical_url)
  WHERE canonical_url IS NOT NULL;

ALTER TABLE content
  DROP COLUMN IF EXISTS feedbin_entry_id,
  DROP COLUMN IF EXISTS feed_id,
  DROP COLUMN IF EXISTS external_source,
  DROP COLUMN IF EXISTS external_id;
