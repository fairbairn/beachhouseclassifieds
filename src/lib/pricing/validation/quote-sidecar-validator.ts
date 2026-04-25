import {
  assertCanonicalQuotesSidecarRecord,
  type CanonicalQuoteObservation,
  type CanonicalQuotesSidecarRecord,
} from "@/lib/pricing/contracts/quote-observations-contract";

export type QuoteValidationIssue = {
  code: string;
  message: string;
};

export type QuoteValidationOptions = {
  requireNonNullPricingFields?: boolean;
  expectedNights?: number;
  expectedMaxQueries?: number;
  minimumObservationCount?: number;
};

const DEFAULT_EXPECTED_NIGHTS = 7;
const DEFAULT_MINIMUM_MAX_QUERIES = 24;
const DEFAULT_MINIMUM_OBSERVATION_COUNT = 24;
const MIN_VALID_BASE_TOTAL = 100;
const ADAPTER_ALLOW_FEES_GE_BASE = new Set<string>(["keyco30a"]);

const ADAPTER_EXPECTED_HANDOFF_SIGNATURES: Record<string, string[]> = {
  scenicstays30a: [
    "https://myscenicstays.com/rentals/book-now?keys=checkin,checkout,propertyID",
  ],
  stayat30a: [
    "https://www.stayat30avacationrentals.com/vacation-rentals/checkout/?keys=arr,depart,id,nights,persons,quote",
  ],
};

function expectedAdapterSignatures(adapterKey: string): string[] {
  return ADAPTER_EXPECTED_HANDOFF_SIGNATURES[adapterKey] ?? [];
}

function toHandoffSignature(handoffUrl: string): string | null {
  try {
    const parsed = new URL(handoffUrl);
    const queryKeys = [...new Set(parsed.searchParams.keys())].sort();
    const hashPayload = parsed.hash.startsWith("#")
      ? parsed.hash.slice(1)
      : parsed.hash;
    const hashParams = new URLSearchParams(hashPayload);
    const hashKeys = [...new Set(hashParams.keys())].sort();

    if (queryKeys.length > 0) {
      return `${parsed.origin}${parsed.pathname}?keys=${queryKeys.join(",")}`;
    }

    if (hashKeys.length > 0) {
      return `${parsed.origin}${parsed.pathname}#keys=${hashKeys.join(",")}`;
    }

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayOfWeek(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
}

function firstSaturdayOnOrAfter(isoDate: string): string {
  const day = dayOfWeek(isoDate);
  const delta = (6 - day + 7) % 7;
  return addDays(isoDate, delta);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function checkRequiredPricingFields(
  observation: CanonicalQuoteObservation,
): QuoteValidationIssue[] {
  const issues: QuoteValidationIssue[] = [];

  const requiredPositiveFields: Array<keyof CanonicalQuoteObservation> = [
    "base_nightly",
    "all_in_nightly",
    "base_total",
    "grand_total",
    "quoted_total",
    "all_in_multiplier",
  ];

  for (const field of requiredPositiveFields) {
    const value = observation[field];
    if (!isFiniteNumber(value) || value <= 0) {
      issues.push({
        code: "missing_pricing_value",
        message: `${field} must be a finite positive number`,
      });
    }
  }

  const requiredNonNegativeFields: Array<keyof CanonicalQuoteObservation> = [
    "taxes_total",
    "fees_total_excl_taxes",
    "fee_pct_of_base",
    "tax_pct_of_base",
    "non_base_pct_of_total",
  ];

  for (const field of requiredNonNegativeFields) {
    const value = observation[field];
    if (!isFiniteNumber(value) || value < 0) {
      issues.push({
        code: "missing_pricing_value",
        message: `${field} must be a finite non-negative number`,
      });
    }
  }

  return issues;
}

function validateObservationCadence(
  observation: CanonicalQuoteObservation,
  expectedNights: number,
  expectedStartDate: string,
): QuoteValidationIssue[] {
  const issues: QuoteValidationIssue[] = [];

  if (observation.start_date !== expectedStartDate) {
    issues.push({
      code: "cadence_drift",
      message: `expected start_date=${expectedStartDate}, received ${observation.start_date}`,
    });
  }

  if (observation.check_in_date !== observation.start_date) {
    issues.push({
      code: "checkin_mismatch",
      message: "check_in_date must equal start_date",
    });
  }

  if (observation.nights !== expectedNights) {
    issues.push({
      code: "invalid_nights",
      message: `nights must equal ${expectedNights}`,
    });
  }

  const expectedEndDate = addDays(observation.start_date, expectedNights);
  if (observation.end_date !== expectedEndDate) {
    issues.push({
      code: "end_date_mismatch",
      message: `end_date must equal ${expectedEndDate}`,
    });
  }

  if (observation.check_out_date !== expectedEndDate) {
    issues.push({
      code: "checkout_mismatch",
      message: `check_out_date must equal ${expectedEndDate}`,
    });
  }

  return issues;
}

function validateAdaptiveObservationCadence(
  observation: CanonicalQuoteObservation,
  expectedNights: number,
): QuoteValidationIssue[] {
  const issues: QuoteValidationIssue[] = [];

  if (observation.check_in_date !== observation.start_date) {
    issues.push({
      code: "checkin_mismatch",
      message: "check_in_date must equal start_date",
    });
  }

  if (!isFiniteNumber(observation.nights) || observation.nights <= 0) {
    issues.push({
      code: "invalid_nights",
      message: "nights must be a finite positive number",
    });
  } else if (observation.nights > expectedNights) {
    issues.push({
      code: "invalid_nights",
      message: `nights must be <= ${expectedNights}`,
    });
  }

  const expectedEndDate = addDays(observation.start_date, observation.nights);
  if (observation.end_date !== expectedEndDate) {
    issues.push({
      code: "end_date_mismatch",
      message: `end_date must equal ${expectedEndDate}`,
    });
  }

  if (observation.check_out_date !== expectedEndDate) {
    issues.push({
      code: "checkout_mismatch",
      message: `check_out_date must equal ${expectedEndDate}`,
    });
  }

  return issues;
}

function validateAvailableQuoteSanity(
  observation: CanonicalQuoteObservation,
  adapterKey: string,
): QuoteValidationIssue[] {
  const issues: QuoteValidationIssue[] = [];

  const baseTotal = observation.base_total;
  const taxesTotal = observation.taxes_total;
  const feesTotal = observation.fees_total_excl_taxes;
  const grandTotal = observation.grand_total;

  if (!isFiniteNumber(baseTotal) || baseTotal < MIN_VALID_BASE_TOTAL) {
    issues.push({
      code: "invalid_base_total",
      message: `base_total must be >= ${MIN_VALID_BASE_TOTAL} when quote_available=true`,
    });
  }

  if (!isFiniteNumber(taxesTotal) || taxesTotal <= 0) {
    issues.push({
      code: "invalid_taxes_total",
      message: "taxes_total must be > 0 when quote_available=true",
    });
  }

  if (
    !isFiniteNumber(grandTotal) ||
    !isFiniteNumber(baseTotal) ||
    grandTotal <= baseTotal
  ) {
    issues.push({
      code: "invalid_grand_total",
      message: "grand_total must be > base_total when quote_available=true",
    });
  }

  const allowFeesGeBase = ADAPTER_ALLOW_FEES_GE_BASE.has(adapterKey);
  if (
    !isFiniteNumber(feesTotal) ||
    !isFiniteNumber(baseTotal) ||
    (!allowFeesGeBase && feesTotal >= baseTotal)
  ) {
    issues.push({
      code: "invalid_fees_total",
      message: allowFeesGeBase
        ? "fees_total_excl_taxes must be a finite number when quote_available=true"
        : "fees_total_excl_taxes must be < base_total when quote_available=true",
    });
  }

  return issues;
}

export function validateCanonicalQuoteSidecar(
  sidecar: CanonicalQuotesSidecarRecord,
  options: QuoteValidationOptions = {},
): QuoteValidationIssue[] {
  const issues: QuoteValidationIssue[] = [];
  const expectedNights = options.expectedNights ?? DEFAULT_EXPECTED_NIGHTS;
  const expectedMaxQueries =
    options.expectedMaxQueries ?? DEFAULT_MINIMUM_MAX_QUERIES;
  const minimumObservationCount =
    options.minimumObservationCount ?? DEFAULT_MINIMUM_OBSERVATION_COUNT;
  const requireNonNullPricingFields =
    options.requireNonNullPricingFields ?? true;

  try {
    assertCanonicalQuotesSidecarRecord(sidecar);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({
      code: "contract_validation_failed",
      message,
    });
    return issues;
  }

  const observations = [...sidecar.observations].sort((left, right) =>
    left.start_date.localeCompare(right.start_date),
  );

  if (sidecar.quote_nights !== expectedNights) {
    issues.push({
      code: "invalid_quote_nights",
      message: `quote_nights must equal ${expectedNights}`,
    });
  }

  const isStrictWeeklyCadence =
    sidecar.quote_window_cadence === "weekly_sat_to_sat";
  const isAdaptiveWeeklyCadence =
    sidecar.quote_window_cadence === "weekly_anchor_adaptive_span";

  if (!isStrictWeeklyCadence && !isAdaptiveWeeklyCadence) {
    issues.push({
      code: "invalid_quote_window_cadence",
      message:
        'quote_window_cadence must equal "weekly_sat_to_sat" or "weekly_anchor_adaptive_span"',
    });
  }

  const quoteMaxQueries = sidecar.quote_max_queries;
  if (
    !isFiniteNumber(quoteMaxQueries) ||
    quoteMaxQueries < expectedMaxQueries
  ) {
    issues.push({
      code: "invalid_quote_max_queries",
      message: `quote_max_queries must be >= ${expectedMaxQueries}`,
    });
  }

  if (observations.length < minimumObservationCount) {
    issues.push({
      code: "invalid_observation_count",
      message: `observations must contain at least ${minimumObservationCount} attempted records`,
    });
  }

  if (observations.length === 0) {
    issues.push({
      code: "missing_observations",
      message: "observations must contain at least one record",
    });
    return issues;
  }

  const captureDate = sidecar.captured_at.slice(0, 10);
  const expectedAnchor = firstSaturdayOnOrAfter(captureDate);
  const firstStartDate = observations[0]?.start_date;

  if (isStrictWeeklyCadence && firstStartDate !== expectedAnchor) {
    issues.push({
      code: "anchor_mismatch",
      message: `first observation start_date must equal next Saturday (${expectedAnchor})`,
    });
  }

  if (sidecar.quote_window_anchor_date !== expectedAnchor) {
    issues.push({
      code: "anchor_metadata_mismatch",
      message: `quote_window_anchor_date must equal ${expectedAnchor}`,
    });
  }

  const nonNullHandoffObservations = observations.filter(
    (observation) =>
      typeof observation.handoff_url === "string" &&
      observation.handoff_url.trim().length > 0,
  );

  const adapterExpectedSignatures = expectedAdapterSignatures(
    sidecar.adapter_key,
  );

  const expectedHandoffSignature =
    nonNullHandoffObservations
      .find((observation) => observation.quote_available)
      ?.handoff_url?.trim() ??
    nonNullHandoffObservations[0]?.handoff_url?.trim() ??
    null;

  const expectedParsedSignature =
    expectedHandoffSignature === null
      ? null
      : toHandoffSignature(expectedHandoffSignature);

  const effectiveExpectedSignatures =
    adapterExpectedSignatures.length > 0
      ? adapterExpectedSignatures
      : expectedParsedSignature !== null
        ? [expectedParsedSignature]
        : [];

  if (expectedHandoffSignature !== null && expectedParsedSignature === null) {
    issues.push({
      code: "invalid_handoff_signature",
      message: "unable to parse baseline handoff_url signature",
    });
  }

  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]!;
    const cadenceIssues = isStrictWeeklyCadence
      ? validateObservationCadence(
          observation,
          expectedNights,
          addDays(expectedAnchor, index * expectedNights),
        )
      : validateAdaptiveObservationCadence(observation, expectedNights);
    for (const issue of cadenceIssues) {
      issues.push({
        code: issue.code,
        message: `observation[${index}]: ${issue.message}`,
      });
    }

    if (!observation.quote_available && !observation.quote_unavailable_reason) {
      issues.push({
        code: "missing_unavailable_reason",
        message: `observation[${index}]: quote_unavailable_reason is required when quote_available=false`,
      });
    }

    const handoffUrl =
      typeof observation.handoff_url === "string"
        ? observation.handoff_url.trim()
        : "";

    if (!handoffUrl) {
      issues.push({
        code: "missing_handoff_url",
        message: `observation[${index}]: handoff_url is required`,
      });
    } else {
      const parsedSignature = toHandoffSignature(handoffUrl);
      if (parsedSignature === null) {
        issues.push({
          code: "invalid_handoff_url",
          message: `observation[${index}]: handoff_url is not a valid URL`,
        });
      } else if (
        effectiveExpectedSignatures.length > 0 &&
        !effectiveExpectedSignatures.includes(parsedSignature)
      ) {
        issues.push({
          code: "handoff_signature_mismatch",
          message:
            `observation[${index}]: handoff_url signature mismatch; ` +
            `expected one of '${effectiveExpectedSignatures.join("' | '")}' got '${parsedSignature}'`,
        });
      }
    }

    if (observation.quote_available) {
      for (const issue of validateAvailableQuoteSanity(
        observation,
        sidecar.adapter_key,
      )) {
        issues.push({
          code: issue.code,
          message: `observation[${index}]: ${issue.message}`,
        });
      }
    }

    if (requireNonNullPricingFields) {
      for (const issue of checkRequiredPricingFields(observation)) {
        issues.push({
          code: issue.code,
          message: `observation[${index}]: ${issue.message}`,
        });
      }
    }
  }

  return issues;
}
