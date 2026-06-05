ALTER TABLE content
  DROP CONSTRAINT IF EXISTS content_source_type_check,
  ADD CONSTRAINT content_source_type_check
    CHECK (source_type IN ('article', 'reddit', 'hackernews'));

UPDATE content
SET source_type = 'hackernews'
WHERE canonical_url ~* '^https?://news\.ycombinator\.com/item\?'
  AND canonical_url ~* '[?&]id=';
