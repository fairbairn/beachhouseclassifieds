# Discover Experience Reference

This document is the implementation-level reference for the `/discover` experience.

Last updated: 2026-04-27

## Purpose

- Preserve current UX behavior, naming, and interaction contracts.
- Keep panel responsibilities clear as Discover evolves.
- Prevent regressions when refining demo data, filters, and map behavior.

## Route and Ownership

- Route: `src/routes/discover.tsx`
- Main page composition: `src/components/discover/DiscoverPage.tsx`
- Server demo feed: `src/routes/api/discover/listings.tsx`
- Left facet rail: `src/components/discover/DiscoverFacetSidebar.tsx`
- Listing cards and card actions: `src/components/discover/DiscoverListingsPanel.tsx`
- Map panel and sync/reset controls: `src/components/discover/DiscoverMapPanel.tsx`
- Sort/layout/help controls: `src/components/discover/DiscoverSortLayoutControls.tsx`
- Date/stepper/facet primitives: `src/components/discover/discover-controls.tsx`
- Discover sample data model + rows: `src/components/discover/discover-data.ts`
- Demo sample generator: `.tmp/scripts/build-discover-sample-from-adapters.mjs`
- Demo sample apply utility: `.tmp/scripts/apply-discover-sample-to-discover-data.mjs`

## Runtime Data Flow (Current)

- Discover parent route (`/discover`) loads a server-seeded page, then progressively fills client listings.
- Current server seed count is intentionally small (`12`) to keep first paint and hydration light.
- Detail overlay route (`/discover/listing/$slug`) fetches server detail via a TanStack server function boundary.
- Client-side narrowing (location text + advanced filters) currently runs in-memory over fetched rows.

Implications:

- Initial unfiltered metadata can represent broader server totals.
- Once user narrowing is active, effective counts/facets shown in UI are derived from the narrowed local set.

## Server Boundary Policy (Discover)

- Do not import `.server` modules directly from client-reachable route files.
- Route-level server data access should use TanStack server boundaries (`createServerFn`) or route server handlers.
- Keep `.server` imports isolated behind those boundaries.

Why this policy exists:

- It avoids import-protection build failures and keeps server/client ownership explicit.

## Page Architecture

Discover currently uses a three-zone layout:

1. Header command bar

- Location query
- Date range field
- Nights/adults/children steppers
- Advanced filters toggle
- Sort + card density controls
- Search tips popover

2. Main content body

- Left: collapsible facet rail
- Center: listing cards panel (scrollable)
- Right: sticky map panel

3. Discover background and shell

- Uses `HomeMarketingShell`
- Applies immersive background treatment and fixed viewport scrolling behavior for the route session

## Advanced Filters and Feature Taxonomy

Current filter labels should remain consistent across chips, summary, and facet counts:

- Gulf Front
- Private Pool
- Golf Cart
- Pets
- Elevator
- Accessible

Current feature facet order must remain:

1. Gulf Front
2. Private Pool
3. Golf Cart

If copy changes in one place, update all user-visible surfaces to match:

- icon option labels
- active filter summary tokens
- left facet feature labels
- card badges (when applicable)

## Listing Panel Behavior

### Card Density Modes

- Supports 2, 3, and 4 cards-per-row modes.
- 2-up mode uses one large preview plus a 2x2 tile mosaic.
- 3/4-up modes reduce preview density for faster scan speed.

### Card Actions

- Map pin button sends a focus target to the map with target zoom.
- Heart button toggles local favorites state only (session-local UI state).

### Card Meta and Badges

- Header line prioritizes property `name`.
- Subline uses normalized location/community presentation.
- Feature badges are conditionally shown (Gulf Front, Private Pool, Golf Cart).

### End-of-list UX

- Includes a guidance CTA panel with practical search hints.
- Includes return-to-top action for long browse sessions.

## Detail Stay Calendar (Check-In / Check-Out)

The listing detail sidebar now uses a stay-calendar mode (separate from the generic discover date-window mode).

Current intent:

- Show day-state guidance for check-in/out feasibility.
- Enforce stay-selection constraints without changing the generic discover date-window control behavior.

### Day-State Source and Mapping

Detail day states are resolved from sequential availability stream context:

- `availability_window_start_date`
- `status_code_string`
- `availability_days_count`

Status mapping:

- `A` -> available
- `I` -> check-in only
- `O` -> check-out only
- `U`/`X` -> blocked/unavailable

Only dates on/after current date receive day-state styling.

### Selection Constraints

Stay selection follows these rules:

1. Check-in can start only on `I` or `A`.
2. Check-out can end only on `A` or `O`.
3. Every day between start and end must be `A`.
4. Max span is bounded (current config: 30 days in detail stay mode).
5. Dates before current day are not selectable.

### Styling Semantics (Current)

Legend and day visuals are aligned as:

- Check-In Only: white -> light-blue gradient, bold text
- Available: solid light-blue background, normal text
- Check-Out Only: light-blue -> white gradient, normal text
- Unavailable/Blocked: dim text, no background fill

### Interaction Stability Rules

- Opening the picker may align visible months to the selected start month.
- During editing/selection, the month viewport should not auto-jump after day clicks.
- Left/right month navigation remains user-driven.

### Mode Boundary Requirement

All check-in/out-specific logic and styling must remain opt-in for detail stay mode and must not regress discover page date-window behavior.

## Map View Operation

### Default State

- Centered on 30A baseline coordinates.
- Map type defaults to roadmap.

### Header Controls

Current map header controls (left to right):

1. Expand/collapse toggle
2. Sync
3. Clear Pin
4. Reset
5. Open-in-maps icon-only outbound action

Behavior notes:

- Sync is enabled only when a pin is selected and its listing card is out of the current cards viewport.
- Sync shows pulse-ring attention when enabled.
- Clear Pin clears selected pin state only and preserves current map camera state.
- Reset returns map to baseline center/context zoom and clears selected pin.
- Reset is disabled when the map is already at reset state.

### Focus Sequence on Card Pin Click

Selection now uses direct state-aware focus:

1. Update marker to selected listing coordinates.
2. Pan to target from current camera position.
3. Adjust zoom from current zoom toward target zoom (no forced intermediate reset hop).

### Map Type Switching

- At closer zoom threshold, map switches to satellite.
- When zoomed back out below threshold, map returns to roadmap.
- Clearing pin does not force immediate map-type reset.

### Fallback Behavior

- If Maps JS key is not available, show iframe embed fallback.

### Google Maps JS Console Notices (Current Interpretation)

Observed console notices:

- mapId + custom style precedence warning
- 45° imagery behavior change notice

Current interpretation for this project:

- The map uses `mapId` (`DEMO_MAP_ID`) and dynamic `roadmap`/`satellite` switching by zoom.
- We are not currently applying per-map JSON style overrides in code, so behavior remains expected.
- With a `mapId`, default map-type styling should be treated as cloud-managed, not client-map-style managed.
- The 45° notice is informational for current UX: satellite/hybrid no longer auto-switch to 45° imagery at high zoom in API v3.62+.
- Since current Discover map behavior does not rely on 45° auto-tilt, no immediate behavior change is required.

Operator guidance:

- Keep current behavior unchanged unless we intentionally introduce cloud style differences or a tilt-dependent UX.
- Revisit only if map visuals diverge from expected cloud style configuration.

## Sorting and Recommended Ordering

Sort options:

- Recommended
- Price: Low to High
- Price: High to Low
- Sleeps: High to Low
- Beachfront + Pool First

Price sorting behavior:

- Price low/high sort now uses seeded `typicalAllInNightly * selectedNights` values.
- This keeps sort order consistent with the on-card approximate total shown for the current nights selection.

Recommended mode behavior:

- Preserve server/source ordering (do not alpha-sort first).
- Demo ordering is stabilized by `demoOrder`, so it feels non-alphabetical without random jitter on every refresh.

## Demo Data Feed Contract

### Runtime Feed

- `GET /api/discover/listings` returns sample listings sorted by `demoOrder`.
- Before response, demo rows are normalized for location alignment:
  - `area` is aligned from coordinate/polygon beach-zone resolution.
  - `community` is aligned using planned-community polygon normalization.
- Client fetches the endpoint and falls back to local sample data if fetch fails.

### Demo Listing Shape

Discover listing rows include:

- identity/location fields: `id`, `name`, `area`, `community`, `lat`, `lng`
- stay capacity fields: bedrooms/bathrooms/sleeps and bed mix
- feature flags: `privatePool`, `beachfront`, `golfCart`, `petsAllowed`, `accessible`, `elevator`
- pricing helpers: `typicalPricingMonth`, `typicalBaseNightly`, `typicalAllInNightly`
- rendering helpers: `previewImages`, `typicalPrice`, `demoOrder`

### Card Pricing Presentation (Current)

- Card footer copy uses: `Typical pricing for N nights in <typicalPricingMonth>`.
- Card footer value uses approximate total: `~ $<rounded(typicalAllInNightly * N)>`.
- `~` indicates estimate semantics for this demo phase.

## Demo Data Curation Rules

Generator rules currently emphasize realistic house-like inventory:

1. Source selection

- Pull from selected adapter detail JSONs via each adapter `details/index.json`.

2. Listing count target

- Build 96 unique listings.

3. Geo quality gate

- Require valid in-range 30A-like coordinates.

4. House-only heuristics

- Exclude obvious condo/townhome/townhouse signals.
- Exclude unit-style patterns (`#401`, `Unit ...`, `A-323` style unit codes).
- Enforce minimum bedrooms threshold currently used for house-like selection.

5. Naming quality

- Use `h1` as baseline source.
- Prefer quoted property names when present.
- Normalize all-caps to proper case.
- Strip redundant area/community prefixes when they leak into address-style names.

6. Feature extraction quality

- Prefer amenities-derived signals.
- Use description/title as secondary evidence.
- Handle negations for false-positive prevention (for example: `not beachfront`, `not gulf front`, `no private pool`, `golf cart not included`).

7. Stable presentation randomness

- Generate deterministic `demoOrder` to avoid alphabetical clustering while staying stable across loads.

8. Location-source-of-truth normalization

- Polygon/coordinate resolution is authoritative for beach-zone and community alignment.
- Seed/demo rows may be batch-rewritten using:
  - `.tmp/scripts/normalize-discover-data-seed.mjs`

## Interaction and Accessibility Notes

- Sort and help controls support outside-click close behavior.
- Date picker supports bounded month navigation and reset behavior.
- Active control states are visually distinct and consistent with current color intent.
- Route-level scroll behavior is intentionally managed to keep primary Discover surfaces stable.

## Facet Selection UX (Current)

This section captures the implemented interactive facet behavior in the current Discover UI.

### Selection Model

- Facet rows are clickable selectable items.
- Multiple selections are allowed in the same section.
- Multiple selections are allowed across different sections.
- Logical behavior is AND across selected facets.

### Selected Row UI

- When selected, a facet row moves to a selected pill-like visual treatment.
- Selected treatment wraps both facet label and count.
- Row-level unselect icon is intentionally not shown; row toggle handles select/unselect.

### Section Header Actions

- If at least one facet is selected in a section, show an indicator/action near that section title.
- Header action clears only that section's selected facets.
- No global clear-all facet action is required yet because section headers stay visible.
- Section indicator can show `0` when selected facets exist but summed counts resolve to zero.

### Count and Math Behavior (Current Phase)

- UI may use faked/derived count math for experimentation.
- Final count math will be driven by server-side search/facet response data.
- No hard backend filtering implementation is required in this phase.

### Future Integration Intent (Mellisearch)

- Selected facets become hard filters in the search query.
- No selected facets: Properties count reflects total inventory and all facet breakouts.
- Selected facets: constrained result count reflects filtered set returned by backend.

### Near-Term Integration Intent (Postgres)

- Implement Discover-side server query contract in Postgres first.
- Return full filtered corpus counts/facets plus sorted limited result peek (`max 96`) per request.
- Keep detail-page query behavior unchanged while Discover listing query evolves.

### Future UX Note (Not Yet Implemented)

- If users over-constrain filters/facets and reach zero results, provide a listings-panel guidance experience that explains constraint pressure and suggests concrete ways to recover results.

## Terminology and Copy Canon

Use these terms consistently in Discover UI:

- Gulf Front
- Private Pool
- Golf Cart
- Beaches
- Communities
- Typical pricing

Avoid reintroducing old labels (`Beachfront`, `Pool`, `LSV`) in filter controls unless there is an explicit product decision.

## Discover Decision Log

Use this section to track meaningful Discover UX/data contract decisions over time.

### Entry Template

- Date: YYYY-MM-DD
- Scope: UI copy | layout | behavior | data curation | map behavior | sorting
- Decision: What changed
- Why: Product/UX/accuracy rationale
- Implementation: files/modules touched
- Follow-up: optional tuning or validation notes

### Recent Entries

- Date: 2026-04-21
- Scope: route boundary | build stability
- Decision: Discover detail overlay route now uses a TanStack `createServerFn` boundary for server-only detail payload access.
- Why: Preserve server/client boundaries and avoid client import-protection violations in production builds.
- Implementation: `src/routes/discover.listing.$slug.tsx`, `src/lib/discover/discover-listings-api.server.ts`
- Follow-up: Apply the same boundary pattern to future Discover route-level server fetches.

- Date: 2026-04-21
- Scope: discover query strategy
- Decision: Adopt Postgres-first enhancement path for Discover listing query (full-corpus counts/facets + filtered/sorted limited results), with Meilisearch deferred behind a stable UX query contract.
- Why: Lower near-term delivery risk and faster incremental progress using existing canonical visibility/pricing/availability data in Postgres.
- Implementation: `docs/discover-search-postgres-transition-plan.md`
- Follow-up: Implement incremental contract phases and parity validation before Meilisearch ingestion work.

- Date: 2026-04-09
- Scope: data curation
- Decision: Property names are now derived from listing detail fields (h1-first), quoted property names are preferred when present, all-caps names are normalized to proper case, and redundant location prefixes are stripped for address-style names.
- Why: Reduce slug/title leakage and improve card title quality.
- Implementation: `.tmp/scripts/build-discover-sample-from-adapters.mjs`, `src/components/discover/discover-data.ts`
- Follow-up: Continue preferring true property name over area/address fragments when adapters expose stronger naming fields.

- Date: 2026-04-09
- Scope: data curation
- Decision: House-only heuristics tightened to exclude condo/townhome/townhouse and unit-style inventory signals.
- Why: Keep Discover demo inventory aligned with standalone home expectations.
- Implementation: `.tmp/scripts/build-discover-sample-from-adapters.mjs`, `src/components/discover/discover-data.ts`
- Follow-up: Expand exclusion patterns cautiously if new leakage is observed.

- Date: 2026-04-09
- Scope: sorting
- Decision: Demo recommended order now preserves stable pseudo-random ordering via `demoOrder` instead of alphabetical ordering.
- Why: Avoid clustered alphabetical browsing and preserve a more natural discovery flow.
- Implementation: `.tmp/scripts/build-discover-sample-from-adapters.mjs`, `.tmp/scripts/apply-discover-sample-to-discover-data.mjs`, `src/routes/api/discover/listings.tsx`, `src/components/discover/DiscoverPage.tsx`, `src/components/discover/discover-data.ts`
- Follow-up: Add seed rotation only when intentional reorder is desired.

- Date: 2026-04-09
- Scope: map behavior
- Decision: Map focus interaction uses state-aware pan + zoom adjustment from the current camera state, and auto-switches roadmap/satellite by zoom threshold.
- Why: Preserve orientation while avoiding reset-like transition hops.
- Implementation: `src/components/discover/DiscoverMapPanel.tsx`, `src/components/discover/DiscoverListingsPanel.tsx`
- Follow-up: Tune timing/zoom constants if UX feedback requests stronger or calmer motion.

- Date: 2026-04-09
- Scope: UI copy
- Decision: Feature vocabulary standardized to `Gulf Front`, `Private Pool`, and `Golf Cart`, and feature facet order fixed to Gulf Front -> Private Pool -> Golf Cart.
- Why: Align terminology across filters, facets, and card badges.
- Implementation: `src/components/discover/DiscoverPage.tsx`, `src/components/discover/DiscoverListingsPanel.tsx`

- Date: 2026-04-10
- Scope: behavior | layout | UX contract
- Decision: Implemented interactive facet model with selectable rows, selected-pill treatment, per-section clear action, multi-select support, AND behavior across selected facets, and no per-row unselect icon.
- Why: Improve scan density and preserve row width while keeping unselect behavior simple via row toggle.
- Implementation: `src/components/discover/DiscoverFacetSidebar.tsx`, `src/components/discover/discover-controls.tsx`, `docs/discover-experience-reference.md`
- Follow-up: Wire constrained result/count semantics to backend facet query responses.

- Date: 2026-04-11
- Scope: map behavior | layout
- Decision: Map header now exposes Sync/Clear Pin/Reset actions with state-aware enablement; expanded map locks card density to one-card mode and shows lock messaging in controls.
- Why: Improve map/list coordination and avoid ambiguous state changes while map is expanded.
- Implementation: `src/components/discover/DiscoverMapPanel.tsx`, `src/components/discover/DiscoverSortLayoutControls.tsx`, `src/components/discover/DiscoverPage.tsx`
- Follow-up: Re-evaluate control ordering if operator testing suggests faster action grouping.

- Date: 2026-04-11
- Scope: data curation | API behavior
- Decision: Discover runtime now normalizes area/community from polygon+coordinate resolution at API boundary; static demo seed rows were batch-normalized to match.
- Why: Remove location/community mismatches and make map/list geography consistent.
- Implementation: `src/routes/api/discover/listings.tsx`, `src/components/discover/discover-utils.ts`, `src/components/discover/discover-data.ts`, `.tmp/scripts/normalize-discover-data-seed.mjs`
- Follow-up: Keep normalization script available for future seed refreshes.

## Change Checklist

When modifying Discover behavior, update this doc and validate:

1. `npm run build`
2. Verify label consistency across:

- advanced filter chips
- active summary chips
- facet sidebar feature labels
- listing badges

3. Verify map focus flow performs state-aware pan/zoom adjustment (without forced reset hop) and map type switching.
4. If sample generation changes, regenerate rows and apply to `discover-data.ts`.
5. Confirm `/api/discover/listings` ordering still matches intended recommended browse behavior.
