# Scraper Adapter Pattern Playbook

This playbook captures the patterns that have emerged from existing scraper adapters so future probe and adapter builds can move faster.

## Purpose

Use this document when starting a new manager probe to quickly answer:

- Which platform family does this target likely use?
- Which listing-navigation strategy should be tested first?
- Where is availability likely exposed (DOM calendar, API payload, embedded script)?
- Which existing adapter should be cloned as a starting template?

## Fast Probe Workflow

1. Identify platform clues from URL structure, network calls, and HTML selectors.
2. Classify listing page behavior:

- infinite scroll
- load more button
- numbered pagination
- API-fed grid/list

3. Classify detail page behavior:

- static HTML fields
- expandable sections (`Read More` / `Show More`)
- inline JSON/JSON-LD blocks

4. Classify availability behavior:

- clickable calendar widget with month pagination
- API endpoint returning availability payloads
- embedded day/state data in page source

5. Select the closest existing adapter and copy its strategy skeleton.
6. Keep normalized output contract unchanged (`normalized_matching_profile`, `normalized_availability`).

## Platform Clue Library

### URL and Path Clues

- `/wp-admin/admin-ajax.php` + numeric detail URLs (`/12345/`): usually WordPress + Streamline-like inventory/availability APIs.
- `/vrp/` paths and `/vrpjax` style endpoints: usually VRP/booking-engine pagination and data endpoints.
- `/property/<slug>-<24hex>` and `/api/properties`: often Guesty-backed inventory feeds.
- `/vacation-rentals/...` paths: often custom or themed front-end over similar booking primitives.

### Network Clues

- Response payloads containing property arrays/IDs are frequently the most reliable listing source.
- Availability APIs are often easier and more reliable than UI calendar scraping when available.
- Pagination can be hidden behind AJAX query params even when UI looks like infinite scroll.

### DOM/Selector Clues

- Buttons containing `Load More`, `Show More`, `Next` are strong control points.
- Calendar widgets often expose day state via classes or `data-date` attributes.
- Hidden detail text often becomes available after clicking `Read More`/`Show More`.

## Attack Vectors (Preferred Order)

1. Attach network listeners before interacting with listing pages.
2. Try extracting listings from API responses before relying on DOM-only scraping.
3. Run scroll + stagnation detection for lazy-loaded result grids.
4. Add load-more click loops with growth checks when applicable.
5. Add numbered pagination traversal when page/index signals are present.
6. Expand hidden sections on details before extracting text.
7. Attempt availability from API endpoint first; fallback to UI calendar parsing.
8. If UI calendar is required, paginate month-by-month with signature-based stop conditions.
9. Parse inline JS/JSON for day states and min-night rules when available.
10. Persist raw HTML and diagnostics for every detail fetch for offline reparsing.

## Pattern Matrix By Existing Adapter

| Adapter              | Listing Strategy                              | Detail Strategy                              | Availability Strategy                    | Primary Clues                                          |
| -------------------- | --------------------------------------------- | -------------------------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| `360blue`            | Infinite scroll + height stabilization        | HTML + JSON-LD extraction                    | DOM calendar + next-button pagination    | `.cmp-availability-calendar`, `/properties/`           |
| `30aescapes`         | Scroll/discovery with de-duplication          | HTML extraction with expansion-friendly flow | Calendar-table parsing + month traversal | `table.calendar-table`, `/rentals/`                    |
| `30aluxury`          | Scroll-driven listing capture                 | HTML extraction                              | Calendar-table parsing + traversal       | `/vacation-rentals/`                                   |
| `beachblue`          | Scroll with growth checks                     | HTML extraction + profile signals            | DOM calendar class mapping               | `/vacation-rentals/rental/`                            |
| `benchmark30a`       | Listing extraction with pagination cues       | HTML + embedded structured blocks            | Embedded range data converted to days    | `benchmark30a.com`, embedded payload clues             |
| `coastproperties30a` | Load-more loop + AJAX ID capture              | Numeric-ID detail fetch                      | Availability API payload decoding        | `/wp-admin/admin-ajax.php`, `GetPropertyListWordPress` |
| `exclusive30a`       | Numbered pagination traversal                 | HTML + inline script extraction              | Inline booked-day arrays                 | `/vacation-rentals/`, `?page=` cues                    |
| `fivestar30a`        | Multi-anchor pagination/list traversal        | HTML extraction + profile signals            | Calendar/widget + rule extraction        | East/West result-set split                             |
| `localvr30a`         | Scroll + API interception (`/api/properties`) | HTML extraction with Read More expansion     | Embedded day/state payload parsing       | Guesty-style `/property/<slug>-<id>`                   |
| `oceanreef30a`       | Scroll + load-more and expected-count hints   | HTML extraction with ID fallback chain       | Day-cell class + `data-date` parsing     | property ID inputs and class-coded cells               |
| `oversee30a`         | Server-side page traversal via `/vrpjax`      | HTML + data-attribute extraction             | Availability endpoint payloads           | `/vrp/`, `/vrpjax`                                     |
| `realjoy30a`         | Scroll + stagnation termination               | HTML + URL/unitcode heuristics               | Parsed day/state data from detail source | `/beach-rentals/`                                      |
| `stayon30a`          | Load-more + AJAX ID capture                   | Numeric-ID detail fetch                      | Availability API payload decoding        | `/wp-admin/admin-ajax.php`, WordPress pattern          |

## Reusable Decision Tree

### Listing Page

- If results keep appearing while scrolling, use scroll loop + growth/stagnation stop.
- If a visible `Load More` exists, prioritize click loop with count growth checks.
- If `?page=` or total-page signals exist, traverse pages directly.
- If API responses include inventory records, treat API-discovered URLs as authoritative.

### Detail Page

- Always normalize canonical detail URL.
- Expand hidden sections before text extraction.
- Pull `title`, `h1`, canonical, meta description, then fallback to body excerpts.
- Prefer deterministic external listing IDs (URL ID, payload ID, numeric ID) with fallback chain.

### Availability

- If availability endpoint exists, use endpoint output as primary source.
- Else parse DOM calendar with explicit month traversal and safe exit conditions.
- Else parse embedded JS/JSON day-state payloads.
- Always map provider states into `A/U/I/O/X` and preserve provider diagnostics in `availability_raw`.

### Rates and Quote APIs

- For Streamline-like adapters using `/wp-admin/admin-ajax.php?action=streamlinecore-api-request`, probe method names before building UI-only logic.
- Common methods seen in current adapters include `GetPropertyAvailabilityRawData`, `GetPropertyRates` or `GetPropertyRatesRawData`, and (on some managers) `GetPreReservationPrice` for ad-hoc full-stay quote calculations.
- Treat ad-hoc quote methods as optional enrichment: keep nightly/day rates in `normalized_rates` and store quote-response diagnostics in a provider-specific raw sidecar until a shared quote schema is introduced.

## Guardrails and Reliability Rules

- Set hard caps on scroll steps, click cycles, and calendar month advances.
- Use no-growth thresholds to prevent infinite loops.
- Persist detail HTML for offline reparsing and parser improvements.
- Keep extraction diagnostics (counts, observed status labels/classes, iteration metrics).
- Keep concurrency and delay configurable via env vars per adapter.

## Adapter Build Checklist (Pattern-Aware)

1. Pick nearest adapter template from matrix above.
2. Implement URL normalization and listing ID extraction first.
3. Add listing discovery with at least one fallback path (DOM + network, or pagination + network).
4. Add detail extraction with hidden-content expansion.
5. Add availability extraction using best available source (API > DOM > embedded payload).
6. Emit normalized matching and availability blocks unchanged from standard contract.
7. Record diagnostics in `availability_raw` and scrape metrics.
8. Validate listing-count expectations when known.
9. Run full + subset + direct-detail modes and confirm standard artifacts are written.

## Known Gaps and Maintenance Notes

- This playbook is pattern-focused and should be updated whenever a new platform family is added.
- `target-property-managers-30a.md` may lag reality as adapter coverage changes; treat adapter source as ground truth.
- For each new adapter, add one short note to this playbook capturing any truly new clue family or attack vector.
