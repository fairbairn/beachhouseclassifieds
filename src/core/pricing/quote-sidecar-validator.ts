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
};

const DEFAULT_EXPECTED_NIGHTS = 7;

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

export function validateCanonicalQuoteSidecar(
  sidecar: CanonicalQuotesSidecarRecord,
  options: QuoteValidationOptions = {},
): QuoteValidationIssue[] {
  const issues: QuoteValidationIssue[] = [];
  const expectedNights = options.expectedNights ?? DEFAULT_EXPECTED_NIGHTS;
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

  if (firstStartDate !== expectedAnchor) {
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

  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]!;
    const expectedStart = addDays(expectedAnchor, index * expectedNights);

    const cadenceIssues = validateObservationCadence(
      observation,
      expectedNights,
      expectedStart,
    );
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
