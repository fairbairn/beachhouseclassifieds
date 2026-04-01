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
  quoteConcurrency: number;
  listingConcurrency: number;
};

type OceanReefDetailRecord = {
  external_listing_id: string;
  detail_url: string;
  h1?: string;
  normalized_matching_profile?: {
    name?: string;
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

const ADAPTER_KEY = "oceanreef30a" as const;
const BASE_HOST = "https://www.oceanreefresorts.com";
const PRICE_SUMMARY_ENDPOINT = `${BASE_HOST}/ajax/pricesummary/`;
const DEFAULT_LISTINGS = 10;
const DEFAULT_WEEKS = 24;
const DEFAULT_NIGHTS = 7;
const DEFAULT_ADULTS = 2;
const DEFAULT_CHILDREN = 0;
const DEFAULT_PETS = 0;
const DEFAULT_QUOTE_CONCURRENCY = 4;
const DEFAULT_LISTING_CONCURRENCY = 2;
const DEFAULT_RETRY_DELAYS_MS = [0, 1200, 3000, 6000];
const GLOBAL_DEFAULT_BASE_NIGHTLY = 650;
const DEFAULT_FALLBACK_TAX_PCT = 0.12;
const DEFAULT_FALLBACK_FEE_PCT = 0.03;
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
  let adults = DEFAULT_ADULTS;
  let children = DEFAULT_CHILDREN;
  let pets = DEFAULT_PETS;
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

function stripHtmlTags(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAmount(value: string): number | null {
  const parsed = Number(value.trim().replace(/,/g, ""));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return roundCurrency(parsed);
}

function parsePriceByLabel(html: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<li\\s+class=\"book-quote-item(?:\\s+[^\"]*)?\">[\\s\\S]*?<span\\s+class=\"book-quote-item-text\">\\s*${escaped}\\s*</span>[\\s\\S]*?<span\\s+class=\"book-quote-item-price\"[^>]*data-price=\"([^\"]+)\"`,
    "i",
  );
  const match = html.match(pattern);
  if (!match?.[1]) {
    return null;
  }
  return parseAmount(match[1]);
}

function parseFeeLines(html: string): Array<{ name: string; amount: number }> {
  const feeLines: Array<{ name: string; amount: number }> = [];
  const feeSectionMatch = html.match(
    /<ul\s+class=\"book-quote-item-toggle-list\">([\s\S]*?)<\/ul>/i,
  );
  if (!feeSectionMatch?.[1]) {
    return feeLines;
  }

  const itemPattern =
    /<span\s+class=\"book-quote-item-text\">\s*([^<]+?)\s*<\/span>[\s\S]*?<span\s+class=\"book-quote-item-price\"[^>]*data-price=\"([^\"]+)\"/gi;

  let match: RegExpExecArray | null = itemPattern.exec(feeSectionMatch[1]);
  while (match) {
    const name = stripHtmlTags(match[1] ?? "").trim();
    const amount = parseAmount(match[2] ?? "");
    if (name && amount !== null && amount >= 0) {
      feeLines.push({ name, amount });
    }
    match = itemPattern.exec(feeSectionMatch[1]);
  }

  return feeLines;
}

function parseUnavailableReason(html: string): string | null {
  const text = stripHtmlTags(html).toLowerCase();
  if (!text) {
    return "Empty quote response";
  }

  const knownSignals = [
    "not available",
    "dates unavailable",
    "unavailable",
    "no availability",
    "cannot be booked",
    "no rates",
    "available rate type was not found",
    "rate type was not found",
  ];

  for (const signal of knownSignals) {
    if (text.includes(signal)) {
      return "Dates unavailable for selected stay window";
    }
  }

  return null;
}

function buildFallbackHandoffUrl(input: {
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
}): string {
  const checkin = toUsDate(input.checkInIso);
  const checkout = toUsDate(input.checkOutIso);
  return `${BASE_HOST}/rentals/book-now?propertyID=${input.listingId}&checkin=${checkin}&checkout=${checkout}`;
}

function toFormBody(input: {
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  pets: number;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("propertyID", input.listingId);
  body.set("checkin", toUsDate(input.checkInIso));
  body.set("checkout", toUsDate(input.checkOutIso));
  body.set("adults", String(Math.max(1, input.adults)));
  body.set("children", String(Math.max(0, input.children)));
  body.set("pets", String(Math.max(0, input.pets)));
  body.set("leaseID", "");
  body.set("optInFees", "");
  body.set("optOutFees", "");
  body.set("customQuoteID", "");
  body.set("chargetemplateid", "");
  body.set("travelInsuranceID", "");
  body.set("promoCodeSubmitted", "0");
  body.set("promocode", "");
  return body;
}

function parseRetryDelaysMs(raw: string): number[] {
  const parsed = raw
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.floor(value));
  if (parsed.length >= 2) {
    return parsed;
  }
  return DEFAULT_RETRY_DELAYS_MS;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchQuoteHtml(input: {
  detailUrl: string;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  pets: number;
  reportProgress?: (message: string) => void;
}): Promise<RawObservation> {
  const fallbackHandoffUrl = buildFallbackHandoffUrl({
    listingId: input.listingId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
  });

  if (!/^\d+$/.test(input.listingId)) {
    return {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: false,
      quoteUnavailableReason: "Missing numeric propertyID on detail record",
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl: fallbackHandoffUrl,
      feeLines: [],
    };
  }

  const retryDelaysMs = parseRetryDelaysMs(
    process.env.OCEANREEF30A_QUOTE_RETRY_DELAYS_MS ?? "",
  );

  let lastFailureReason = "Quote request failed";

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    const delayMs = retryDelaysMs[attempt] ?? 0;
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      const response = await fetch(PRICE_SUMMARY_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "text/html, */*; q=0.01",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
          "user-agent": USER_AGENT,
          referer: input.detailUrl,
          origin: BASE_HOST,
        },
        body: toFormBody({
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          adults: input.adults,
          children: input.children,
          pets: input.pets,
        }),
      });

      if (!response.ok) {
        lastFailureReason = `Quote request failed with status ${response.status}`;
        if (attempt < retryDelaysMs.length - 1) {
          const nextDelayMs = retryDelaysMs[attempt + 1] ?? 0;
          input.reportProgress?.(
            `quote retry ${attempt + 1}/${retryDelaysMs.length} failed status=${response.status} next_delay_ms=${nextDelayMs}`,
          );
          continue;
        }
        break;
      }

      const html = await response.text();
      const reason = parseUnavailableReason(html);

      const baseTotal = parsePriceByLabel(html, "Rent");
      const taxesTotal = parsePriceByLabel(html, "Taxes");
      const feesTopline = parsePriceByLabel(html, "Fees");
      const grandTotal = parsePriceByLabel(html, "Total");
      const feeLines = parseFeeLines(html);
      const feeLinesTotal =
        feeLines.length > 0
          ? roundCurrency(feeLines.reduce((sum, line) => sum + line.amount, 0))
          : null;
      const feesTotal = feeLinesTotal ?? feesTopline;

      const quoteAvailable =
        reason === null &&
        baseTotal !== null &&
        baseTotal > 0 &&
        grandTotal !== null &&
        grandTotal >= baseTotal;

      if (
        !quoteAvailable &&
        reason === null &&
        attempt < retryDelaysMs.length - 1
      ) {
        lastFailureReason = "Quote response missing totals";
        const nextDelayMs = retryDelaysMs[attempt + 1] ?? 0;
        input.reportProgress?.(
          `quote retry ${attempt + 1}/${retryDelaysMs.length} missing totals next_delay_ms=${nextDelayMs}`,
        );
        continue;
      }

      return {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable,
        quoteUnavailableReason:
          quoteAvailable || reason === null
            ? null
            : "Dates unavailable for selected stay window",
        baseTotal,
        taxesTotal,
        feesTotal,
        grandTotal,
        currency: "USD",
        handoffUrl: fallbackHandoffUrl,
        feeLines,
      };
    } catch (error: unknown) {
      lastFailureReason =
        error instanceof Error ? error.message : "Quote request threw";
      if (attempt < retryDelaysMs.length - 1) {
        const nextDelayMs = retryDelaysMs[attempt + 1] ?? 0;
        input.reportProgress?.(
          `quote retry ${attempt + 1}/${retryDelaysMs.length} request_error=${lastFailureReason} next_delay_ms=${nextDelayMs}`,
        );
        continue;
      }
    }
  }

  return {
    startDate: input.checkInIso,
    endDate: input.checkOutIso,
    quoteAvailable: false,
    quoteUnavailableReason: lastFailureReason,
    baseTotal: null,
    taxesTotal: null,
    feesTotal: null,
    grandTotal: null,
    currency: "USD",
    handoffUrl: fallbackHandoffUrl,
    feeLines: [],
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
  progress?: QuoteProgress | null;
}): Promise<{
  listingId: string;
  observations: number;
  availableQuotes: number;
}> {
  const detailRaw = await readFile(input.detailPath, "utf8");
  const detail = JSON.parse(detailRaw) as OceanReefDetailRecord;

  const listingName =
    detail.h1?.trim() ||
    detail.normalized_matching_profile?.name?.trim() ||
    detail.external_listing_id;

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

      return fetchQuoteHtml({
        detailUrl: detail.detail_url,
        listingId: detail.external_listing_id,
        checkInIso: startDate,
        checkOutIso: endDate,
        adults: input.options.adults,
        children: input.options.children,
        pets: input.options.pets,
        reportProgress: (message) => {
          input.progress?.tick(
            `listing=${detail.external_listing_id} (${listingName}) window=${startDate}->${endDate} ${message}`,
          );
        },
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
        quoted_total: grandTotal,
        fee_pct_of_base: roundCurrency(feesTotal / Math.max(baseTotal, 1)),
        tax_pct_of_base: roundCurrency(taxesTotal / Math.max(baseTotal, 1)),
        non_base_pct_of_total: roundCurrency(
          (taxesTotal + feesTotal) / Math.max(grandTotal, 1),
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
    endpoint_path: "/ajax/pricesummary/",
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

export async function runOceanreef30aQuoteCli(
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

  progress?.phase("starting oceanreef30a quote sampling");
  progress?.info(
    `listings_selected=${selected.length} weeks=${options.weeks} nights=${options.nights} adults=${options.adults} children=${options.children} pets=${options.pets} quote_concurrency=${options.quoteConcurrency} listing_concurrency=${options.listingConcurrency}`,
  );

  const capturedAtIso = new Date().toISOString();
  const startedAtMs = Date.now();
  let completedListings = 0;

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
        progress,
      });

      completedListings += 1;
      const elapsedSeconds = (Date.now() - startedAtMs) / 1000;
      const elapsedMinutes = elapsedSeconds > 0 ? elapsedSeconds / 60 : 0;
      const throughput =
        elapsedMinutes > 0
          ? (completedListings / elapsedMinutes).toFixed(2)
          : "0.00";

      progress?.info(
        `adapter=${ADAPTER_KEY} ${completedListings}/${selected.length} listing=${summary.listingId} observations=${summary.observations} available=${summary.availableQuotes} elapsed_s=${elapsedSeconds.toFixed(1)} throughput_listings_per_min=${throughput}`,
      );

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
    `oceanreef30a quote sampling complete listings=${summaries.length}`,
  );
}
