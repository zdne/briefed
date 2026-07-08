ALTER TABLE content
  DROP CONSTRAINT IF EXISTS content_source_type_check,
  ADD CONSTRAINT content_source_type_check
    CHECK (source_type IN ('article', 'reddit', 'hackernews', 'twitter', 'clip'));
