export type ListingPricingConfidence = "high" | "medium" | "low";

export type ListingPricingValueOrigin =
  | "quote_anchor"
  | "scraped_rate"
  | "interpolated"
  | "assumptions_anchor"
  | "global_default";

export type ListingPricingQuoteAnchorScope =
  | "same_month"
  | "surrounding_months"
  | "none";

export type ListingPricingQualityBand = "high" | "medium" | "low";

export type ListingPricingFeeComponent = {
  name: string;
  amount: number;
  kind: "fee" | "tax" | "other";
  source: "quote_exact" | "assumption" | "derived";
};

export type ListingPricingDayRecord = {
  date: string;
  is_available: boolean;
  availability_status_code?: "A" | "U" | "I" | "O" | "X";
  is_available_for_checkin?: boolean;
  is_available_for_checkout?: boolean;
  min_nights: number | null;
  base_nightly: number;
  all_in_nightly: number;
  currency: string;
  source: string;
  confidence: ListingPricingConfidence;
  estimated_fees_nightly?: number;
  estimated_taxes_nightly?: number;
  fee_components?: ListingPricingFeeComponent[];
  provenance?: {
    value_origin: ListingPricingValueOrigin;
    quote_anchor_scope: ListingPricingQuoteAnchorScope;
    has_any_quote_observations: boolean;
    nearest_quote_observation_distance_days?: number | null;
  };
};

export type ListingPricingQualityMonthSummary = {
  month: string;
  day_count: number;
  contrived_days: number;
  quote_anchor_same_month_days: number;
  quote_anchor_surrounding_month_days: number;
  interpolated_days: number;
  scraped_rate_days: number;
  quality_band: ListingPricingQualityBand;
};

export type ListingPricingHorizon = {
  from_date: string;
  to_date: string;
  weeks: number;
};

export type ListingPricingCacheRecord = {
  adapter_key: string;
  external_listing_id: string;
  detail_url: string;
  generated_at: string;
  horizon: ListingPricingHorizon;
  source_summary: Record<string, number>;
  days: ListingPricingDayRecord[];
  assumptions_snapshot?: {
    avg_fee_pct_of_base: number;
    avg_tax_pct_of_base: number;
    avg_all_in_multiplier: number;
  };
  quality_summary?: {
    has_any_quote_observations: boolean;
    quote_observation_months: string[];
    monthly: ListingPricingQualityMonthSummary[];
  };
};

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function assertListingPricingCacheRecord(
  value: ListingPricingCacheRecord,
): void {
  if (!value.adapter_key || !value.external_listing_id || !value.detail_url) {
    throw new Error("Invalid listing pricing cache identity fields");
  }

  if (
    !isIsoDate(value.horizon.from_date) ||
    !isIsoDate(value.horizon.to_date)
  ) {
    throw new Error("Invalid listing pricing cache horizon dates");
  }

  if (!Array.isArray(value.days) || value.days.length === 0) {
    throw new Error("Listing pricing cache must contain at least one day");
  }

  for (const day of value.days) {
    if (!isIsoDate(day.date)) {
      throw new Error(`Invalid day date: ${day.date}`);
    }
    if (!Number.isFinite(day.base_nightly) || day.base_nightly <= 0) {
      throw new Error(`Invalid base_nightly for ${day.date}`);
    }
    if (!Number.isFinite(day.all_in_nightly) || day.all_in_nightly <= 0) {
      throw new Error(`Invalid all_in_nightly for ${day.date}`);
    }
  }
}
