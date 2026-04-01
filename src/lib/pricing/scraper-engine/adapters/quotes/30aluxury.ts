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
  quoteConcurrency: number;
  listingConcurrency: number;
};

type ThirtyALuxuryDetailRecord = {
  external_listing_id: string;
  detail_url: string;
};

type RcapiPriceNode = {
  p?: string;
  c?: string;
  qp?: {
    rcav?: {
      begin?: string;
      end?: string;
      adult?: string;
      child?: string;
      eid?: string;
      IDs?: Record<string, string[]>;
    };
    eid?: number;
  };
};

type RcapiResult = {
  prices?: RcapiPriceNode[];
};

type DetailedQuoteResponse = {
  status?: unknown;
  content?: unknown;
  message?: unknown;
};

type ParsedLineItem = {
  name: string;
  amount: number;
  optional: boolean;
};

type ParsedDetailedQuote = {
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotal: number | null;
  grandTotal: number | null;
  feeLines: Array<{ name: string; amount: number }>;
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
  quotedTotal: number | null;
  currency: string;
  handoffUrl: string;
  feeLines: Array<{ name: string; amount: number }>;
};

const ADAPTER_KEY = "30aluxury" as const;
const BASE_HOST = "https://www.30aluxuryvacations.com";
const RCAPI_ENDPOINT = `${BASE_HOST}/rcapi/item/avail/search`;
const DETAILED_QUOTE_ENDPOINT = `${BASE_HOST}/rescms/ajax/item/pricing/quote`;
const DEFAULT_LISTINGS = 10;
const DEFAULT_WEEKS = 24;
const DEFAULT_NIGHTS = 7;
const DEFAULT_QUOTE_CONCURRENCY = 4;
const DEFAULT_LISTING_CONCURRENCY = 2;
const GLOBAL_DEFAULT_BASE_NIGHTLY = 700;
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function stripHtmlToText(value: string): string {
  return decodeBasicHtmlEntities(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseClassSummaryAmount(
  html: string,
  className: "sub-total" | "tax" | "total",
): number | null {
  const escapedClass = className.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const regex = new RegExp(
    `<tr[^>]*class="${escapedClass}[^"]*"[^>]*>\\s*<th>[^<]+<\\/th>\\s*<td class="amount">\\s*(?:<b>)?\\$([0-9,]+\\.[0-9]{2})(?:<\\/b>)?\\s*<\\/td>`,
    "i",
  );
  const match = html.match(regex);
  if (!match?.[1]) {
    return null;
  }
  return parseMoney(match[1]);
}

function parseDetailedQuoteContent(contentHtml: string): ParsedDetailedQuote {
  const lineItems: ParsedLineItem[] = [];
  const rowRegex =
    /<tr[^>]*class="line-item[^"]*"[^>]*>\s*<td>([\s\S]*?)<\/td>\s*<td class="amount">\$([0-9,]+\.[0-9]{2})<\/td>/gi;

  for (const match of contentHtml.matchAll(rowRegex)) {
    const name = stripHtmlToText(match[1] ?? "");
    const amount = parseMoney(match[2]);
    if (!name || amount === null) {
      continue;
    }
    lineItems.push({
      name,
      amount,
      optional: /\(optional\)/i.test(name),
    });
  }

  const lodgingLine =
    lineItems.find((item) => /^lodging\s*:/i.test(item.name)) ?? null;
  const includedFeeLines = lineItems
    .filter((item) => !/^lodging\s*:/i.test(item.name) && !item.optional)
    .map((item) => ({ name: item.name, amount: item.amount }));

  const subTotal = parseClassSummaryAmount(contentHtml, "sub-total");
  const taxesTotal = parseClassSummaryAmount(contentHtml, "tax");
  const total = parseClassSummaryAmount(contentHtml, "total");

  const baseTotal = lodgingLine?.amount ?? null;
  const feesFromLines = includedFeeLines.reduce(
    (sum, item) => sum + item.amount,
    0,
  );
  const feesTotal =
    subTotal !== null && baseTotal !== null
      ? roundCurrency(Math.max(0, subTotal - baseTotal))
      : roundCurrency(feesFromLines);

  return {
    baseTotal,
    taxesTotal,
    feesTotal,
    grandTotal: total,
    feeLines: includedFeeLines,
  };
}

function parseArgs(argv: string[]): CliOptions {
  let maxListings = DEFAULT_LISTINGS;
  let listingId: string | null = null;
  let weeks = DEFAULT_WEEKS;
  let nights = DEFAULT_NIGHTS;
  let adults = 1;
  let children = 0;
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
    quoteConcurrency,
    listingConcurrency,
  };
}

function parseEntityIdFromHtml(html: string): number | null {
  const patterns = [
    /['"]eid['"]\s*:\s*['"](\d+)['"]/i,
    /\brc-eid-(\d+)\b/i,
    /\bitem_id:(\d+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function parseIdsTuple(html: string): string | null {
  const patterns = [
    /['"]id['"]\s*:\s*['"](\d+-\d+)['"]/i,
    /\brcav%5BIDs%5D%5B\d+%5D%5B%5D=(\d+-\d+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function parseRcType(html: string): string {
  const match = html.match(/['"]type['"]\s*:\s*['"](\d+)['"]/i);
  if (match?.[1]) {
    return match[1].trim();
  }
  return "8";
}

function buildCheckoutUrlFromQuoteNode(
  fallback: {
    entityId: number;
    checkInIso: string;
    checkOutIso: string;
    adults: number;
    children: number;
    idsTuple: string;
    rcType: string;
  },
  quoteNode: RcapiPriceNode | null,
): string {
  const rcav = quoteNode?.qp?.rcav;
  const begin = rcav?.begin?.trim() || toUsDate(fallback.checkInIso);
  const end = rcav?.end?.trim() || toUsDate(fallback.checkOutIso);
  const adult = rcav?.adult?.trim() || String(fallback.adults);
  const child = rcav?.child?.trim() || String(fallback.children);
  const eid =
    rcav?.eid?.trim() || String(quoteNode?.qp?.eid ?? fallback.entityId);

  let idsKey = fallback.rcType;
  let idsValue = fallback.idsTuple;
  const ids = rcav?.IDs;
  if (ids && typeof ids === "object") {
    const first = Object.entries(ids).find(
      (entry) => Array.isArray(entry[1]) && entry[1].length > 0,
    );
    if (first?.[0] && first[1]?.[0]) {
      idsKey = first[0];
      idsValue = first[1][0]!.trim();
    }
  }

  const params = new URLSearchParams();
  params.set("rcav[begin]", begin);
  params.set("rcav[end]", end);
  params.set("rcav[adult]", adult);
  params.set("rcav[child]", child);
  params.set("rcav[eid]", eid);
  params.set("rcav[coupon]", "");
  params.set(`rcav[IDs][${idsKey}][0]`, idsValue);
  params.set("eid", eid);
  return `${BASE_HOST}/rescms/item/${eid}/buy?${params.toString()}`;
}

async function fetchRcapiQuote(input: {
  detailUrl: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  entityId: number;
}): Promise<{
  quoteAvailable: boolean;
  baseTotal: number | null;
  currency: string;
  quoteNode: RcapiPriceNode | null;
}> {
  const params = new URLSearchParams();
  params.set("rcav[begin]", toUsDate(input.checkInIso));
  params.set("rcav[end]", toUsDate(input.checkOutIso));
  params.set("rcav[adult]", String(input.adults));
  params.set("rcav[child]", String(input.children));
  params.set("rcav[eid]", String(input.entityId));
  params.set("rcav[flex]", "");
  params.set("rcav[flex_type]", "d");

  const response = await fetch(`${RCAPI_ENDPOINT}?${params.toString()}`, {
    headers: {
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
      "user-agent": USER_AGENT,
      referer: input.detailUrl,
    },
  });

  if (!response.ok) {
    return {
      quoteAvailable: false,
      baseTotal: null,
      currency: "USD",
      quoteNode: null,
    };
  }

  const payload = (await response.json()) as unknown;
  const rows = Array.isArray(payload) ? (payload as RcapiResult[]) : [];
  const priceNode = rows[0]?.prices?.[0] ?? null;
  const baseTotalRaw = Number(priceNode?.p ?? "");
  const baseTotal =
    Number.isFinite(baseTotalRaw) && baseTotalRaw > 0
      ? roundCurrency(baseTotalRaw)
      : null;

  return {
    quoteAvailable: baseTotal !== null,
    baseTotal,
    currency: priceNode?.c?.trim() || "USD",
    quoteNode: priceNode,
  };
}

async function fetchDetailedQuote(input: {
  detailUrl: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  entityId: number;
  idsTuple: string;
  rcType: string;
}): Promise<{ parsed: ParsedDetailedQuote | null; reason: string | null }> {
  const query = new URLSearchParams();
  query.set("rcav[begin]", toUsDate(input.checkInIso));
  query.set("rcav[end]", toUsDate(input.checkOutIso));
  query.set("rcav[adult]", String(Math.max(1, input.adults)));
  query.set("rcav[child]", String(Math.max(0, input.children)));
  query.set("rcav[eid]", String(input.entityId));
  query.set("rcav[coupon]", "");
  query.set(`rcav[IDs][${input.rcType}][]`, input.idsTuple);
  query.set("eid", String(input.entityId));
  query.set("buy_text", "Book Now");

  const response = await fetch(
    `${DETAILED_QUOTE_ENDPOINT}?${query.toString()}`,
    {
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": USER_AGENT,
        referer: input.detailUrl,
        origin: BASE_HOST,
      },
    },
  );

  if (!response.ok) {
    return {
      parsed: null,
      reason: `Detailed quote HTTP ${response.status}`,
    };
  }

  const payload = (await response.json()) as DetailedQuoteResponse;
  const status =
    typeof payload.status === "number"
      ? payload.status
      : Number(payload.status);
  const content = typeof payload.content === "string" ? payload.content : "";
  const message = asString(payload.message);

  if (!Number.isFinite(status) || status !== 1 || content.length === 0) {
    return {
      parsed: null,
      reason: message ?? "Detailed quote endpoint returned no pricing content",
    };
  }

  return {
    parsed: parseDetailedQuoteContent(content),
    reason: null,
  };
}

async function fetchQuoteWithTotals(input: {
  detailUrl: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  entityId: number;
  idsTuple: string;
  rcType: string;
}): Promise<RawObservation> {
  const base = await fetchRcapiQuote(input);
  const handoffUrl = buildCheckoutUrlFromQuoteNode(
    {
      entityId: input.entityId,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      adults: input.adults,
      children: input.children,
      idsTuple: input.idsTuple,
      rcType: input.rcType,
    },
    base.quoteNode,
  );

  if (!base.quoteAvailable || base.baseTotal === null) {
    return {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: false,
      quoteUnavailableReason: "Dates unavailable for selected stay window",
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      quotedTotal: null,
      currency: base.currency,
      handoffUrl,
      feeLines: [],
    };
  }

  const detailed = await fetchDetailedQuote(input);
  if (!detailed.parsed) {
    return {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: false,
      quoteUnavailableReason:
        detailed.reason ??
        "Detailed quote unavailable for selected stay window",
      baseTotal: base.baseTotal,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      quotedTotal: base.baseTotal,
      currency: base.currency,
      handoffUrl,
      feeLines: [],
    };
  }

  const resolvedBase = detailed.parsed.baseTotal ?? base.baseTotal;
  const resolvedTaxes = detailed.parsed.taxesTotal ?? 0;
  const resolvedFees =
    detailed.parsed.feesTotal ??
    roundCurrency(
      Math.max(
        0,
        (detailed.parsed.grandTotal ?? resolvedBase) -
          resolvedBase -
          resolvedTaxes,
      ),
    );
  const resolvedGrand =
    detailed.parsed.grandTotal ??
    roundCurrency(resolvedBase + resolvedTaxes + resolvedFees);

  return {
    startDate: input.checkInIso,
    endDate: input.checkOutIso,
    quoteAvailable: true,
    quoteUnavailableReason: null,
    baseTotal: resolvedBase,
    taxesTotal: resolvedTaxes,
    feesTotal: resolvedFees,
    grandTotal: resolvedGrand,
    quotedTotal: resolvedGrand,
    currency: base.currency,
    handoffUrl,
    feeLines: detailed.parsed.feeLines,
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
  htmlPath: string;
  quotesDir: string;
  options: CliOptions;
  capturedAtIso: string;
}): Promise<{
  listingId: string;
  observations: number;
  availableQuotes: number;
}> {
  const detailRaw = await readFile(input.detailPath, "utf8");
  const detail = JSON.parse(detailRaw) as ThirtyALuxuryDetailRecord;
  const htmlRaw = await readFile(input.htmlPath, "utf8");

  const entityId = parseEntityIdFromHtml(htmlRaw);
  const idsTuple = parseIdsTuple(htmlRaw);
  const rcType = parseRcType(htmlRaw);
  if (!entityId || !idsTuple) {
    throw new Error(
      `Missing quote identifiers for listing ${detail.external_listing_id}`,
    );
  }

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

      return fetchQuoteWithTotals({
        detailUrl: detail.detail_url,
        checkInIso: startDate,
        checkOutIso: endDate,
        adults: input.options.adults,
        children: input.options.children,
        entityId,
        idsTuple,
        rcType,
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
    median(availableNightlies) ?? GLOBAL_DEFAULT_BASE_NIGHTLY;

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

  const fallbackTaxRate = median(observedTaxRates) ?? 0.12;
  const fallbackFeeRate = median(observedFeeRates) ?? 0;

  const observations: CanonicalQuoteObservation[] = rawObservations.map(
    (raw, index) => {
      const baseNightly =
        baseNightlySeries[index] ??
        interpolateValue(baseNightlySeries, index) ??
        fallbackBaseNightly;

      const baseTotal =
        raw.baseTotal !== null && raw.baseTotal > 0
          ? raw.baseTotal
          : roundCurrency(baseNightly * input.options.nights);

      const taxesTotal =
        raw.taxesTotal !== null && raw.taxesTotal >= 0
          ? raw.taxesTotal
          : roundCurrency(baseTotal * fallbackTaxRate);

      const feesTotal =
        raw.feesTotal !== null && raw.feesTotal >= 0
          ? raw.feesTotal
          : roundCurrency(baseTotal * fallbackFeeRate);

      const grandTotal =
        raw.grandTotal !== null && raw.grandTotal > 0
          ? raw.grandTotal
          : roundCurrency(baseTotal + taxesTotal + feesTotal);

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
        all_in_nightly: roundCurrency(grandTotal / input.options.nights),
        quote_available: raw.quoteAvailable,
        quote_unavailable_reason: raw.quoteAvailable
          ? null
          : (raw.quoteUnavailableReason ??
            "Detailed quote unavailable for selected stay window"),
        base_total: baseTotal,
        taxes_total: taxesTotal,
        fees_total_excl_taxes: feesTotal,
        fee_lines: raw.feeLines,
        grand_total: grandTotal,
        quoted_total: raw.quotedTotal ?? grandTotal,
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
    endpoint_path: "/rescms/ajax/item/pricing/quote",
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

export async function runThirtyALuxuryQuoteCli(
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
  const detailsHtmlDir = resolve(adapterRoot, "details", "html");
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

  progress?.phase("starting 30aluxury quote sampling");
  progress?.info(
    `listings_selected=${selected.length} weeks=${options.weeks} nights=${options.nights} quote_concurrency=${options.quoteConcurrency} listing_concurrency=${options.listingConcurrency}`,
  );

  const capturedAtIso = new Date().toISOString();
  const summaries = await runWithConcurrency(
    selected,
    options.listingConcurrency,
    async (fileName) => {
      const listingId = fileName.replace(/\.json$/i, "");
      const summary = await buildSidecarForListing({
        detailPath: resolve(detailsJsonDir, fileName),
        htmlPath: resolve(detailsHtmlDir, `${listingId}.html`),
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
    `30aluxury quote sampling complete listings=${summaries.length}`,
  );
}
