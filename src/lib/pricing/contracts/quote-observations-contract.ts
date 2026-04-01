export type QuoteFeeLine = {
  name: string;
  amount: number;
};

export type CanonicalQuoteObservation = {
  sampled_at: string;
  captured_at: string;
  source_listing_id: string;
  currency: string;
  start_date: string;
  end_date: string;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  base_nightly: number | null;
  all_in_nightly: number | null;
  quote_available: boolean;
  quote_unavailable_reason: string | null;
  base_total: number | null;
  taxes_total: number | null;
  fees_total_excl_taxes: number | null;
  fee_lines: QuoteFeeLine[];
  grand_total: number | null;
  quoted_total: number | null;
  fee_pct_of_base: number | null;
  tax_pct_of_base: number | null;
  non_base_pct_of_total: number | null;
  all_in_multiplier: number | null;
  handoff_url: string | null;
  source: "quote_api";
};

export type CanonicalQuoteAssumptionsSnapshot = {
  sample_count: number;
  avg_fee_pct_of_base: number;
  avg_tax_pct_of_base: number;
  avg_non_base_pct_of_total: number;
  avg_all_in_multiplier: number;
};

export type CanonicalQuotesSidecarRecord = {
  adapter_key: string;
  quote_module_version?: string;
  external_listing_id: string;
  detail_url: string;
  captured_at: string;
  currency: string;
  quote_window_cadence: "weekly_sat_to_sat";
  quote_window_gap_policy: "record_unavailable_without_date_shift";
  quote_window_anchor_date: string;
  quote_window_days: number;
  quote_sample_step_days: number;
  quote_nights: number;
  quote_max_queries?: number;
  endpoint_path?: string;
  quote_coupon?: string;
  assumptions_snapshot?: CanonicalQuoteAssumptionsSnapshot;
  observations: CanonicalQuoteObservation[];
};

function isIsoDateTime(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function assertCanonicalQuotesSidecarRecord(
  value: CanonicalQuotesSidecarRecord,
): void {
  if (!value.adapter_key || !value.external_listing_id || !value.detail_url) {
    throw new Error("Invalid quote sidecar identity fields");
  }

  if (!isIsoDateTime(value.captured_at)) {
    throw new Error("Invalid quote sidecar captured_at");
  }

  if (!isIsoDate(value.quote_window_anchor_date)) {
    throw new Error("Invalid quote sidecar quote_window_anchor_date");
  }

  if (value.quote_window_cadence !== "weekly_sat_to_sat") {
    throw new Error("Invalid quote sidecar quote_window_cadence");
  }

  if (
    value.quote_window_gap_policy !== "record_unavailable_without_date_shift"
  ) {
    throw new Error("Invalid quote sidecar quote_window_gap_policy");
  }

  if (!Array.isArray(value.observations)) {
    throw new Error("Quote sidecar observations must be an array");
  }

  for (const observation of value.observations) {
    if (!isIsoDateTime(observation.sampled_at)) {
      throw new Error("Invalid observation sampled_at");
    }
    if (!isIsoDateTime(observation.captured_at)) {
      throw new Error("Invalid observation captured_at");
    }
    if (
      !isIsoDate(observation.start_date) ||
      !isIsoDate(observation.end_date)
    ) {
      throw new Error("Invalid observation date range");
    }
    if (
      !isIsoDate(observation.check_in_date) ||
      !isIsoDate(observation.check_out_date)
    ) {
      throw new Error("Invalid observation check-in/check-out dates");
    }
    if (!Number.isFinite(observation.nights) || observation.nights <= 0) {
      throw new Error("Invalid observation nights");
    }
  }
}
