import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
  pets: number;
  promoCode: string;
  quoteConcurrency: number;
  listingConcurrency: number;
};

type ExclusiveDetailRecord = {
  external_listing_id: string;
  detail_url: string;
};

type ExclusiveFeeLine = {
  name?: unknown;
  value?: unknown;
};

type ExclusiveQuoteBody = {
  result?: unknown;
  nightlyRates?: unknown;
  guestDiscountedRent?: unknown;
  otherChargesTotal?: unknown;
  otherChargesItemized?: unknown;
  serviceFeeTotal?: unknown;
  taxes?: unknown;
  grandTotal?: unknown;
  bookingURL?: unknown;
  cid?: unknown;
  message?: unknown;
  errors?: unknown;
  promoCode?: unknown;
};

type ExclusiveQuoteResponse = {
  body?: ExclusiveQuoteBody;
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

const ADAPTER_KEY = "exclusive30a" as const;
const BASE_HOST = "https://www.exclusive30a.com";
const QUOTE_ENDPOINT = `${BASE_HOST}/quote`;
const DEFAULT_LISTINGS = 10;
const DEFAULT_WEEKS = 24;
const DEFAULT_NIGHTS = 7;
const DEFAULT_QUOTE_CONCURRENCY = 4;
const DEFAULT_LISTING_CONCURRENCY = 2;
const DEFAULT_BASE_NIGHTLY_FALLBACK = 700;
const DEFAULT_FALLBACK_TAX_PCT = 0.12;
const DEFAULT_FALLBACK_FEE_PCT = 0.24;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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
  let promoCode = "";
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

    if (arg === "--promo-code" && value) {
      promoCode = value.trim();
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
    promoCode,
    quoteConcurrency,
    listingConcurrency,
  };
}

function parseCurrencyLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return roundCurrency(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.-]/g, "").trim());
    if (Number.isFinite(parsed)) {
      return roundCurrency(parsed);
    }
  }

  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseUnavailableReason(value: unknown): string | null {
  if (typeof value === "string") {
    const cleaned = stripHtml(value);
    return cleaned.length > 0 ? cleaned : null;
  }

  if (Array.isArray(value)) {
    const cleaned = value
      .map((entry) => (typeof entry === "string" ? stripHtml(entry) : ""))
      .filter((entry) => entry.length > 0)
      .join(" ")
      .trim();
    return cleaned.length > 0 ? cleaned : null;
  }

  return null;
}

function parseFeeLines(
  body: ExclusiveQuoteBody,
): Array<{ name: string; amount: number }> {
  const lines: Array<{ name: string; amount: number }> = [];

  const itemized = body.otherChargesItemized;
  if (Array.isArray(itemized)) {
    for (const rawLine of itemized) {
      if (!rawLine || typeof rawLine !== "object") {
        continue;
      }
      const line = rawLine as ExclusiveFeeLine;
      const name = asString(line.name).trim() || "Fee";
      const amount = parseCurrencyLike(line.value);
      if (amount === null || amount < 0) {
        continue;
      }
      lines.push({ name, amount });
    }
  }

  const serviceFee = parseCurrencyLike(body.serviceFeeTotal);
  if (serviceFee !== null && serviceFee > 0) {
    lines.push({ name: "Service Fee", amount: serviceFee });
  }

  return lines;
}

function buildFallbackHandoffUrl(input: {
  startDate: string;
  endDate: string;
  listingId: string;
  adults: number;
  promoCode: string;
  cid: string;
  nights: number;
}): string {
  const params = new URLSearchParams();
  params.set("arrival", input.startDate);
  params.set("departure", input.endDate);
  params.set("pid", input.listingId);
  params.set("numberOfAdult", String(Math.max(1, input.adults)));
  params.set("promoCode", input.promoCode);
  params.set("cid", input.cid);
  params.set("nights", String(input.nights));
  return `${BASE_HOST}/booking/review?${params.toString()}`;
}

async function fetchQuote(input: {
  detailUrl: string;
  listingId: string;
  startDate: string;
  endDate: string;
  nights: number;
  adults: number;
  children: number;
  pets: number;
  promoCode: string;
}): Promise<RawObservation> {
  const params = new URLSearchParams();
  params.set("arrival", input.startDate);
  params.set("departure", input.endDate);
  params.set("pid", input.listingId);
  params.set("numberOfAdult", String(Math.max(1, input.adults)));
  params.set("numberOfChild", String(Math.max(0, input.children)));
  params.set("numberOfPets", String(Math.max(0, input.pets)));
  params.set("travelInsurance", "");
  params.set("nights", String(input.nights));
  params.set("promoCode", input.promoCode);

  const fallbackHandoffUrl = buildFallbackHandoffUrl({
    startDate: input.startDate,
    endDate: input.endDate,
    listingId: input.listingId,
    adults: input.adults,
    promoCode: input.promoCode,
    cid: "",
    nights: input.nights,
  });

  const response = await fetch(`${QUOTE_ENDPOINT}?${params.toString()}`, {
    method: "GET",
    headers: {
      accept: "application/json, text/javascript, */*; q=0.01",
      "x-requested-with": "XMLHttpRequest",
      "user-agent": USER_AGENT,
      referer: input.detailUrl,
    },
  });

  if (!response.ok) {
    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable: false,
      quoteUnavailableReason: `Quote request failed with status ${response.status}`,
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl: fallbackHandoffUrl,
      feeLines: [],
    };
  }

  let parsed: ExclusiveQuoteResponse;
  try {
    parsed = (await response.json()) as ExclusiveQuoteResponse;
  } catch {
    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable: false,
      quoteUnavailableReason: "Quote endpoint returned invalid JSON",
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl: fallbackHandoffUrl,
      feeLines: [],
    };
  }

  const body = parsed.body ?? {};
  const result = asString(body.result).toLowerCase();
  const feeLines = parseFeeLines(body);

  const baseTotal =
    parseCurrencyLike(body.guestDiscountedRent) ??
    parseCurrencyLike(body.nightlyRates);
  const taxesTotal = parseCurrencyLike(body.taxes);
  const feeLinesTotal = roundCurrency(
    feeLines.reduce((sum, line) => sum + line.amount, 0),
  );
  const feesTotal =
    parseCurrencyLike(body.otherChargesTotal) ??
    (feeLines.length > 0 ? feeLinesTotal : null);
  const grandTotal = parseCurrencyLike(body.grandTotal);

  const cidRaw = body.cid;
  const cid =
    typeof cidRaw === "string" || typeof cidRaw === "number"
      ? String(cidRaw)
      : "";
  const handoffUrl =
    asString(body.bookingURL).trim() ||
    buildFallbackHandoffUrl({
      startDate: input.startDate,
      endDate: input.endDate,
      listingId: input.listingId,
      adults: input.adults,
      promoCode: asString(body.promoCode).trim() || input.promoCode,
      cid,
      nights: input.nights,
    });

  if (result !== "success") {
    const reason =
      parseUnavailableReason(body.errors) ??
      parseUnavailableReason(body.message) ??
      "Dates unavailable for selected stay window";

    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable: false,
      quoteUnavailableReason: reason,
      baseTotal,
      taxesTotal,
      feesTotal,
      grandTotal,
      currency: "USD",
      handoffUrl,
      feeLines,
    };
  }

  return {
    startDate: input.startDate,
    endDate: input.endDate,
    quoteAvailable:
      baseTotal !== null &&
      baseTotal > 0 &&
      grandTotal !== null &&
      grandTotal > 0,
    quoteUnavailableReason: null,
    baseTotal,
    taxesTotal,
    feesTotal,
    grandTotal,
    currency: "USD",
    handoffUrl,
    feeLines,
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
  const detail = JSON.parse(detailRaw) as ExclusiveDetailRecord;

  const captureDateIso = input.capturedAtIso.slice(0, 10);
  const anchorDate = firstSaturdayOnOrAfter(captureDateIso);

  const sampleIndexes = Array.from(
    { length: input.options.weeks },
    (_, index) => index,
  );

  const rawObservations = await runWithConcurrency(
    sampleIndexes,
    input.options.quoteConcurrency,
    async (index) => {
      const startDate = addDays(anchorDate, index * 7);
      const endDate = addDays(startDate, input.options.nights);

      return fetchQuote({
        detailUrl: detail.detail_url,
        listingId: detail.external_listing_id,
        startDate,
        endDate,
        nights: input.options.nights,
        adults: input.options.adults,
        children: input.options.children,
        pets: input.options.pets,
        promoCode: input.options.promoCode,
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
    median(availableNightlies) ?? DEFAULT_BASE_NIGHTLY_FALLBACK;

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
    quote_window_days: input.options.weeks * 7,
    quote_sample_step_days: 7,
    quote_nights: input.options.nights,
    quote_max_queries: observations.length,
    endpoint_path: "/quote",
    quote_coupon: input.options.promoCode || undefined,
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

export async function runExclusive30aQuoteCli(
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

  progress?.phase("starting exclusive30a quote sampling");
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
    `exclusive30a quote sampling complete listings=${summaries.length}`,
  );
}
