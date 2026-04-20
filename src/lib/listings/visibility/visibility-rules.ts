export const LISTING_VISIBILITY_REASON_CODES = {
  manualListingHidden: "manual_listing_hidden",
  manualAdapterHidden: "manual_adapter_hidden",
  excludedBySourceLink: "excluded_by_source_link",
  missingActiveSourceLink: "missing_active_source_link",
  missingImages: "missing_images",
  missingDescriptionMarkdown: "missing_description_markdown",
  missingAreaName: "missing_area_name",
  missingBeachAreaName: "missing_beach_area_name",
  missingLatLng: "missing_lat_lng",
} as const;

export type ListingVisibilityReasonCode =
  (typeof LISTING_VISIBILITY_REASON_CODES)[keyof typeof LISTING_VISIBILITY_REASON_CODES];

// Centralized, operator-managed visibility overrides.
// Keep IDs/slugs/adapter keys lowercase/trimmed where applicable.
export const LISTING_VISIBILITY_RULES = {
  manuallyHiddenListingIds: [] as string[],
  manuallyHiddenListingSlugs: [] as string[],
  manuallyHiddenAdapterKeys: [] as string[],
} as const;
