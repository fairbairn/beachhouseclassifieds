import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertCanonicalQuotesSidecarRecord,
  type CanonicalQuoteObservation,
  type CanonicalQuotesSidecarRecord,
} from "@/lib/pricing/contracts/quote-observations-contract";
import { runWithConcurrency } from "@/lib/pricing/quotes/shared/run-with-concurrency";
import type { QuoteProgress } from "@/lib/pricing/quotes/types";
import type {
  SingleQuoteObservationInput,
  SingleQuoteObservationResult,
} from "@/lib/pricing/scraper-engine/types";

type CliOptions = {
  maxListings: number;
  listingId: string | null;
  weeks: number;
  nights: number;
  adults: number;
  children: number;
  pets: number;
  quoteConcurrency: number;
  listingConcurrency: number;
};

type DuneDetailRecord = {
  external_listing_id: string;
  detail_url: string;
};

type StreamlineFee = {
  name?: string;
  value?: number | string;
};

type StreamlinePreReservationPayload = {
  unit_id?: number;
  price?: number | string;
  taxes?: number | string;
  total?: number | string;
  currency?: string;
  required_fees?: StreamlineFee[];
  taxes_details?: StreamlineFee[];
};

type StreamlinePreReservationResponse = {
  data?: StreamlinePreReservationPayload;
  status?: {
    code?: string;
    description?: string;
  };
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

const ADAPTER_KEY = "dunevr30a" as const;
const DEFAULT_LISTINGS = 10;
const DEFAULT_WEEKS = 24;
const DEFAULT_NIGHTS = 7;
const DEFAULT_QUOTE_CONCURRENCY = 4;
const DEFAULT_LISTING_CONCURRENCY = 2;
const GLOBAL_DEFAULT_BASE_NIGHTLY = 700;
const DEFAULT_FALLBACK_TAX_PCT = 0.12;
const DEFAULT_FALLBACK_FEE_PCT = 0.35;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
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

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
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

function parseArgs(argv: string[]): CliOptions {
  let maxListings = DEFAULT_LISTINGS;
  let listingId: string | null = null;
  let weeks = DEFAULT_WEEKS;
  let nights = DEFAULT_NIGHTS;
  let adults = 2;
  let children = 0;
  let pets = 0;
  let quoteConcurrency = DEFAULT_QUOTE_CONCURRENCY;
  let listingConcurrency = DEFAULT_LISTING_CONCURRENCY;

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

    if (arg === "--pets" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        pets = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--quote-concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        quoteConcurrency = Math.max(1, Math.floor(parsed));
      }
      index += 1;
      continue;
    }

    if (arg === "--listing-concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        listingConcurrency = Math.max(1, Math.floor(parsed));
      }
      index += 1;
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
    pets,
    quoteConcurrency,
    listingConcurrency,
  };
}

function parseBaseOrigin(detailUrl: string): string {
  const parsed = new URL(detailUrl);
  return parsed.origin;
}

function buildCheckoutUrl(input: {
  detailUrl: string;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  pets: number;
}): string {
  const origin = parseBaseOrigin(input.detailUrl);
  const params = new URLSearchParams();
  params.set("unit", input.listingId);
  params.set("sd", input.checkInIso);
  params.set("ed", input.checkOutIso);
  params.set("oc", String(Math.max(1, input.adults)));
  params.set("os", String(Math.max(0, input.children)));
  return `${origin}/checkout/?${params.toString()}`;
}

async function verifyPropertyAvailability(input: {
  detailUrl: string;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  pets: number;
}): Promise<{ available: boolean; reason: string | null }> {
  const origin = parseBaseOrigin(input.detailUrl);
  const endpoint = `${origin}/wp-admin/admin-ajax.php`;
  const body = new URLSearchParams();
  body.set("action", "streamlinecore-api-request");
  body.set(
    "params",
    JSON.stringify({
      methodName: "VerifyPropertyAvailability",
      params: {
        unit_id: Number(input.listingId),
        startdate: toUsDate(input.checkInIso),
        enddate: toUsDate(input.checkOutIso),
        occupants: String(input.adults),
        occupants_small: String(input.children),
        pets: String(input.pets),
        use_room_type_logic: 0,
        include_coupon_information: 1,
      },
    }),
  );

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json,text/plain,*/*",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "user-agent": USER_AGENT,
      referer: input.detailUrl,
      origin,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    return {
      available: false,
      reason: `VerifyPropertyAvailability failed with status ${response.status}`,
    };
  }

  const payload = (await response.json()) as StreamlinePreReservationResponse;
  if (payload.status?.code) {
    return {
      available: false,
      reason: payload.status.description?.trim() || payload.status.code,
    };
  }

  return {
    available: true,
    reason: null,
  };
}

async function fetchPreReservationQuote(input: {
  detailUrl: string;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  pets: number;
}): Promise<RawObservation> {
  const result = await fetchPreReservationQuoteWithQuoteFetchLatency(input);
  return result.observation;
}

async function fetchPreReservationQuoteWithQuoteFetchLatency(input: {
  detailUrl: string;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  pets: number;
}): Promise<{ observation: RawObservation; quoteFetchElapsedMs: number }> {
  const origin = parseBaseOrigin(input.detailUrl);
  const queryParams = new URLSearchParams({
    action: "streamlinecore-api-request",
    params: JSON.stringify({
      methodName: "GetPreReservationPrice",
      params: {
        unit_id: Number(input.listingId),
        startdate: toUsDate(input.checkInIso),
        enddate: toUsDate(input.checkOutIso),
        occupants: input.adults,
        occupants_small: input.children,
        pets: input.pets,
      },
    }),
  });

  const endpoint = `${origin}/wp-admin/admin-ajax.php?${queryParams.toString()}`;
  const quoteStartedAt = performance.now();
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      accept: "application/json,text/plain,*/*",
      "user-agent": USER_AGENT,
      referer: input.detailUrl,
    },
  });
  let quoteFetchElapsedMs = performance.now() - quoteStartedAt;

  const handoffUrl = buildCheckoutUrl({
    detailUrl: input.detailUrl,
    listingId: input.listingId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: input.adults,
    children: input.children,
    pets: input.pets,
  });

  const availability = await verifyPropertyAvailability(input);
  if (!availability.available) {
    return {
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: false,
        quoteUnavailableReason: availability.reason || "Dates unavailable",
        baseTotal: null,
        taxesTotal: null,
        feesTotal: null,
        grandTotal: null,
        currency: "USD",
        handoffUrl,
        feeLines: [],
      },
      quoteFetchElapsedMs,
    };
  }

  if (!response.ok) {
    return {
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: false,
        quoteUnavailableReason: `Quote request failed with status ${response.status}`,
        baseTotal: null,
        taxesTotal: null,
        feesTotal: null,
        grandTotal: null,
        currency: "USD",
        handoffUrl,
        feeLines: [],
      },
      quoteFetchElapsedMs,
    };
  }

  const parseStartedAt = performance.now();
  const payload = (await response.json()) as StreamlinePreReservationResponse;
  quoteFetchElapsedMs += performance.now() - parseStartedAt;
  if (payload.status?.code) {
    return {
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: false,
        quoteUnavailableReason:
          payload.status.description?.trim() || payload.status.code,
        baseTotal: null,
        taxesTotal: null,
        feesTotal: null,
        grandTotal: null,
        currency: "USD",
        handoffUrl,
        feeLines: [],
      },
      quoteFetchElapsedMs,
    };
  }

  const data = payload.data;
  const baseTotalRaw = toFiniteNumber(data?.price);
  const nonBaseTotalRaw = toFiniteNumber(data?.taxes);
  const grandTotalRaw = toFiniteNumber(data?.total);

  const feeLines = Array.isArray(data?.required_fees)
    ? data.required_fees
        .map((line) => {
          const amount = toFiniteNumber(line.value);
          if (!line.name || amount === null || amount < 0) {
            return null;
          }
          return {
            name: line.name.trim() || "Required Fee",
            amount: roundCurrency(amount),
          };
        })
        .filter(
          (line): line is { name: string; amount: number } => line !== null,
        )
    : [];

  const taxesDetailTotal = Array.isArray(data?.taxes_details)
    ? roundCurrency(
        data.taxes_details.reduce((sum, line) => {
          const amount = toFiniteNumber(line.value);
          return sum + (amount !== null && amount > 0 ? amount : 0);
        }, 0),
      )
    : null;

  const feesTotal = feeLines.length
    ? roundCurrency(feeLines.reduce((sum, line) => sum + line.amount, 0))
    : null;

  const baseTotal =
    baseTotalRaw !== null && baseTotalRaw > 0
      ? roundCurrency(baseTotalRaw)
      : null;
  const grandTotal =
    grandTotalRaw !== null && grandTotalRaw > 0
      ? roundCurrency(grandTotalRaw)
      : null;

  let taxesTotal: number | null = taxesDetailTotal;
  if (taxesTotal === null && nonBaseTotalRaw !== null && feesTotal !== null) {
    taxesTotal = roundCurrency(Math.max(nonBaseTotalRaw - feesTotal, 0));
  }
  if (taxesTotal === null && nonBaseTotalRaw !== null && nonBaseTotalRaw > 0) {
    taxesTotal = roundCurrency(nonBaseTotalRaw);
  }

  return {
    observation: {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable:
        baseTotal !== null &&
        baseTotal > 0 &&
        grandTotal !== null &&
        grandTotal >= baseTotal,
      quoteUnavailableReason: null,
      baseTotal,
      taxesTotal,
      feesTotal,
      grandTotal,
      currency: data?.currency?.trim() || "USD",
      handoffUrl,
      feeLines,
    },
    quoteFetchElapsedMs,
  };
}

async function listDetailFiles(detailsJsonDir: string): Promise<string[]> {
  const entries = await readdir(detailsJsonDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
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
  const detailRaw = await readFile(input.detailPath, "utf8");
  const detail = JSON.parse(detailRaw) as DuneDetailRecord;

  const captureDateIso = input.capturedAtIso.slice(0, 10);
  const anchorDate = firstSaturdayOnOrAfter(captureDateIso);
  const quoteWindowDays = input.options.weeks * 7;
  const sampleStepDays = input.options.nights;
  const sampleCount = Math.max(1, Math.floor(quoteWindowDays / sampleStepDays));

  const sampleIndexes = Array.from(
    { length: sampleCount },
    (_, index) => index,
  );

  const rawObservations = await runWithConcurrency(
    sampleIndexes,
    input.options.quoteConcurrency,
    async (index) => {
      const startDate = addDays(anchorDate, index * sampleStepDays);
      const endDate = addDays(startDate, input.options.nights);

      return fetchPreReservationQuote({
        detailUrl: detail.detail_url,
        listingId: detail.external_listing_id,
        checkInIso: startDate,
        checkOutIso: endDate,
        adults: input.options.adults,
        children: input.options.children,
        pets: input.options.pets,
      });
    },
  );

  const baseNightlySeries: Array<number | null> = rawObservations.map((obs) =>
    obs.baseTotal !== null
      ? roundCurrency(obs.baseTotal / input.options.nights)
      : null,
  );
  const availableNightlies = baseNightlySeries.filter(
    (value): value is number => value !== null && value > 0,
  );
  const fallbackBaseNightly =
    median(availableNightlies) ?? GLOBAL_DEFAULT_BASE_NIGHTLY;

  const observedTaxPcts = rawObservations
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

  const observedFeePcts = rawObservations
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

  const fallbackTaxPct = median(observedTaxPcts) ?? DEFAULT_FALLBACK_TAX_PCT;
  const fallbackFeePct = median(observedFeePcts) ?? DEFAULT_FALLBACK_FEE_PCT;

  const observations: CanonicalQuoteObservation[] = rawObservations.map(
    (raw, index) => {
      const baseNightly =
        baseNightlySeries[index] ??
        interpolateValue(baseNightlySeries, index) ??
        fallbackBaseNightly;

      const baseTotal =
        raw.baseTotal !== null
          ? raw.baseTotal
          : roundCurrency(baseNightly * input.options.nights);

      const taxesTotal =
        raw.taxesTotal !== null
          ? raw.taxesTotal
          : roundCurrency(baseTotal * fallbackTaxPct);

      const feesTotal =
        raw.feesTotal !== null
          ? raw.feesTotal
          : roundCurrency(baseTotal * fallbackFeePct);

      const grandTotal =
        raw.grandTotal !== null
          ? raw.grandTotal
          : roundCurrency(baseTotal + taxesTotal + feesTotal);

      const allInNightly = roundCurrency(grandTotal / input.options.nights);

      return {
        sampled_at: input.capturedAtIso,
        captured_at: input.capturedAtIso,
        source_listing_id: detail.external_listing_id,
        currency: raw.currency || "USD",
        start_date: raw.startDate,
        end_date: raw.endDate,
        check_in_date: raw.startDate,
        check_out_date: raw.endDate,
        nights: input.options.nights,
        base_nightly: roundCurrency(baseNightly),
        all_in_nightly: allInNightly,
        quote_available: raw.quoteAvailable,
        quote_unavailable_reason: raw.quoteAvailable
          ? null
          : (raw.quoteUnavailableReason ??
            "Dates unavailable for selected stay window"),
        base_total: baseTotal,
        taxes_total: taxesTotal,
        fees_total_excl_taxes: feesTotal,
        fee_lines: raw.feeLines,
        grand_total: grandTotal,
        quoted_total: baseTotal,
        fee_pct_of_base: roundCurrency(feesTotal / Math.max(baseTotal, 1)),
        tax_pct_of_base: roundCurrency(taxesTotal / Math.max(baseTotal, 1)),
        non_base_pct_of_total: roundCurrency(
          (taxesTotal + feesTotal) / Math.max(baseTotal, 1),
        ),
        all_in_multiplier: roundCurrency(grandTotal / Math.max(baseTotal, 1)),
        handoff_url: raw.handoffUrl,
        source: "quote_api",
      };
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
    quote_window_days: quoteWindowDays,
    quote_sample_step_days: sampleStepDays,
    quote_nights: input.options.nights,
    quote_max_queries: observations.length,
    endpoint_path: "/wp-admin/admin-ajax.php",
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

export async function runDunevr30aQuoteCli(
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

  progress?.phase("starting dunevr30a quote sampling");
  progress?.info(
    `listings_selected=${selected.length} weeks=${options.weeks} nights=${options.nights} adults=${options.adults} children=${options.children} pets=${options.pets} quote_concurrency=${options.quoteConcurrency} listing_concurrency=${options.listingConcurrency}`,
  );

  const capturedAtIso = new Date().toISOString();
  const summaries: Array<{
    listingId: string;
    observations: number;
    availableQuotes: number;
  }> = await runWithConcurrency(
    selected,
    options.listingConcurrency,
    async (fileName) => {
      const summary = await buildSidecarForListing({
        detailPath: resolve(detailsJsonDir, fileName),
        quotesDir,
        options,
        capturedAtIso,
      });

      progress?.tick(
        `quoted listing=${summary.listingId} observations=${summary.observations} available=${summary.availableQuotes}`,
      );
      if (!progress) {
        console.log(
          `quoted listing=${summary.listingId} observations=${summary.observations} available=${summary.availableQuotes}`,
        );
      }
      return summary;
    },
  );

  console.log(`${ADAPTER_KEY} quote sidecar generation complete.`);
  console.log(`- listings: ${summaries.length}`);
  console.log(`- captured_at: ${capturedAtIso}`);
  console.log(
    `- listing_ids: ${summaries.map((item) => item.listingId).join(", ")}`,
  );

  progress?.success(
    `dunevr30a quote sampling complete listings=${summaries.length}`,
  );
}

export async function runDunevr30aSingleQuoteObservation(
  input: SingleQuoteObservationInput,
): Promise<SingleQuoteObservationResult> {
  const result = await fetchPreReservationQuoteWithQuoteFetchLatency({
    detailUrl: input.detailUrl,
    listingId: input.listingId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: Math.max(1, Math.floor(input.adults)),
    children: Math.max(0, Math.floor(input.children)),
    pets: 0,
  });
  const raw = result.observation;

  const feesTotalExclTaxes = raw.feesTotal;
  const quotedTotal = raw.grandTotal;
  const reason = raw.quoteAvailable
    ? null
    : (raw.quoteUnavailableReason ?? "Quote unavailable");

  return {
    elapsedMs: result.quoteFetchElapsedMs,
    observation: {
      startDate: raw.startDate,
      endDate: raw.endDate,
      quoteAvailable: raw.quoteAvailable,
      currency: raw.currency || null,
      baseTotal: raw.baseTotal,
      taxesTotal: raw.taxesTotal,
      feesTotalExclTaxes,
      grandTotal: raw.grandTotal,
      quotedTotal,
      handoffUrl: raw.handoffUrl,
      reason,
    },
  };
}
