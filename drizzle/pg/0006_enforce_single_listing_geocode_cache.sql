with ranked as (
  select
    id,
    row_number() over (
      partition by listing_id
      order by updated_at desc nulls last, created_at desc nulls last, id desc
    ) as row_rank
  from listing_geocode_cache
)
delete from listing_geocode_cache cache
using ranked
where cache.id = ranked.id
  and ranked.row_rank > 1;

DROP INDEX IF EXISTS "listing_geocode_cache_listing_provider_fingerprint_unique_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "listing_geocode_cache_listing_unique_idx"
  ON "listing_geocode_cache" USING btree ("listing_id");
