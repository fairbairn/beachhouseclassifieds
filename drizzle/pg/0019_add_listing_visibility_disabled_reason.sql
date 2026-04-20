ALTER TABLE listing
  ADD COLUMN IF NOT EXISTS visibility_disabled_reason text;

CREATE INDEX IF NOT EXISTS listing_visibility_disabled_reason_idx
  ON listing (visibility_disabled_reason);

CREATE INDEX IF NOT EXISTS listing_discover_visibility_with_reason_idx
  ON listing (site_id, status, visibility_disabled_reason, state, area_name);
