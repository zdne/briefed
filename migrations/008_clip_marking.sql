ALTER TABLE content ADD COLUMN clipped_at timestamptz;
ALTER TABLE content ADD COLUMN clip_note text;

-- Backfill so existing clips stay in the clips list and keep their notes
UPDATE content SET clipped_at = collected_at, clip_note = raw_entry->>'note'
 WHERE source_key LIKE 'clip:%';

CREATE INDEX content_clipped_at_idx ON content (clipped_at) WHERE clipped_at IS NOT NULL;
