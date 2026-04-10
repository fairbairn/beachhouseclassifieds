# Discover Experience Reference

This document is the implementation-level reference for the `/discover` experience.

Last updated: 2026-04-09

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
- Map panel and focus animation: `src/components/discover/DiscoverMapPanel.tsx`
- Sort/layout/help controls: `src/components/discover/DiscoverSortLayoutControls.tsx`
- Date/stepper/facet primitives: `src/components/discover/discover-controls.tsx`
- Discover sample data model + rows: `src/components/discover/discover-data.ts`
- Demo sample generator: `.tmp/scripts/build-discover-sample-from-adapters.mjs`
- Demo sample apply utility: `.tmp/scripts/apply-discover-sample-to-discover-data.mjs`

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

## Map View Operation

### Default State

- Centered on 30A baseline coordinates.
- Map type defaults to roadmap.

### Focus Sequence on Card Pin Click

The map performs an intentional cinematic sequence:

1. Update marker to selected listing coordinates.
2. If currently zoomed in past context zoom, animate zoom-out to context zoom.
3. Pan to the new listing position.
4. Animate zoom-in to target zoom.

### Map Type Switching

- At closer zoom threshold, map switches to satellite.
- When zoomed back out below threshold, map returns to roadmap.

### Fallback Behavior

- If Maps JS key is not available, show iframe embed fallback.

## Sorting and Recommended Ordering

Sort options:

- Recommended
- Price: Low to High
- Price: High to Low
- Sleeps: High to Low
- Beachfront + Pool First

Recommended mode behavior:

- Preserve server/source ordering (do not alpha-sort first).
- Demo ordering is stabilized by `demoOrder`, so it feels non-alphabetical without random jitter on every refresh.

## Demo Data Feed Contract

### Runtime Feed

- `GET /api/discover/listings` returns sample listings sorted by `demoOrder`.
- Client fetches the endpoint and falls back to local sample data if fetch fails.

### Demo Listing Shape

Discover listing rows include:

- identity/location fields: `id`, `name`, `area`, `community`, `lat`, `lng`
- stay capacity fields: bedrooms/bathrooms/sleeps and bed mix
- feature flags: `privatePool`, `beachfront`, `golfCart`, `petsAllowed`, `accessible`, `elevator`
- rendering helpers: `previewImages`, `typicalPrice`, `demoOrder`

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

## Interaction and Accessibility Notes

- Sort and help controls support outside-click close behavior.
- Date picker supports bounded month navigation and reset behavior.
- Active control states are visually distinct and consistent with current color intent.
- Route-level scroll behavior is intentionally managed to keep primary Discover surfaces stable.

## Terminology and Copy Canon

Use these terms consistently in Discover UI:

- Gulf Front
- Private Pool
- Golf Cart
- Planned Communities
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
- Decision: Map focus interaction uses zoom-out -> pan -> zoom-in sequencing and auto-switches roadmap/satellite by zoom threshold.
- Why: Improve user orientation and make focus transitions feel deliberate.
- Implementation: `src/components/discover/DiscoverMapPanel.tsx`, `src/components/discover/DiscoverListingsPanel.tsx`
- Follow-up: Tune timing/zoom constants if UX feedback requests stronger or calmer motion.

- Date: 2026-04-09
- Scope: UI copy
- Decision: Feature vocabulary standardized to `Gulf Front`, `Private Pool`, and `Golf Cart`, and feature facet order fixed to Gulf Front -> Private Pool -> Golf Cart.
- Why: Align terminology across filters, facets, and card badges.
- Implementation: `src/components/discover/DiscoverPage.tsx`, `src/components/discover/DiscoverListingsPanel.tsx`
- Follow-up: Keep synonyms in parser logic, but keep UI copy canonical.

## Change Checklist

When modifying Discover behavior, update this doc and validate:

1. `npm run build`
2. Verify label consistency across:

- advanced filter chips
- active summary chips
- facet sidebar feature labels
- listing badges

3. Verify map focus flow still performs zoom-out -> pan -> zoom-in and map type switching.
4. If sample generation changes, regenerate rows and apply to `discover-data.ts`.
5. Confirm `/api/discover/listings` ordering still matches intended recommended browse behavior.
