# Scraper Image URL Hygiene TODO

## Why this exists

Across adapters, `media_gallery.image_urls` can get bloated by:

- duplicate size variants of the same image
- noisy captures from non-gallery UI regions
- legacy/fallback image endpoints mixed with canonical gallery URLs

This causes inflated image counts and lower data quality in detail JSON.

## Future Work Checklist

- [ ] Audit each adapter's image extraction logic and source selectors.
- [ ] Confirm each adapter is sourcing images from canonical gallery/lightbox DOM regions.
- [ ] Add adapter-specific variant collapsing rules where needed (keep largest/full-size URL).
- [ ] Remove noisy/non-gallery captures (icons, markers, logos, transparent assets, map artifacts).
- [ ] Prefer canonical image hosts/paths when multiple representations exist.
- [ ] Ensure stable dedupe keys ignore query params that only encode presentation variants (size/quality/fit).
- [ ] Recompute `media_gallery.image_count` after dedupe/filtering and validate against final `image_urls.length`.
- [ ] Add adapter-level validation checks for:
  - duplicate semantic images
  - suspicious host/path outliers
  - unexpectedly large image counts per listing
- [ ] Consider a shared utility in `src/core/*` for common image URL normalization + dedupe behavior.
- [ ] Re-run scraper validation after each adapter refinement and track progress.

## Reference Example

- `grayt30a` (`50-sea-turtle`) demonstrated:
  - duplicate size variants in Rezfusion URLs
  - noisy `picturehandler.ashx` captures mixed into gallery lists
  - improvements after gallery-scoped extraction and largest-variant dedupe
