import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertCanonicalQuotesSidecarRecord,
  type CanonicalQuoteObservation,
  type CanonicalQuotesSidecarRecord,
} from "@/lib/pricing/contracts/quote-observations-contract";
import { runWithConcurrency } from "@/lib/pricing/quotes/shared/run-with-concurrency";
import type { QuoteProgress } from "@/lib/pricing/quotes/types";

type CliOptions = {
  maxListings: number;
  listingId: string | null;
  weeks: number;
  nights: number;
  adults: number;
  children: number;
  promoCode: string;
  quoteConcurrency: number;
  listingConcurrency: number;
  skipExisting: boolean;
};

type CoastDetailRecord = {
  external_listing_id: string;
  detail_url: string;
  property_profile?: {
    unit_id?: string;
  };
};

type CoastStatus = {
  code?: unknown;
  description?: unknown;
};

type CoastFeeLine = {
  id?: unknown;
  name?: unknown;
  value?: unknown;
  active?: unknown;
};

type CoastQuoteData = {
  price?: unknown;
  taxes?: unknown;
  total?: unknown;
  currency?: unknown;
  required_fees?: unknown;
  optional_fees?: unknown;
  taxes_details?: unknown;
};

type CoastQuoteResponse = {
  status?: CoastStatus;
  data?: CoastQuoteData;
};

type RawObservation = {
  startDate: string;
  endDate: string;
  quoteAvailable: boolean;
  quoteUnavailableReason: string | null;
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotal: number | null;
  grandTotal: number | null;
  currency: string;
  handoffUrl: string;
  feeLines: Array<{ name: string; amount: number }>;
};

const ADAPTER_KEY = "coastproperties30a" as const;
const BASE_HOST = "https://www.coast-properties.com";
const AJAX_ENDPOINT = `${BASE_HOST}/wp-admin/admin-ajax.php`;
const DEFAULT_LISTINGS = 10;
const DEFAULT_WEEKS = 24;
const DEFAULT_NIGHTS = 7;
const DEFAULT_QUOTE_CONCURRENCY = 3;
const DEFAULT_LISTING_CONCURRENCY = 1;
const MAX_QUOTE_CONCURRENCY = 4;
const MAX_LISTING_CONCURRENCY = 1;
const MAX_RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 900;
const DEFAULT_BASE_NIGHTLY_FALLBACK = 650;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return roundCurrency((sorted[middle - 1]! + sorted[middle]!) / 2);
  }

  return roundCurrency(sorted[middle]!);
}

function interpolateValue(
  values: Array<number | null>,
  index: number,
): number | null {
  const current = values[index];
  if (current !== null) {
    return current;
  }

  let leftIndex = index - 1;
  while (leftIndex >= 0 && values[leftIndex] === null) {
    leftIndex -= 1;
  }

  let rightIndex = index + 1;
  while (rightIndex < values.length && values[rightIndex] === null) {
    rightIndex += 1;
  }

  const leftValue = leftIndex >= 0 ? values[leftIndex] : null;
  const rightValue = rightIndex < values.length ? values[rightIndex] : null;

  if (leftValue !== null && rightValue !== null) {
    const span = rightIndex - leftIndex;
    const offset = index - leftIndex;
    const ratio = offset / span;
    return roundCurrency(leftValue + (rightValue - leftValue) * ratio);
  }

  if (leftValue !== null) {
    return leftValue;
  }

  if (rightValue !== null) {
    return rightValue;
  }

  return null;
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

function parseMoney(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? roundCurrency(value) : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(/,/g, ""));
    return Number.isFinite(parsed) ? roundCurrency(parsed) : null;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function toIsoFromUsDate(usDate: string): string {
  const match = usDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) {
    return usDate;
  }
  return `${match[3]}-${match[1]}-${match[2]}`;
}

function parseFeeArray(
  value: unknown,
): Array<{ name: string; amount: number }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const line = entry as CoastFeeLine;
      const amount = parseMoney(line.value);
      if (amount === null) {
        return null;
      }

      const name = (typeof line.name === "string" && line.name.trim()) || "Fee";
      return {
        name,
        amount,
      };
    })
    .filter((line): line is { name: string; amount: number } => line !== null);
}

function parseActiveOptionalFeeArray(
  value: unknown,
): Array<{ name: string; amount: number }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const line = entry as CoastFeeLine;
      const isActive =
        line.active === 1 || line.active === "1" || line.active === true;
      if (!isActive) {
        return null;
      }

      const amount = parseMoney(line.value);
      if (amount === null) {
        return null;
      }

      const name =
        (typeof line.name === "string" && line.name.trim()) || "Optional Fee";
      return {
        name,
        amount,
      };
    })
    .filter((line): line is { name: string; amount: number } => line !== null);
}

function sumFeeLines(lines: Array<{ name: string; amount: number }>): number {
  return roundCurrency(lines.reduce((total, line) => total + line.amount, 0));
}

function buildCheckoutUrl(input: {
  unitId: string;
  adults: number;
  children: number;
  startDateIso: string;
  endDateIso: string;
}): string {
  const params = new URLSearchParams();
  params.set("unit", input.unitId);
  params.set("oc", String(Math.max(1, input.adults)));
  params.set("sd", input.startDateIso);
  params.set("ed", input.endDateIso);
  params.set("os", String(Math.max(0, input.children)));
  return `${BASE_HOST}/checkout/?${params.toString()}`;
}

function parseArgs(argv: string[]): CliOptions {
  let maxListings = DEFAULT_LISTINGS;
  let listingId: string | null = null;
  let weeks = DEFAULT_WEEKS;
  let nights = DEFAULT_NIGHTS;
  let adults = 1;
  let children = 0;
  let promoCode = "";
  let quoteConcurrency = DEFAULT_QUOTE_CONCURRENCY;
  let listingConcurrency = DEFAULT_LISTING_CONCURRENCY;
  let skipExisting = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--max-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxListings = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--listing-id" && value) {
      listingId = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--weeks" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        weeks = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--nights" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        nights = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--adults" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        adults = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--children" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        children = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--promo-code" && value) {
      promoCode = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--quote-concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        quoteConcurrency = Math.min(
          MAX_QUOTE_CONCURRENCY,
          Math.max(1, Math.floor(parsed)),
        );
      }
      index += 1;
      continue;
    }

    if (arg === "--listing-concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        listingConcurrency = Math.min(
          MAX_LISTING_CONCURRENCY,
          Math.max(1, Math.floor(parsed)),
        );
      }
      index += 1;
      continue;
    }

    if (arg === "--skip-existing") {
      skipExisting = true;
      continue;
    }

    if (arg === "--no-skip-existing") {
      skipExisting = false;
      continue;
    }
  }

  return {
    maxListings,
    listingId,
    weeks,
    nights,
    adults,
    children,
    promoCode,
    quoteConcurrency,
    listingConcurrency,
    skipExisting,
  };
}

async function listDetailFiles(detailsJsonDir: string): Promise<string[]> {
  const entries = await readdir(detailsJsonDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fetchQuote(input: {
  detailUrl: string;
  unitId: string;
  startDateUs: string;
  endDateUs: string;
  adults: number;
  children: number;
  promoCode: string;
}): Promise<RawObservation> {
  const startDateIso = toIsoFromUsDate(input.startDateUs);
  const endDateIso = toIsoFromUsDate(input.endDateUs);

  const defaultUnavailable: RawObservation = {
    startDate: startDateIso,
    endDate: endDateIso,
    quoteAvailable: false,
    quoteUnavailableReason: "Quote response unavailable",
    baseTotal: null,
    taxesTotal: null,
    feesTotal: null,
    grandTotal: null,
    currency: "USD",
    handoffUrl: buildCheckoutUrl({
      unitId: input.unitId,
      adults: input.adults,
      children: input.children,
      startDateIso,
      endDateIso,
    }),
    feeLines: [],
  };

  const availabilityPayload = {
    methodName: "VerifyPropertyAvailability",
    params: {
      unit_id: Number(input.unitId),
      startdate: input.startDateUs,
      enddate: input.endDateUs,
      occupants: String(Math.max(1, input.adults)),
      occupants_small: String(Math.max(0, input.children)),
      pets: "0",
      use_room_type_logic: 0,
      include_coupon_information: 1,
    },
  };

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const availabilityBody = new URLSearchParams();
    availabilityBody.set("action", "streamlinecore-api-request");
    availabilityBody.set("params", JSON.stringify(availabilityPayload));

    const availabilityResponse = await fetch(AJAX_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "user-agent": USER_AGENT,
        referer: input.detailUrl,
        origin: BASE_HOST,
      },
      body: availabilityBody.toString(),
    });

    if (
      availabilityResponse.status === 429 &&
      attempt < MAX_RATE_LIMIT_RETRIES
    ) {
      await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
      continue;
    }

    if (!availabilityResponse.ok) {
      return {
        ...defaultUnavailable,
        quoteUnavailableReason: `VerifyPropertyAvailability HTTP ${availabilityResponse.status}`,
      };
    }

    let availabilityParsed: CoastQuoteResponse;
    try {
      availabilityParsed =
        (await availabilityResponse.json()) as CoastQuoteResponse;
    } catch {
      return {
        ...defaultUnavailable,
        quoteUnavailableReason:
          "VerifyPropertyAvailability returned invalid JSON",
      };
    }

    const availabilityStatus = availabilityParsed.status;
    if (availabilityStatus && typeof availabilityStatus === "object") {
      const code = asString(availabilityStatus.code);
      const reason =
        asString(availabilityStatus.description) ?? "Dates unavailable";
      return {
        ...defaultUnavailable,
        quoteUnavailableReason: code ? `${code}: ${reason}` : reason,
      };
    }

    break;
  }

  const requestPayload = {
    methodName: "GetPreReservationPrice",
    params: {
      unit_id: Number(input.unitId),
      startdate: input.startDateUs,
      enddate: input.endDateUs,
      occupants: String(Math.max(1, input.adults)),
      occupants_small: String(Math.max(0, input.children)),
      pets: "0",
      include_coupon_information: 1,
      ...(input.promoCode
        ? { coupon_code: input.promoCode }
        : { include_coupon_information: 1 }),
    },
  };

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const body = new URLSearchParams();
    body.set("action", "streamlinecore-api-request");
    body.set("params", JSON.stringify(requestPayload));

    const response = await fetch(AJAX_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "user-agent": USER_AGENT,
        referer: input.detailUrl,
        origin: BASE_HOST,
      },
      body: body.toString(),
    });

    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
      continue;
    }

    if (!response.ok) {
      return {
        ...defaultUnavailable,
        quoteUnavailableReason: `Quote HTTP ${response.status}`,
      };
    }

    let parsed: CoastQuoteResponse;
    try {
      parsed = (await response.json()) as CoastQuoteResponse;
    } catch {
      return {
        ...defaultUnavailable,
        quoteUnavailableReason: "Quote endpoint returned invalid JSON",
      };
    }

    const status = parsed.status;
    if (status && typeof status === "object") {
      const code = asString(status.code);
      const reason = asString(status.description) ?? "Dates unavailable";
      return {
        ...defaultUnavailable,
        quoteUnavailableReason: code ? `${code}: ${reason}` : reason,
      };
    }

    const data = (parsed.data ?? {}) as CoastQuoteData;
    const baseTotal = parseMoney(data.price);
    const grandTotal = parseMoney(data.total);
    const currency = asString(data.currency) ?? "USD";

    const requiredFeeLines = parseFeeArray(data.required_fees);
    const optionalFeeLines = parseActiveOptionalFeeArray(data.optional_fees);
    const feeLines = [...requiredFeeLines, ...optionalFeeLines];
    const feesTotal = sumFeeLines(feeLines);

    const taxesLines = parseFeeArray(data.taxes_details);
    let taxesTotal = sumFeeLines(taxesLines);
    if (taxesTotal === 0) {
      const taxesAggregate = parseMoney(data.taxes);
      if (taxesAggregate !== null) {
        taxesTotal = Math.max(0, roundCurrency(taxesAggregate - feesTotal));
      }
    }

    if (baseTotal === null || grandTotal === null) {
      return {
        ...defaultUnavailable,
        quoteUnavailableReason: "Quote payload missing total fields",
      };
    }

    return {
      ...defaultUnavailable,
      quoteAvailable: true,
      quoteUnavailableReason: null,
      baseTotal,
      taxesTotal,
      feesTotal,
      grandTotal,
      currency,
      feeLines,
    };
  }

  return {
    ...defaultUnavailable,
    quoteUnavailableReason: "Too many requests after retry attempts",
  };
}

function isoToUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

async function buildSidecarForListing(input: {
  detailPath: string;
  quotesDir: string;
  options: CliOptions;
  capturedAtIso: string;
}): Promise<{
  listingId: string;
  observations: number;
  availableQuotes: number;
}> {
  const raw = await readFile(input.detailPath, "utf8");
  const detail = JSON.parse(raw) as CoastDetailRecord;
  const unitId =
    detail.property_profile?.unit_id?.trim() ??
    detail.external_listing_id.trim();
  if (!unitId) {
    throw new Error(
      `Missing unit id for listing ${detail.external_listing_id}`,
    );
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const anchorDate = firstSaturdayOnOrAfter(todayIso);

  const sampleIndexes = Array.from(
    { length: input.options.weeks },
    (_, index) => index,
  );
  const rawObservations = await runWithConcurrency(
    sampleIndexes,
    input.options.quoteConcurrency,
    async (index) => {
      const startDateIso = addDays(anchorDate, index * 7);
      const endDateIso = addDays(startDateIso, input.options.nights);
      return fetchQuote({
        detailUrl: detail.detail_url,
        unitId,
        startDateUs: isoToUsDate(startDateIso),
        endDateUs: isoToUsDate(endDateIso),
        adults: input.options.adults,
        children: input.options.children,
        promoCode: input.options.promoCode,
      });
    },
  );

  const baseNightlySeries: Array<number | null> = rawObservations.map((obs) =>
    obs.baseTotal !== null && obs.baseTotal > 0
      ? roundCurrency(obs.baseTotal / input.options.nights)
      : null,
  );
  const availableNightlies = baseNightlySeries.filter(
    (value): value is number => value !== null && value > 0,
  );
  const fallbackBaseNightly =
    median(availableNightlies) ?? DEFAULT_BASE_NIGHTLY_FALLBACK;

  const observedTaxRates = rawObservations
    .map((obs) => {
      if (
        obs.baseTotal === null ||
        obs.baseTotal <= 0 ||
        obs.taxesTotal === null ||
        obs.taxesTotal < 0
      ) {
        return null;
      }
      return roundCurrency(obs.taxesTotal / obs.baseTotal);
    })
    .filter((value): value is number => value !== null);

  const observedFeeRates = rawObservations
    .map((obs) => {
      if (
        obs.baseTotal === null ||
        obs.baseTotal <= 0 ||
        obs.feesTotal === null ||
        obs.feesTotal < 0
      ) {
        return null;
      }
      return roundCurrency(obs.feesTotal / obs.baseTotal);
    })
    .filter((value): value is number => value !== null);

  const fallbackTaxRate = median(observedTaxRates) ?? 0;
  const fallbackFeeRate = median(observedFeeRates) ?? 0;

  const observations: CanonicalQuoteObservation[] = rawObservations.map(
    (rawObservation, index) => {
      const baseNightly =
        baseNightlySeries[index] ??
        interpolateValue(baseNightlySeries, index) ??
        fallbackBaseNightly;

      const baseTotal =
        rawObservation.baseTotal !== null && rawObservation.baseTotal > 0
          ? rawObservation.baseTotal
          : roundCurrency(baseNightly * input.options.nights);

      const taxesTotal =
        rawObservation.taxesTotal !== null && rawObservation.taxesTotal >= 0
          ? rawObservation.taxesTotal
          : roundCurrency(baseTotal * fallbackTaxRate);

      const feesTotal =
        rawObservation.feesTotal !== null && rawObservation.feesTotal >= 0
          ? rawObservation.feesTotal
          : roundCurrency(baseTotal * fallbackFeeRate);

      const computedGrandTotal = roundCurrency(
        baseTotal + taxesTotal + feesTotal,
      );
      const grandTotal =
        rawObservation.grandTotal !== null && rawObservation.grandTotal > 0
          ? rawObservation.grandTotal
          : computedGrandTotal;

      const allInNightly = roundCurrency(grandTotal / input.options.nights);

      return {
        sampled_at: input.capturedAtIso,
        captured_at: input.capturedAtIso,
        source_listing_id: detail.external_listing_id,
        currency: rawObservation.currency,
        start_date: rawObservation.startDate,
        end_date: rawObservation.endDate,
        check_in_date: rawObservation.startDate,
        check_out_date: rawObservation.endDate,
        nights: input.options.nights,
        base_nightly: roundCurrency(baseNightly),
        all_in_nightly: allInNightly,
        quote_available: rawObservation.quoteAvailable,
        quote_unavailable_reason: rawObservation.quoteUnavailableReason,
        base_total: baseTotal,
        taxes_total: taxesTotal,
        fees_total_excl_taxes: feesTotal,
        fee_lines: rawObservation.feeLines,
        grand_total: grandTotal,
        quoted_total: grandTotal,
        fee_pct_of_base: roundCurrency(feesTotal / Math.max(baseTotal, 1)),
        tax_pct_of_base: roundCurrency(taxesTotal / Math.max(baseTotal, 1)),
        non_base_pct_of_total: roundCurrency(
          (taxesTotal + feesTotal) / Math.max(baseTotal, 1),
        ),
        all_in_multiplier: roundCurrency(grandTotal / Math.max(baseTotal, 1)),
        handoff_url: rawObservation.handoffUrl,
        source: "quote_api",
      } satisfies CanonicalQuoteObservation;
    },
  );

  const sidecar: CanonicalQuotesSidecarRecord = {
    adapter_key: ADAPTER_KEY,
    external_listing_id: detail.external_listing_id,
    detail_url: detail.detail_url,
    captured_at: input.capturedAtIso,
    currency: observations[0]?.currency ?? "USD",
    quote_window_cadence: "weekly_sat_to_sat",
    quote_window_gap_policy: "record_unavailable_without_date_shift",
    quote_window_anchor_date: anchorDate,
    quote_window_days: input.options.weeks * 7,
    quote_sample_step_days: 7,
    quote_nights: input.options.nights,
    quote_max_queries: observations.length,
    endpoint_path:
      "/wp-admin/admin-ajax.php?action=streamlinecore-api-request&methodName=GetPreReservationPrice",
    observations,
  };

  assertCanonicalQuotesSidecarRecord(sidecar);

  const outputPath = resolve(
    input.quotesDir,
    `${detail.external_listing_id}.json`,
  );
  await writeFile(outputPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");

  return {
    listingId: detail.external_listing_id,
    observations: observations.length,
    availableQuotes: rawObservations.filter((obs) => obs.quoteAvailable).length,
  };
}

export async function runCoastProperties30AQuoteCli(
  argv: string[] = process.argv.slice(2),
  progress: QuoteProgress | null = null,
): Promise<void> {
  const options = parseArgs(argv);
  const root = process.cwd();
  const adapterRoot = resolve(
    root,
    "src",
    "lib",
    "data",
    "external-sources",
    ADAPTER_KEY,
  );
  const detailsJsonDir = resolve(adapterRoot, "details", "json");
  const quotesDir = resolve(adapterRoot, "details", "quotes");

  await mkdir(quotesDir, { recursive: true });

  const detailFiles = await listDetailFiles(detailsJsonDir);
  let selected = detailFiles;
  if (options.listingId) {
    selected = detailFiles.filter(
      (name) => name === `${options.listingId}.json`,
    );
  } else {
    selected = detailFiles.slice(0, options.maxListings);
  }

  if (selected.length === 0) {
    throw new Error("No detail files selected for quoting.");
  }

  const totalSelected = selected.length;
  let skippedExisting = 0;
  if (options.skipExisting) {
    const remaining: string[] = [];
    for (const fileName of selected) {
      const listingId = fileName.replace(/\.json$/i, "");
      const quotePath = resolve(quotesDir, `${listingId}.json`);
      if (await fileExists(quotePath)) {
        skippedExisting += 1;
        continue;
      }
      remaining.push(fileName);
    }
    selected = remaining;
  }

  progress?.phase("starting coastproperties30a quote sampling");
  progress?.info(
    `listings_selected=${totalSelected} pending=${selected.length} skipped_existing=${skippedExisting} weeks=${options.weeks} nights=${options.nights} adults=${options.adults} children=${options.children} quote_concurrency=${options.quoteConcurrency} listing_concurrency=${options.listingConcurrency}`,
  );

  if (selected.length === 0) {
    console.log(`${ADAPTER_KEY} quote sidecar generation complete.`);
    console.log(`- listings_selected: ${totalSelected}`);
    console.log(`- processed: 0`);
    console.log(`- skipped_existing: ${skippedExisting}`);
    progress?.success(
      `coastproperties30a quote sampling complete listings_selected=${totalSelected} processed=0 skipped_existing=${skippedExisting}`,
    );
    return;
  }

  const capturedAtIso = new Date().toISOString();
  let processedCount = 0;

  const summaries = await runWithConcurrency(
    selected,
    options.listingConcurrency,
    async (fileName) => {
      const summary = await buildSidecarForListing({
        detailPath: resolve(detailsJsonDir, fileName),
        quotesDir,
        options,
        capturedAtIso,
      });

      processedCount += 1;
      const completed = skippedExisting + processedCount;
      const percent = Math.round((completed / totalSelected) * 100);

      progress?.tick(
        `quoted listing=${summary.listingId} observations=${summary.observations} available=${summary.availableQuotes} progress=${completed}/${totalSelected} (${percent}%)`,
      );

      if (!progress) {
        console.log(
          `quoted listing=${summary.listingId} observations=${summary.observations} available=${summary.availableQuotes} progress=${completed}/${totalSelected} (${percent}%)`,
        );
      }

      return summary;
    },
  );

  console.log(`${ADAPTER_KEY} quote sidecar generation complete.`);
  console.log(`- listings_selected: ${totalSelected}`);
  console.log(`- processed: ${summaries.length}`);
  console.log(`- skipped_existing: ${skippedExisting}`);
  console.log(`- captured_at: ${capturedAtIso}`);
  console.log(
    `- listing_ids: ${summaries.map((item) => item.listingId).join(", ")}`,
  );

  progress?.success(
    `coastproperties30a quote sampling complete listings_selected=${totalSelected} processed=${summaries.length} skipped_existing=${skippedExisting}`,
  );
}
