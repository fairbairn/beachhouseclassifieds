# Brand and Visual Direction

This is a living reference for branding, visual language, and messaging choices used on the public-facing experience.

## Purpose

- Keep design decisions intentional and consistent.
- Avoid one-off styling decisions that drift from the brand.
- Give future contributors concrete defaults for typography, color, copy tone, and UI treatment.

## Brand Positioning (Current)

- Positioning: discovery-first vacation rental affiliate experience.
- User promise: help families discover the right 30A vacation rental quickly, with clearer stay-total context.
- Commerce boundary: users are directed to third-party booking/checkout flows; this site is not the booking merchant.

## Typography

### Primary UI Font

- Font family: Manrope
- Usage: body copy, utility labels, table labels, button text, metadata.
- Tone: modern, readable, practical.

### Editorial/Display Font

- Font family: Playfair Display
- Usage: hero and section headlines, premium/emotional statements.
- Tone: elevated, memorable, aspirational.

### Display Accent Treatment

- Use selective italic/light style for emotionally weighted words (for example, destination or mood terms).
- Avoid overusing decorative treatments; keep emphasis intentional.

## Color Direction

### Core Accent

- Primary accent teal: #14B8A6
- Secondary bright teal accent: #2DD4BF
- Darker teal hover: #0F9F91

### Neutral Base

- Primary dark text: slate-900 family
- Secondary text: slate-600 family
- Muted labels/meta: slate-400/slate-500 family
- Base surface: white

### Current Intent

- Teal conveys coastal freshness, trust, and action.
- Neutrals keep readability high and let imagery carry atmosphere.

## Textual Logo Style

### 30A Wordmark Treatment

- Display: "30" in dark text + "A" in accent teal.
- Style use: nav brand mark, select headline callouts.
- Rule: use this treatment sparingly as a brand-signature element, not as generic body styling.

## Buttons and CTA System

### Standardized Engagement Buttons

- Shared style token source: src/components/home/homeButtonStyles.ts
- Teal engagement style:
  - Background: #14B8A6
  - Text: white
  - Hover: #0F9F91
- No underline behavior in normal/hover/focus/visited/active button states.

### CTA Copy Style

- Prefer clear, direct, action-oriented labels.
- Current collection CTA pattern: "EXPLORE THE COLLECTION" with trailing arrow icon.

## Imagery Style

### Section Backgrounds

- Use full-bleed background imagery with a white overlay for legibility.
- Current overlay baseline on below-fold sections: rgba(255,255,255,0.62).
- Avoid forced grayscale unless there is a specific visual reason.

### General Guidance

- Preserve readability over image detail.
- Keep composition clean; avoid heavy visual effects unless purposeful.

## Messaging Voice

### Tone

- Clear, confident, family-friendly.
- Premium but approachable.
- Emphasize vacation outcomes and decision clarity, not technical implementation.

### Messaging Constraints

- Avoid language that suggests users are buying homes.
- Frame value around vacation rental discovery, stay-total clarity, and handoff confidence.

## Footer Minimal Baseline

- Keep footer compact and low-noise.
- Current minimal links:
  - Legal & Disclaimers
  - Privacy Policy
  - Contact
- Include copyright line.

## Governance

- Treat this document as the source of truth for visual direction.
- When a UI decision is repeated in two or more places, document it here.
- If a decision changes, update this file in the same PR as the implementation.
