# Discovery Workspace and Planner Vision

This document is the evolving working record for the consumer search and planning experience. Update it as we make product decisions, test UX patterns, and refine implementation priorities.

## Product Intent

- Help guests feel at home immediately and narrow options quickly.
- Do not force rigid check-in/check-out dates before showing useful options.
- Prioritize factual filters over endless photo browsing.
- Let users favorite promising homes as they browse.
- Enable a separate planner mode that compares favorited homes for availability, price, and key differentiators.

## Route Strategy (Current Decision)

- Core discovery interface: `/discover`
- Property detail page (SEO + direct share): `/rentals/:listingSlug`
- Optional area/community SEO landing pages:
  - `/rentals`
  - `/rentals/:areaSlug`
  - `/rentals/community/:communitySlug`
- Planner workspace (secondary, after favorites): `/plan`

Notes:

- Discovery and planner are separate user intents.
- Planner is not the first-stop search route.
- Planner can still be entry-safe if user has no favorites yet (show onboarding state + CTA back to discovery).

## Experience Model

### 1) Discovery Workspace (Primary)

Single, high-velocity interface for:

- Filtering and faceting listings quickly.
- Saving favorites.
- Previewing property details in a slide-over or modal, without losing place.
- Optionally seeing an interactive map in the same workspace.

### 2) Planner Workspace (Secondary)

Comparison-first interface for favorited listings:

- Compare flexible windows (month or date-range preference) and fixed windows.
- Compare availability confidence, total price, and differentiators.
- Explain why one listing costs more than another.

## Core Filtering Taxonomy

### Priority Decision Factors (v1)

These are the highest-value decisions users make first. The discovery workspace should surface these immediately and make them easy to combine.

### 1) Where Is It?

- Area and sub-area must be obvious at a glance.
- Community status must be explicit:
  - In community (verified)
  - Near community (not in)

### 2) Capacity and Bed Fit

- Bedrooms
- Sleeps
- Bed-type mix (especially king-bed count)

### 3) Community Reality vs Nearby Claims

- Separate filters for:
  - Verified in-community homes (eligible for official community amenities)
  - Nearby homes that reference the community but are outside it

### 4) Private Pool

- Dedicated private pool filter (not shared/community pool).

### 5) True Beachfront

- Strict beachfront definition: directly on the beach with ocean frontage, not merely "close to beach" or "short walk to beach".

### 6) Golf Cart / LSV Included

- Explicit included-vehicle indicator and filter.

### 7) What Makes It Special?

- Distinctive attributes highlighted as short factual tags (for example: panoramic Gulf views, oversized bunk suite, dual primary suites, rooftop deck, private boardwalk access).

### 8) Typical Pricing (Secondary for Now)

- Pricing should still be visible, but prioritized below fit/location factors in early discovery.
- Better to show directional or typical pricing until full planner comparison is engaged.

### 9) Property Name Search

- Many users search by known house name.
- Discovery must include fast text/name search in addition to click filters.

### Location

- Broad area: Santa Rosa Beach, Inlet Beach, etc.
- General area: Blue Mountain, Grayton, WaterColor, Seaside, Seagrove, WaterSound, Alys Beach, Seacrest, Rosemary Beach.
- Verified community: physically inside official community boundaries (distinct from nearby labels).

### Stay Timing

- Month-first browsing (June, July, August).
- Flexible stay length (for example, 5-night windows).
- Fixed date windows when required (spring break or school calendar).
- Respect listing-specific stay rules (for example, 3-night, 5-night, or 7-night minimums).
- Use availability-fit filtering to suppress listings with zero viable chance for the user's selected flexibility mode.

### Price

- Budget range based on stay total, not just nightly rate.
- Optional all-in estimate mode using available quote intelligence.

### Property Fit

- Sleeps
- Bedrooms
- King bed count
- Private pool (true private pool)
- Community pool access
- LSV or golf cart
- Beach access style/distance where available

## Discovery Workspace Information Architecture

- Left navigation:
  - Discover
  - Favorites (count badge)
  - Planner (enabled after favorites)
- Main workspace:
  - Sticky top quick filters (where, when, price, guests)
  - Fast name search (property-name lookup)
  - Expandable facets panel (location hierarchy + amenity details)
  - Results grid/list with strong factual summary
  - Persistent map panel option (desktop), map toggle (mobile)
- Detail interaction:
  - Quick view slide-over/modal from results
  - Keep scroll and filter state on close

## UX Principles

- Fast narrowing over heavy browsing.
- Immediate filter feedback.
- Respect different planning styles (where-first, when-first, price-first).
- Never punish uncertainty about dates.
- Keep users in one workspace while exploring.
- Facts over marketing language, especially for community and beachfront claims.
- Distinguish "in" from "near" anywhere a location/community label appears.
- If availability probability is effectively zero for current timing intent, communicate that early instead of letting users scroll dead-end options.

## Initial Build Scope (Rough Draft)

- Build `/discover` route as the new core search interface.
- Keep `/` as marketing home and funnel to discovery.
- Keep `/rentals/*` reserved for SEO and listing-page entry paths.
- Use `/plan` for the post-favorites comparison workspace.
- Add local favorite state and a visible favorites rail/count.
- Add quick-view modal for listing details.
- Add faceted filtering shell with placeholder data wiring where needed.

## Open Questions

- Should favorites persist anonymously in local storage before sign-in?
- Should planner be accessible at all times or only after minimum favorites count?
- Should map default on desktop or be opt-in to preserve list density?
- Which fields are guaranteed reliable enough to show as hard filters on day one?
- What is the canonical source of truth for community boundary verification?

## Decision Log

### 2026-04-08

- Planner is a special compare area and not the primary search route.
- Core user flow is discover -> favorite -> planner.
- Need an evolving product doc to capture iterative decisions.
- Priority discovery factors confirmed: where, beds/sleeps/bed types, verified community status, private pool, true beachfront, golf cart included, special differentiators; pricing is visible but lower priority at first pass.
- Search behavior update: users commonly start with click-filters, known property name, location intent, and date flexibility windows; discovery should reflect availability fit, including listing-specific minimum-stay constraints.
