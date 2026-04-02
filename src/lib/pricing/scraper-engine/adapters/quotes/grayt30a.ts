import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
  promoCode: string;
  quoteConcurrency: number;
  listingConcurrency: number;
  skipExisting: boolean;
};

type Grayt30ADetailRecord = {
  external_listing_id: string;
  detail_url: string;
  description_expanded?: string;
  property_profile?: {
    unit_id?: string;
  };
};

type RcapiPriceEntry = {
  p?: unknown;
  c?: unknown;
};

type RcapiSearchResult = {
  prices?: unknown;
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
  currency: string;
  handoffUrl: string;
  feeLines: Array<{ name: string; amount: number }>;
};

const ADAPTER_KEY = "grayt30a" as const;
const BASE_HOST = "https://www.grayt30avacations.com";
const RCAPI_ENDPOINT = `${BASE_HOST}/rcapi/item/avail/search`;
const DETAILED_QUOTE_ENDPOINT = `${BASE_HOST}/rescms/ajax/item/pricing/quote`;
const DEFAULT_LISTINGS = 10;
const DEFAULT_WEEKS = 24;
const DEFAULT_NIGHTS = 7;
const DEFAULT_QUOTE_CONCURRENCY = 2;
const DEFAULT_LISTING_CONCURRENCY = 1;
const MAX_QUOTE_CONCURRENCY = 2;
const MAX_LISTING_CONCURRENCY = 1;
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 900;
const DEFAULT_BASE_NIGHTLY_FALLBACK = 700;
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

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  const month = match[2];
  const day = match[3];
  return `${month}/${day}/${match[1]}`;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function isRateLimitedMessage(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.toLowerCase();
  return (
    normalized.includes("too many requests") ||
    normalized.includes("rate limit") ||
    normalized.includes("throttle")
  );
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function buildHandoffUrl(input: {
  itemEid: string;
  typeId: string;
  inventoryId: string;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
  promoCode: string;
}): string {
  const params = new URLSearchParams();
  params.set("rcav[begin]", toUsDate(input.startDate));
  params.set("rcav[end]", toUsDate(input.endDate));
  params.set("rcav[adult]", String(Math.max(1, input.adults)));
  params.set("rcav[child]", String(Math.max(0, input.children)));
  params.set("rcav[eid]", input.itemEid);
  params.set("rcav[coupon]", input.promoCode);
  params.set(`rcav[IDs][${input.typeId}][0]`, input.inventoryId);
  return `${BASE_HOST}/rescms/item/${input.itemEid}/buy?${params.toString()}`;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractRcavIdentity(input: {
  listingId: string;
  descriptionExpanded: string;
  detailHtml: string;
}): {
  itemEid: string;
  typeId: string;
  inventoryId: string;
} {
  const source = `${input.detailHtml}\n${input.descriptionExpanded}`;
  const decodedSource = safeDecodeURIComponent(source);

  const rcavIdPattern = /rcav\[IDs\]\[(\d+)\]\[(?:0)?\]=(\d+)/i;
  const encodedRcavIdPattern = /rcav%5BIDs%5D%5B(\d+)%5D%5B(?:0)?%5D=(\d+)/i;
  const rcavEidPattern = /rcav\[eid\]=(\d+)/i;
  const encodedRcavEidPattern = /rcav%5Beid%5D=(\d+)/i;

  const decodedIdMatch = decodedSource.match(rcavIdPattern);
  const encodedIdMatch = source.match(encodedRcavIdPattern);
  const typeId = decodedIdMatch?.[1] ?? encodedIdMatch?.[1] ?? null;
  const inventoryId = decodedIdMatch?.[2] ?? encodedIdMatch?.[2] ?? null;

  const decodedEidMatch = decodedSource.match(rcavEidPattern);
  const encodedEidMatch = source.match(encodedRcavEidPattern);
  const itemEid = decodedEidMatch?.[1] ?? encodedEidMatch?.[1] ?? null;

  if (itemEid && typeId && inventoryId) {
    return {
      itemEid,
      typeId,
      inventoryId,
    };
  }

  const exactEntityMatch = source.match(
    /'entity':\{'eid':'(\d+)'.*?'id':'(\d+)'.*?'type':'(\d+)'/s,
  );
  if (exactEntityMatch) {
    return {
      itemEid: exactEntityMatch[1],
      inventoryId: exactEntityMatch[2],
      typeId: exactEntityMatch[3],
    };
  }

  const fallbackMatch = source.match(
    /'eid':'(\d+)','engine_eid':'\d+','id':'(\d+)'.*?'type':'(\d+)'/s,
  );
  if (fallbackMatch) {
    return {
      itemEid: fallbackMatch[1],
      inventoryId: fallbackMatch[2],
      typeId: fallbackMatch[3],
    };
  }

  throw new Error(
    `Missing rcav identity fields for listing ${input.listingId}`,
  );
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listDetailFiles(detailsJsonDir: string): Promise<string[]> {
  const entries = await readdir(detailsJsonDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function fetchRcapiQuote(input: {
  detailUrl: string;
  itemEid: string;
  typeId: string;
  inventoryId: string;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
  promoCode: string;
}): Promise<RawObservation> {
  const query = new URLSearchParams();
  query.set("rcav[begin]", toUsDate(input.startDate));
  query.set("rcav[end]", toUsDate(input.endDate));
  query.set("rcav[adult]", String(Math.max(1, input.adults)));
  query.set("rcav[child]", String(Math.max(0, input.children)));
  query.set("rcav[eid]", input.itemEid);
  query.set("rcav[coupon]", input.promoCode);
  query.set(`rcav[IDs][${input.typeId}][0]`, input.inventoryId);

  const defaultUnavailable: RawObservation = {
    startDate: input.startDate,
    endDate: input.endDate,
    quoteAvailable: false,
    quoteUnavailableReason: "RCAPI response unavailable",
    baseTotal: null,
    taxesTotal: null,
    feesTotal: null,
    grandTotal: null,
    currency: "USD",
    handoffUrl: buildHandoffUrl({
      itemEid: input.itemEid,
      typeId: input.typeId,
      inventoryId: input.inventoryId,
      startDate: input.startDate,
      endDate: input.endDate,
      adults: input.adults,
      children: input.children,
      promoCode: input.promoCode,
    }),
    feeLines: [],
  };

  let lastRateLimitReason: string | null = null;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const response = await fetch(`${RCAPI_ENDPOINT}?${query.toString()}`, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": USER_AGENT,
        referer: input.detailUrl,
        origin: BASE_HOST,
      },
    });

    if (!response.ok) {
      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        lastRateLimitReason = `RCAPI HTTP ${response.status}`;
        await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
        continue;
      }

      return {
        ...defaultUnavailable,
        quoteUnavailableReason: `RCAPI HTTP ${response.status}`,
      };
    }

    let rawPayload: unknown;
    try {
      rawPayload = await response.json();
    } catch {
      return {
        ...defaultUnavailable,
        quoteUnavailableReason: "RCAPI returned invalid JSON",
      };
    }

    if (!Array.isArray(rawPayload)) {
      return {
        ...defaultUnavailable,
        quoteUnavailableReason: "RCAPI response shape was not an array",
      };
    }

    const firstEntry = rawPayload[0] as RcapiSearchResult | undefined;
    const prices = Array.isArray(firstEntry?.prices)
      ? (firstEntry.prices as RcapiPriceEntry[])
      : [];

    const firstPrice = prices[0];
    const baseTotal = parseMoney(firstPrice?.p);
    const currency = asString(firstPrice?.c) ?? "USD";

    if (baseTotal === null || baseTotal <= 0) {
      return {
        ...defaultUnavailable,
        quoteUnavailableReason: "No prices returned for selected stay window",
        currency,
      };
    }

    return {
      ...defaultUnavailable,
      quoteAvailable: true,
      quoteUnavailableReason: null,
      baseTotal,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency,
    };
  }

  return {
    ...defaultUnavailable,
    quoteUnavailableReason: lastRateLimitReason ?? "Too many requests",
  };
}

async function fetchDetailedQuote(input: {
  detailUrl: string;
  itemEid: string;
  typeId: string;
  inventoryId: string;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
  promoCode: string;
}): Promise<{
  parsed: ParsedDetailedQuote | null;
  unavailableReason: string | null;
}> {
  const query = new URLSearchParams();
  query.set("rcav[begin]", toUsDate(input.startDate));
  query.set("rcav[end]", toUsDate(input.endDate));
  query.set("rcav[adult]", String(Math.max(1, input.adults)));
  query.set("rcav[child]", String(Math.max(0, input.children)));
  query.set("rcav[eid]", input.itemEid);
  query.set("rcav[coupon]", input.promoCode);
  query.set(`rcav[IDs][${input.typeId}][]`, input.inventoryId);
  query.set("eid", input.itemEid);
  query.set("buy_text", "Book Now");

  let lastRateLimitReason: string | null = null;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const response = await fetch(
      `${DETAILED_QUOTE_ENDPOINT}?${query.toString()}`,
      {
        method: "GET",
        headers: {
          accept: "application/json, text/plain, */*",
          "user-agent": USER_AGENT,
          referer: input.detailUrl,
          origin: BASE_HOST,
        },
      },
    );

    if (!response.ok) {
      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        lastRateLimitReason = `Detailed quote HTTP ${response.status}`;
        await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
        continue;
      }
      return {
        parsed: null,
        unavailableReason: `Detailed quote HTTP ${response.status}`,
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        parsed: null,
        unavailableReason: "Detailed quote returned invalid JSON",
      };
    }

    const parsedPayload = payload as DetailedQuoteResponse;
    const status =
      typeof parsedPayload.status === "number"
        ? parsedPayload.status
        : Number(parsedPayload.status);
    const content =
      typeof parsedPayload.content === "string" ? parsedPayload.content : "";
    const message = asString(parsedPayload.message);

    if (!Number.isFinite(status) || status !== 1 || content.length === 0) {
      const reason =
        message ?? "Detailed quote endpoint returned no pricing content";
      if (attempt < MAX_RATE_LIMIT_RETRIES && isRateLimitedMessage(reason)) {
        lastRateLimitReason = reason;
        await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
        continue;
      }
      return {
        parsed: null,
        unavailableReason: reason,
      };
    }

    return {
      parsed: parseDetailedQuoteContent(content),
      unavailableReason: null,
    };
  }

  return {
    parsed: null,
    unavailableReason: lastRateLimitReason ?? "Too many requests",
  };
}

async function fetchQuoteWithTotals(input: {
  detailUrl: string;
  itemEid: string;
  typeId: string;
  inventoryId: string;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
  promoCode: string;
}): Promise<RawObservation> {
  const baseObservation = await fetchRcapiQuote(input);
  if (!baseObservation.quoteAvailable || baseObservation.baseTotal === null) {
    return baseObservation;
  }

  const detailed = await fetchDetailedQuote(input);
  if (!detailed.parsed) {
    return baseObservation;
  }

  const resolvedBase = detailed.parsed.baseTotal ?? baseObservation.baseTotal;
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
    roundCurrency(resolvedBase + resolvedFees + resolvedTaxes);

  return {
    ...baseObservation,
    baseTotal: resolvedBase,
    taxesTotal: resolvedTaxes,
    feesTotal: resolvedFees,
    grandTotal: resolvedGrand,
    feeLines: detailed.parsed.feeLines,
  };
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
  const detail = JSON.parse(raw) as Grayt30ADetailRecord;
  const unitId = detail.property_profile?.unit_id?.trim() ?? "";
  if (!unitId) {
    throw new Error(
      `Missing property_profile.unit_id for listing ${detail.external_listing_id}`,
    );
  }
  const detailHtmlPath = input.detailPath
    .replace("/details/json/", "/details/html/")
    .replace(/\.json$/i, ".html");
  const detailHtml = await readFile(detailHtmlPath, "utf8");
  const rcavIdentity = extractRcavIdentity({
    listingId: detail.external_listing_id,
    descriptionExpanded: detail.description_expanded ?? "",
    detailHtml,
  });

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
      const startDate = addDays(anchorDate, index * 7);
      const endDate = addDays(startDate, input.options.nights);
      return fetchQuoteWithTotals({
        detailUrl: detail.detail_url,
        itemEid: rcavIdentity.itemEid,
        typeId: rcavIdentity.typeId,
        inventoryId: rcavIdentity.inventoryId,
        startDate,
        endDate,
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

export async function runGrayt30AQuoteCli(
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

  progress?.phase("starting grayt30a quote sampling");
  progress?.info(
    `listings_selected=${totalSelected} pending=${selected.length} skipped_existing=${skippedExisting} weeks=${options.weeks} nights=${options.nights} adults=${options.adults} children=${options.children} quote_concurrency=${options.quoteConcurrency} listing_concurrency=${options.listingConcurrency}`,
  );

  if (selected.length === 0) {
    console.log(`${ADAPTER_KEY} quote sidecar generation complete.`);
    console.log(`- listings_selected: ${totalSelected}`);
    console.log(`- processed: 0`);
    console.log(`- skipped_existing: ${skippedExisting}`);
    progress?.success(
      `grayt30a quote sampling complete listings_selected=${totalSelected} processed=0 skipped_existing=${skippedExisting}`,
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
    `grayt30a quote sampling complete listings_selected=${totalSelected} processed=${summaries.length} skipped_existing=${skippedExisting}`,
  );
}

export async function runGrayt30ASingleQuoteObservation(
  input: SingleQuoteObservationInput,
): Promise<SingleQuoteObservationResult> {
  const rcavIdentityFromHandoff = (() => {
    if (!input.handoffUrl) {
      return null;
    }

    try {
      const parsed = new URL(input.handoffUrl);
      const itemEid = parsed.searchParams.get("rcav[eid]")?.trim() ?? "";
      let typeId = "";
      let inventoryId = "";
      for (const [key, value] of parsed.searchParams.entries()) {
        const match = key.match(/^rcav\[IDs\]\[(\d+)\]\[(?:\d+)?\]$/);
        if (match && value.trim()) {
          typeId = match[1] ?? "";
          inventoryId = value.trim();
          break;
        }
      }

      if (itemEid && typeId && inventoryId) {
        return { itemEid, typeId, inventoryId };
      }
    } catch {
      // Fall back to HTML/description extraction.
    }

    return null;
  })();

  const rcavIdentity =
    rcavIdentityFromHandoff ??
    extractRcavIdentity({
      listingId: input.listingId,
      descriptionExpanded: input.descriptionExpanded ?? "",
      detailHtml: input.detailHtml ?? "",
    });

  const startedAt = performance.now();
  const raw = await fetchQuoteWithTotals({
    detailUrl: input.detailUrl,
    itemEid: rcavIdentity.itemEid,
    typeId: rcavIdentity.typeId,
    inventoryId: rcavIdentity.inventoryId,
    startDate: input.checkInIso,
    endDate: input.checkOutIso,
    adults: Math.max(1, Math.floor(input.adults)),
    children: Math.max(0, Math.floor(input.children)),
    promoCode: "",
  });

  const feesTotalExclTaxes = raw.feesTotal;
  const quotedTotal = raw.grandTotal;
  const reason = raw.quoteAvailable
    ? null
    : (raw.quoteUnavailableReason ?? "Quote unavailable");

  return {
    elapsedMs: performance.now() - startedAt,
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
