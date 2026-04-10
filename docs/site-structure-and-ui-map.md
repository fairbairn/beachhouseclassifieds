# Site Structure and UI Map

This is a living map of routes, page-level composition, and major UI components.

## Purpose

- Provide a quick orientation to where pages and components live.
- Keep route/component ownership clear as the site expands.
- Reduce guesswork when adding new pages or refactoring existing ones.

## Current Route Entry Points

- Root route: src/routes/index.tsx
  - Renders HomeLandingPage at /
- Legacy home route: src/routes/home.tsx
  - Redirects /home to /
- Discover route: src/routes/discover.tsx
  - Renders DiscoverPage at /discover
- Discover listings API route: src/routes/api/discover/listings.tsx
  - Returns demo listings payload for Discover client fetch

## Home Page Composition

- Page container: src/components/home/HomeLandingPage.tsx
- Current section order:
  1. HomeLandingNav
  2. HomeHeroSection
  3. HomeFocusSection
  4. HomeSavingsSection
  5. HomePostSavingsCtaSection
  6. HomeLandingFooter

## Home Component Responsibilities

- HomeLandingNav
  - Top navigation, brand treatment, primary Book Now action behavior.
- HomeHeroSection
  - Above-the-fold narrative and primary conversion framing.
- HomeFocusSection
  - Product value explanation and trust-building cards.
- HomeSavingsSection
  - Comparison table section (data-driven) and pricing-value messaging.
- HomePostSavingsCtaSection
  - Follow-on action block after comparison section.
- HomeLandingFooter

## Discover Page Composition

- Page container: src/components/discover/DiscoverPage.tsx
- Current surface map:
  1. Search/filter command bar (query, date window, stay and guest steppers)
  2. Advanced filter tray (threshold controls + feature toggles)
  3. Left facet sidebar (Areas, Planned Communities, Property Features)
  4. Center listings panel (card layouts, map focus actions, favorites, end-of-list guidance)
  5. Right map panel (interactive map, focus animation, open-in-maps)

## Discover Component Responsibilities

- DiscoverPage
  - Orchestrates filter state, sort mode, listing source selection, counts, and map target updates.
- DiscoverFacetSidebar
  - Renders collapsible count facets for area/community/features.
- DiscoverListingsPanel
  - Renders browse cards, card-level actions, and browse guidance panel.
- DiscoverMapPanel
  - Owns map lifecycle, marker updates, focus transitions, and map type switching.
- DiscoverSortLayoutControls
  - Owns sort dropdown, card density controls, and help popover.
- discover-controls primitives
  - Date range picker behavior and reusable steppers/facet section controls.
  - Legal/navigation utility links and copyright line.

## Data-Driven UI Elements

- Home savings table data source:
  - src/data/home-savings-table.json
- Rendering component:
  - src/components/home/HomeSavingsSection.tsx

## Shared Style Tokens (Current)

- Home action/engagement button tokens:
  - src/components/home/homeButtonStyles.ts
- Intent:
  - Keep CTA and engagement buttons visually standardized.

## Expansion Plan (Placeholder)

As the site grows, this document should include:

- Additional routes and their owning components.
- Page-level SEO/content ownership notes.
- Shared layout conventions per route family.
- Data source ownership by section.
- Component boundaries between reusable and page-specific UI.

## Documentation Workflow

- Add new route/page/component entries when shipping new UI surfaces.
- Update this map in the same PR as route/page structure changes.
- Keep this concise and navigational; link to deep-dive docs for details.
