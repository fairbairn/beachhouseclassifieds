import { Chalk } from "chalk";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import type { CanonicalQuotesSidecarRecord } from "@/lib/pricing/contracts/quote-observations-contract";
import { runWithConcurrency } from "@/lib/pricing/quotes/shared/run-with-concurrency";

const chalk = new Chalk({ level: 1 });

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DEFAULT_MAX_OBSERVATIONS = 4;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 6;
const DEFAULT_TOLERANCE = 1;
const DEFAULT_HANDOFF_RETRY_DELAYS_MS = [0, 1000, 2500, 5000, 9000];
const BEACHBLUE_NAVIGATION_TIMEOUT_MS = 8_000;
const BEACHBLUE_AJAX_WAIT_TIMEOUT_MS = 15_000;

let validationHttpActive = 0;
let validationHttpLastStartMs = 0;
const validationHttpWaiters: Array<() => void> = [];

type CliOptions = {
  adapterKey: string;
  listingId: string | null;
  maxListings: number | null;
  maxObservations: number;
  minLeadDays: number;
  concurrency: number;
  tolerance: number;
};

type ObservationCandidate = {
  adapterKey: string;
  listingId: string;
  detailUrl: string;
  startDate: string;
  endDate: string;
  observedGrandTotal: number;
  observedBaseTotal: number | null;
  observedTaxesTotal: number | null;
  handoffUrl: string;
};

type ObservationProgressReporter = (message: string) => void;

type ValidationFailure = {
  listingId: string;
  startDate: string;
  endDate: string;
  observedGrandTotal: number;
  handoffUrl: string;
  code:
    | "http_error"
    | "total_not_found"
    | "grand_total_mismatch"
    | "component_mismatch"
    | "invalid_observed_total"
    | "request_error"
    | "direct_status_error";
  message: string;
  extractedTotal: number | null;
};

type DirectTotalResult =
  | {
      kind: "success";
      total: number;
      baseTotal?: number | null;
      taxesTotal?: number | null;
      dueToday?: number | null;
    }
  | { kind: "status_error"; message: string }
  | { kind: "unsupported" }
  | { kind: "request_error"; message: string };

type ValidationResult = {
  tested: number;
  matched: number;
  failures: ValidationFailure[];
};

function parseArgs(argv: string[]): CliOptions {
  let adapterKey = "30abeach";
  let listingId: string | null = null;
  let maxListings: number | null = null;
  let maxObservations = DEFAULT_MAX_OBSERVATIONS;
  let minLeadDays = 0;
  let concurrency = DEFAULT_CONCURRENCY;
  let tolerance = DEFAULT_TOLERANCE;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--adapter-key" && value) {
      adapterKey = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg === "--listing-id" && value) {
      listingId = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--max-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxListings = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--max-observations" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxObservations = Math.max(1, Math.floor(parsed));
      }
      index += 1;
      continue;
    }

    if (arg === "--min-lead-days" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        minLeadDays = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        concurrency = Math.min(
          MAX_CONCURRENCY,
          Math.max(1, Math.floor(parsed)),
        );
      }
      index += 1;
      continue;
    }

    if (arg === "--tolerance" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        tolerance = parsed;
      }
      index += 1;
      continue;
    }
  }

  return {
    adapterKey,
    listingId,
    maxListings,
    maxObservations,
    minLeadDays,
    concurrency,
    tolerance,
  };
}

function parseIsoDateToUtcStartMs(value: string): number | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  return Date.UTC(year, month - 1, day);
}

function getUtcTodayStartMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function getLeadDaysFromUtcToday(
  startDateIso: string,
  utcTodayStartMs: number,
): number | null {
  const startDateUtcMs = parseIsoDateToUtcStartMs(startDateIso);
  if (startDateUtcMs === null) {
    return null;
  }
  return Math.floor((startDateUtcMs - utcTodayStartMs) / (24 * 60 * 60 * 1000));
}

async function collectQuoteFiles(
  quotesDir: string,
  listingId: string | null,
  maxListings: number | null,
): Promise<string[]> {
  const entries = await readdir(quotesDir, { withFileTypes: true });
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  let selected = jsonFiles;
  if (listingId) {
    selected = selected.filter((name) => name === `${listingId}.json`);
  }

  if (maxListings !== null) {
    selected = selected.slice(0, maxListings);
  }

  return selected;
}

function parseMoney(value: string): number | null {
  const parsed = Number(value.replace(/,/g, "").trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.round(parsed * 100) / 100;
}

function extractCandidateTotals(html: string): number[] {
  const candidates: number[] = [];

  const htmlPatterns = [
    /grand\s*total[^$]{0,140}\$\s*([0-9,]+(?:\.[0-9]{2})?)/gi,
    /total\s*due[^$]{0,140}\$\s*([0-9,]+(?:\.[0-9]{2})?)/gi,
    /(?:^|>)\s*total\s*(?:<|:|\s)[^$]{0,100}\$\s*([0-9,]+(?:\.[0-9]{2})?)/gi,
  ];

  for (const pattern of htmlPatterns) {
    for (const match of html.matchAll(pattern)) {
      const amount = parseMoney(match[1] ?? "");
      if (amount !== null) {
        candidates.push(amount);
      }
    }
  }

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

  const textPattern =
    /(grand\s*total|total\s*due|\btotal\b)[^$]{0,60}\$\s*([0-9,]+(?:\.[0-9]{2})?)/gi;
  for (const match of text.matchAll(textPattern)) {
    const amount = parseMoney(match[2] ?? "");
    if (amount !== null) {
      candidates.push(amount);
    }
  }

  return [...new Set(candidates)];
}

function pickClosestTotal(
  candidates: number[],
  target: number,
): { total: number; diff: number } | null {
  if (candidates.length === 0) {
    return null;
  }

  let best: { total: number; diff: number } | null = null;
  for (const candidate of candidates) {
    const diff = Math.abs(candidate - target);
    if (!best || diff < best.diff) {
      best = { total: candidate, diff };
    }
  }

  return best;
}

function isoToUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function normalizeToUsDate(value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
    return value;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return isoToUsDate(value);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return DEFAULT_HANDOFF_RETRY_DELAYS_MS;
}

function getHandoffRetryDelaysMs(adapterKey: string): number[] {
  const adapter = adapterKey.toLowerCase();
  if (adapter === "30aescapes") {
    return parseRetryDelaysMs(
      process.env.ESCAPES30A_HANDOFF_AJAX_RETRY_DELAYS_MS ??
        process.env.ESCAPES30A_QUOTE_AJAX_RETRY_DELAYS_MS ??
        "",
    );
  }
  return parseRetryDelaysMs(process.env.QUOTE_HANDOFF_RETRY_DELAYS_MS ?? "");
}

function getValidationHttpConcurrencyLimit(): number {
  const parsed = Number(
    process.env.QUOTE_HANDOFF_HTTP_CONCURRENCY ??
      process.env.ESCAPES30A_QUOTE_HTTP_CONCURRENCY ??
      "3",
  );
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 3;
  }
  return Math.min(MAX_CONCURRENCY, Math.floor(parsed));
}

function getValidationHttpMinGapMs(): number {
  const parsed = Number(
    process.env.QUOTE_HANDOFF_HTTP_MIN_GAP_MS ??
      process.env.ESCAPES30A_QUOTE_HTTP_MIN_GAP_MS ??
      "150",
  );
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 150;
  }
  return Math.floor(parsed);
}

async function acquireValidationHttpSlot(): Promise<void> {
  while (true) {
    if (validationHttpActive < getValidationHttpConcurrencyLimit()) {
      validationHttpActive += 1;
      break;
    }
    await new Promise<void>((resolve) => {
      validationHttpWaiters.push(resolve);
    });
  }

  const minGapMs = getValidationHttpMinGapMs();
  const waitMs = validationHttpLastStartMs + minGapMs - Date.now();
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  validationHttpLastStartMs = Date.now();
}

function releaseValidationHttpSlot(): void {
  validationHttpActive = Math.max(0, validationHttpActive - 1);
  const next = validationHttpWaiters.shift();
  next?.();
}

async function withValidationHttpRateLimit<T>(
  task: () => Promise<T>,
): Promise<T> {
  await acquireValidationHttpSlot();
  try {
    return await task();
  } finally {
    releaseValidationHttpSlot();
  }
}

async function fetchWithRetry(input: {
  url: string;
  init: RequestInit;
  retryDelaysMs: number[];
  reportProgress?: ObservationProgressReporter;
  retryLabel: string;
}): Promise<
  | { ok: true; response: Response }
  | { ok: false; message: string; statusCode: number | null }
> {
  for (let attempt = 0; attempt < input.retryDelaysMs.length; attempt += 1) {
    const delayMs = input.retryDelaysMs[attempt] ?? 0;
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      const response = await withValidationHttpRateLimit(() =>
        fetch(input.url, input.init),
      );

      if (response.ok) {
        return { ok: true, response };
      }

      input.reportProgress?.(
        `${input.retryLabel} retry ${attempt + 1}/${input.retryDelaysMs.length} failed status=${response.status}`,
      );

      if (attempt < input.retryDelaysMs.length - 1) {
        const nextDelay = input.retryDelaysMs[attempt + 1] ?? 0;
        input.reportProgress?.(
          `${input.retryLabel} awaiting next retry delay_ms=${nextDelay}`,
        );
      } else {
        return {
          ok: false,
          message: `${input.retryLabel} HTTP ${response.status}`,
          statusCode: response.status,
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      input.reportProgress?.(
        `${input.retryLabel} retry ${attempt + 1}/${input.retryDelaysMs.length} request_error=${message}`,
      );

      if (attempt < input.retryDelaysMs.length - 1) {
        const nextDelay = input.retryDelaysMs[attempt + 1] ?? 0;
        input.reportProgress?.(
          `${input.retryLabel} awaiting next retry delay_ms=${nextDelay}`,
        );
      } else {
        return {
          ok: false,
          message: `${input.retryLabel} request failed: ${message}`,
          statusCode: null,
        };
      }
    }
  }

  return {
    ok: false,
    message: `${input.retryLabel} exhausted retries`,
    statusCode: null,
  };
}

function parseSetCookieHeader(setCookie: string): string[] {
  if (!setCookie) {
    return [];
  }

  // Split combined Set-Cookie values while preserving commas inside Expires.
  return setCookie
    .split(/,(?=\s*[A-Za-z0-9_.-]+=)/g)
    .map((value) => value.trim());
}

function buildCookieHeader(setCookieValues: string[]): string {
  const cookieMap = new Map<string, string>();
  for (const cookie of setCookieValues) {
    const firstPart = cookie.split(";")[0]?.trim();
    if (!firstPart) {
      continue;
    }
    const eqIndex = firstPart.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const name = firstPart.slice(0, eqIndex).trim();
    const value = firstPart.slice(eqIndex + 1).trim();
    if (!name) {
      continue;
    }
    cookieMap.set(name, value);
  }
  return [...cookieMap.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function collectSetCookieValues(headers: Headers): string[] {
  const withGetSetCookie = headers as unknown as {
    getSetCookie?: () => string[];
  };

  if (typeof withGetSetCookie.getSetCookie === "function") {
    const values = withGetSetCookie.getSetCookie();
    if (Array.isArray(values) && values.length > 0) {
      return values;
    }
  }

  const joined = headers.get("set-cookie") ?? "";
  return parseSetCookieHeader(joined);
}

type SignedHandoffSpec = {
  requestUrl: string;
  method: string;
  contentType: string | null;
  payload: string | null;
};

function parseSignedHandoffSpec(handoffUrl: string): SignedHandoffSpec | null {
  let parsed: URL;
  try {
    parsed = new URL(handoffUrl);
  } catch {
    return null;
  }

  const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  if (!hash) {
    return null;
  }

  const hashParams = new URLSearchParams(hash);
  const methodRaw = hashParams.get("method")?.trim() ?? "";
  const payloadRaw = hashParams.get("payload");

  if (!methodRaw || !payloadRaw) {
    return null;
  }

  const method = methodRaw.toUpperCase();
  const contentType = hashParams.get("contentType")?.trim() ?? null;
  const requestUrl = `${parsed.origin}${parsed.pathname}${parsed.search}`;

  return {
    requestUrl,
    method,
    contentType,
    payload: payloadRaw,
  };
}

function findFirstUrlInJsonLikeText(text: string): string | null {
  const quotedUrlPattern =
    /"(?:redirect(?:_url|Url)?|url|booking(?:_url|Url)?|checkout(?:_url|Url)?)"\s*:\s*"([^"\n]+)"/i;
  const quotedMatch = text.match(quotedUrlPattern);
  if (quotedMatch?.[1]) {
    const normalized = quotedMatch[1].replace(/\\\//g, "/");
    if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
      return normalized;
    }
    if (normalized.startsWith("/")) {
      return normalized;
    }
  }

  const bareUrlPattern = /(https?:\/\/[^\s"'<>]+)/i;
  return text.match(bareUrlPattern)?.[1] ?? null;
}

function parseSignedHandoffTotalFromJsonText(text: string): {
  total: number;
  baseTotal: number | null;
  taxesTotal: number | null;
} | null {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const total = Number(payload.total);
    if (!Number.isFinite(total) || total <= 0) {
      return null;
    }

    const subTotalRaw = Number(payload.subTotal);
    const taxesRaw = Number(payload.taxes);

    return {
      total,
      baseTotal: Number.isFinite(subTotalRaw) ? subTotalRaw : null,
      taxesTotal: Number.isFinite(taxesRaw) ? taxesRaw : null,
    };
  } catch {
    return null;
  }
}

function parseSignedHandoffCartStateFromJsonText(text: string): {
  sessionId: string;
  cart: Record<string, unknown>;
} | null {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const sessionIdRaw = payload.sessionId;
    if (typeof sessionIdRaw !== "string" || sessionIdRaw.trim().length === 0) {
      return null;
    }
    return {
      sessionId: sessionIdRaw.trim(),
      cart: payload,
    };
  } catch {
    return null;
  }
}

async function tryExtractSignedHandoffTotal(
  candidate: ObservationCandidate,
  reportProgress?: ObservationProgressReporter,
): Promise<DirectTotalResult> {
  const spec = parseSignedHandoffSpec(candidate.handoffUrl);
  if (!spec) {
    return { kind: "unsupported" };
  }

  const playwrightModule = await import("playwright").catch(() => null);
  if (!playwrightModule?.chromium) {
    return {
      kind: "request_error",
      message: "playwright chromium unavailable for signed handoff validation",
    };
  }

  // Beachblue checkout totals should render quickly after router/ajax hydration.
  // Keep this path bounded and fail fast when #checkout-total is not present.
  const retryDelaysMs = [0];
  const browser = await playwrightModule.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();
    const handoffOrigin = new URL(spec.requestUrl).origin;
    const bookingUrl = new URL("/booking", spec.requestUrl).toString();

    await page.goto(handoffOrigin, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });

    for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
      const delayMs = retryDelaysMs[attempt] ?? 0;
      if (delayMs > 0) {
        await sleep(delayMs);
      }

      const postResult = await page.evaluate(
        async ({ requestUrl, method, contentType, payload, referer }) => {
          try {
            const response = await fetch(requestUrl, {
              method,
              headers: {
                accept: "application/json, text/plain, */*",
                ...(contentType ? { "content-type": contentType } : {}),
                origin: new URL(requestUrl).origin,
                referer,
              },
              body: payload,
              credentials: "include",
            });
            const text = await response.text();
            return {
              ok: true,
              status: response.status,
              text,
            };
          } catch (error) {
            return {
              ok: false,
              status: 0,
              text: String(error),
            };
          }
        },
        {
          requestUrl: spec.requestUrl,
          method: spec.method,
          contentType: spec.contentType,
          payload: spec.payload,
          referer: candidate.detailUrl,
        },
      );

      if (!postResult.ok) {
        reportProgress?.(
          `signed handoff request retry ${attempt + 1}/${retryDelaysMs.length} request_error=${postResult.text}`,
        );
        continue;
      }

      const postJsonTotals = parseSignedHandoffTotalFromJsonText(
        postResult.text,
      );
      const postCartState = parseSignedHandoffCartStateFromJsonText(
        postResult.text,
      );
      if (!postJsonTotals) {
        reportProgress?.(
          `signed handoff request retry ${attempt + 1}/${retryDelaysMs.length} missing quoted total in response status=${postResult.status}`,
        );
        continue;
      }

      if (postCartState) {
        await page.evaluate((input) => {
          document.cookie = `nret[sessionId]=${input.sessionId}; path=/`;
          sessionStorage.setItem("cart", JSON.stringify(input.cart));
        }, postCartState);
      }

      const pollDelaysMs = [0, 600, 1200, 2500, 5000, 9000];
      for (let poll = 0; poll < pollDelaysMs.length; poll += 1) {
        const pollDelay = pollDelaysMs[poll] ?? 0;
        if (pollDelay > 0) {
          await sleep(pollDelay);
        }

        try {
          await page.goto(bookingUrl, {
            waitUntil: "networkidle",
            timeout: 120_000,
          });
          await page.waitForTimeout(1500);
        } catch {
          reportProgress?.(
            `signed handoff booking poll ${poll + 1}/${pollDelaysMs.length} navigation_failed`,
          );
          continue;
        }

        const totalTexts = await page
          .locator("#total-price")
          .allInnerTexts()
          .catch(() => []);
        const parsedTotals = totalTexts
          .map((text) => parseMoney(text))
          .filter(
            (value): value is number => typeof value === "number" && value > 0,
          );
        if (parsedTotals.length > 0) {
          const best = parsedTotals.reduce(
            (currentBest, candidateTotal) => {
              if (currentBest === null) {
                return candidateTotal;
              }
              const currentDiff = Math.abs(
                currentBest - candidate.observedGrandTotal,
              );
              const candidateDiff = Math.abs(
                candidateTotal - candidate.observedGrandTotal,
              );
              return candidateDiff < currentDiff ? candidateTotal : currentBest;
            },
            null as number | null,
          );

          if (best !== null) {
            return {
              kind: "success",
              total: best,
              baseTotal: postJsonTotals.baseTotal,
              taxesTotal: postJsonTotals.taxesTotal,
            };
          }
        }

        const html = await page.content();
        const match = html.match(
          /id=["']total-price["'][^>]*>\s*\$?\s*([0-9,]+(?:\.[0-9]{2})?)/i,
        );
        if (match?.[1]) {
          const visibleTotal = parseMoney(match[1]);
          if (visibleTotal !== null && visibleTotal > 0) {
            return {
              kind: "success",
              total: visibleTotal,
              baseTotal: postJsonTotals.baseTotal,
              taxesTotal: postJsonTotals.taxesTotal,
            };
          }
        }

        reportProgress?.(
          `signed handoff booking poll ${poll + 1}/${pollDelaysMs.length} waiting for #total-price (url=${page.url()})`,
        );
      }

      reportProgress?.(
        `signed handoff retry ${attempt + 1}/${retryDelaysMs.length} no visible #total-price after booking load`,
      );
    }
  } finally {
    await browser.close();
  }

  return {
    kind: "request_error",
    message:
      "signed handoff flow exhausted retries without visible #total-price on booking page",
  };
}

async function tryExtractBeachblueCheckoutTotal(
  candidate: ObservationCandidate,
  reportProgress?: ObservationProgressReporter,
): Promise<DirectTotalResult> {
  let parsed: URL;
  try {
    parsed = new URL(candidate.handoffUrl);
  } catch {
    return { kind: "unsupported" };
  }

  if (
    !parsed.hostname.endsWith("beachblueproperties.com") ||
    !parsed.pathname.includes("/vacation-rentals/checkout/")
  ) {
    return { kind: "unsupported" };
  }

  const playwrightModule = await import("playwright").catch(() => null);
  if (!playwrightModule?.chromium) {
    return {
      kind: "request_error",
      message:
        "playwright chromium unavailable for beachblue checkout validation",
    };
  }

  const retryDelaysMs = getHandoffRetryDelaysMs(candidate.adapterKey);
  const browser = await playwrightModule.chromium.launch({ headless: true });

  const parseRouterAmount = (value: unknown): number | null => {
    if (typeof value === "number") {
      return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
    }
    if (typeof value === "string") {
      return parseMoney(value);
    }
    return null;
  };

  const parseBeachblueRouterResult = (
    payload: unknown,
  ):
    | { kind: "success"; total: number }
    | { kind: "status_error"; message: string }
    | null => {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const record = payload as Record<string, unknown>;
    const isAvailable = record.isAvailable === true;
    const bookingTotal = parseRouterAmount(record.bookingTotal);

    if (!isAvailable) {
      const reason =
        typeof record.errorMsg === "string" && record.errorMsg.trim().length > 0
          ? record.errorMsg.trim()
          : typeof record.apiError === "string" &&
              record.apiError.trim().length > 0
            ? record.apiError.trim()
            : "beachblue router reported unavailable status";
      return { kind: "status_error", message: reason };
    }

    if (bookingTotal !== null && bookingTotal > 0) {
      return { kind: "success", total: bookingTotal };
    }

    return null;
  };

  try {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();

    for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
      const delayMs = retryDelaysMs[attempt] ?? 0;
      if (delayMs > 0) {
        await sleep(delayMs);
      }

      let routerResult:
        | { kind: "success"; total: number }
        | { kind: "status_error"; message: string }
        | null = null;

      const onResponse = async (response: {
        url(): string;
        request(): { method(): string };
        json(): Promise<unknown>;
      }): Promise<void> => {
        if (
          !response.url().includes("/vacation-rentals/router/") ||
          response.request().method() !== "POST"
        ) {
          return;
        }

        try {
          const parsed = parseBeachblueRouterResult(await response.json());
          if (parsed !== null) {
            routerResult = parsed;
          }
        } catch {
          // Ignore non-JSON router responses.
        }
      };
      page.on("response", onResponse);

      try {
        await page.goto(candidate.handoffUrl, {
          waitUntil: "domcontentloaded",
          timeout: BEACHBLUE_NAVIGATION_TIMEOUT_MS,
        });
      } catch (error: unknown) {
        page.off("response", onResponse);
        const message = error instanceof Error ? error.message : String(error);
        reportProgress?.(
          `beachblue checkout retry ${attempt + 1}/${retryDelaysMs.length} navigation_error=${message}`,
        );
        continue;
      }

      await page
        .waitForSelector("#price-block, #checkout-total", {
          timeout: BEACHBLUE_AJAX_WAIT_TIMEOUT_MS,
        })
        .catch(() => null);

      const totalText = await page
        .locator("#checkout-total")
        .first()
        .textContent()
        .catch(() => null);

      const parsedTotal = totalText ? parseMoney(totalText) : null;
      if (parsedTotal !== null && parsedTotal > 0) {
        page.off("response", onResponse);
        return {
          kind: "success",
          total: parsedTotal,
        };
      }

      if (routerResult?.kind === "success") {
        page.off("response", onResponse);
        return {
          kind: "success",
          total: routerResult.total,
        };
      }

      if (routerResult?.kind === "status_error") {
        page.off("response", onResponse);
        return routerResult;
      }

      const warningText = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      if (/unable to obtain current pricing/i.test(warningText)) {
        page.off("response", onResponse);
        return {
          kind: "status_error",
          message:
            "beachblue checkout page returned pricing unavailable warning",
        };
      }

      page.off("response", onResponse);

      reportProgress?.(
        `beachblue checkout retry ${attempt + 1}/${retryDelaysMs.length} no #checkout-total after ${BEACHBLUE_AJAX_WAIT_TIMEOUT_MS}ms`,
      );
    }
  } finally {
    await browser.close();
  }

  return {
    kind: "request_error",
    message:
      "beachblue checkout total not rendered in #checkout-total after retries",
  };
}

function extract30AEscapesAjaxPath(
  handoffHtml: string,
  fallbackPath: string,
): string {
  const pattern = /(["'])([^"']*get-booknow-rates\.cfm[^"']*)\1/i;
  const match = handoffHtml.match(pattern);
  if (!match) {
    return fallbackPath;
  }

  const extracted = match[2]?.trim();
  if (!extracted) {
    return fallbackPath;
  }

  if (extracted.startsWith("http://") || extracted.startsWith("https://")) {
    try {
      return new URL(extracted).pathname;
    } catch {
      return fallbackPath;
    }
  }

  if (extracted.startsWith("/")) {
    return extracted;
  }

  if (extracted.startsWith("ajax/")) {
    return `/rentals/${extracted}`;
  }

  return fallbackPath;
}

function parse30AEscapesTotalsFromAjax(html: string): {
  total: number | null;
  baseTotal: number | null;
  taxesTotal: number | null;
  dueToday: number | null;
} {
  const totalAmountMatch = html.match(
    /Total\s*Amount<\/td>\s*<td>\$\s*([0-9,]+(?:\.[0-9]{2})?)<\/td>/i,
  );
  const rentMatch = html.match(
    /Rent<\/td>\s*<td[^>]*>[\s\S]*?\$\s*([0-9,]+(?:\.[0-9]{2})?)\s*<\/td>/i,
  );
  const taxesMatch = html.match(
    /Taxes<\/td>\s*<td>\$\s*([0-9,]+(?:\.[0-9]{2})?)<\/td>/i,
  );
  const dueTodayMatch = html.match(
    /Due\s*Today<\/td>\s*<td>\$\s*([0-9,]+(?:\.[0-9]{2})?)<\/td>/i,
  );

  const bookingValueMatch = html.match(
    /\$\('#BookingValue'\)\.val\('([0-9,.]+)'\)/i,
  );

  const totalFromTable = totalAmountMatch?.[1]
    ? parseMoney(totalAmountMatch[1])
    : null;
  const totalFromScript = bookingValueMatch?.[1]
    ? parseMoney(bookingValueMatch[1])
    : null;

  return {
    total:
      (totalFromTable !== null && totalFromTable > 0 ? totalFromTable : null) ??
      (totalFromScript !== null && totalFromScript > 0
        ? totalFromScript
        : null),
    baseTotal: rentMatch?.[1] ? parseMoney(rentMatch[1]) : null,
    taxesTotal: taxesMatch?.[1] ? parseMoney(taxesMatch[1]) : null,
    dueToday: dueTodayMatch?.[1] ? parseMoney(dueTodayMatch[1]) : null,
  };
}

function parseRealjoyPriceByLabel(html: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<span\\s+class="pdp-quote-item-text">\\s*${escaped}\\s*<\\/span>[\\s\\S]*?<span\\s+class="pdp-quote-item-price"\\s+data-price="([^"]+)"`,
    "i",
  );
  const value = pattern.exec(html)?.[1] ?? "";
  const parsed = parseMoney(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function parseOceanreefPriceByLabel(
  html: string,
  label: string,
): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<span\\s+class=\"book-quote-item-text\">\\s*${escaped}\\s*<\\/span>[\\s\\S]*?<span\\s+class=\"book-quote-item-price\"[^>]*data-price=\"([^\"]+)\"`,
    "i",
  );
  const value = pattern.exec(html)?.[1] ?? "";
  const parsed = parseMoney(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function parseOceanreefFeeLines(
  html: string,
): Array<{ name: string; amount: number }> {
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
    const name = match[1]?.trim() ?? "";
    const amount = parseMoney(match[2] ?? "");
    if (name && amount !== null && amount >= 0) {
      feeLines.push({ name, amount });
    }
    match = itemPattern.exec(feeSectionMatch[1]);
  }

  return feeLines;
}

function parseOceanreefTotalsFromHtml(html: string): {
  total: number | null;
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotal: number | null;
} {
  const total =
    parseOceanreefPriceByLabel(html, "Total") ??
    parseMoney(
      html.match(
        /id=\"hiddenTotal\"\)\.val\(\"([0-9,]+(?:\.[0-9]{2})?)\"\)/i,
      )?.[1] ?? "",
    );
  const baseTotal = parseOceanreefPriceByLabel(html, "Rent");
  const taxesTotal = parseOceanreefPriceByLabel(html, "Taxes");
  const feeLines = parseOceanreefFeeLines(html);
  const feeLinesTotal =
    feeLines.length > 0
      ? Math.round(feeLines.reduce((sum, line) => sum + line.amount, 0) * 100) /
        100
      : null;
  const feesTotal = parseOceanreefPriceByLabel(html, "Fees") ?? feeLinesTotal;
  return { total, baseTotal, taxesTotal, feesTotal };
}

function extractRealjoyPropertyName(detailHtml: string): string {
  const h1Match = detailHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!h1Match?.[1]) {
    return "";
  }
  return h1Match[1]
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toUsDateFromIso(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

async function tryExtractRealjoyDirectTotal(
  candidate: ObservationCandidate,
  reportProgress?: ObservationProgressReporter,
): Promise<DirectTotalResult> {
  let parsed: URL;
  try {
    parsed = new URL(candidate.handoffUrl);
  } catch {
    return { kind: "unsupported" };
  }

  if (!parsed.hostname.endsWith("realjoy.com")) {
    return { kind: "unsupported" };
  }

  const propertyId =
    parsed.searchParams.get("propertyID")?.trim() ??
    parsed.searchParams.get("propertyId")?.trim() ??
    candidate.listingId.trim();
  if (!propertyId) {
    return { kind: "unsupported" };
  }

  const retryDelaysMs = getHandoffRetryDelaysMs(candidate.adapterKey);

  try {
    const detailResult = await fetchWithRetry({
      url: candidate.detailUrl,
      init: {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "user-agent": USER_AGENT,
          referer: candidate.handoffUrl,
        },
      },
      retryDelaysMs,
      reportProgress,
      retryLabel: "realjoy detail page",
    });

    if (!detailResult.ok) {
      return { kind: "request_error", message: detailResult.message };
    }

    const detailHtml = await detailResult.response.text();
    const propertyName = extractRealjoyPropertyName(detailHtml);
    const endpoint = `${parsed.origin}/ajax/quote`;
    const body = new URLSearchParams();
    body.set("checkin", toUsDateFromIso(candidate.startDate));
    body.set("checkout", toUsDateFromIso(candidate.endDate));
    body.set("propertyID", propertyId);
    body.set("roomTypeID", "");
    body.set("propertyName", propertyName);
    body.set("hash", "");

    const quoteResult = await fetchWithRetry({
      url: endpoint,
      init: {
        method: "POST",
        headers: {
          accept: "text/html, */*; q=0.01",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
          "user-agent": USER_AGENT,
          referer: candidate.detailUrl,
          origin: parsed.origin,
        },
        body: body.toString(),
      },
      retryDelaysMs,
      reportProgress,
      retryLabel: "realjoy ajax quote",
    });

    if (!quoteResult.ok) {
      return { kind: "request_error", message: quoteResult.message };
    }

    const quoteHtml = await quoteResult.response.text();
    const total = parseRealjoyPriceByLabel(quoteHtml, "Total");
    const baseTotal = parseRealjoyPriceByLabel(quoteHtml, "Rent");
    const taxesTotal = parseRealjoyPriceByLabel(quoteHtml, "Taxes");

    if (total === null || total <= 0) {
      return {
        kind: "request_error",
        message: "realjoy ajax quote payload missing total",
      };
    }

    return {
      kind: "success",
      total,
      baseTotal,
      taxesTotal,
    };
  } catch (error: unknown) {
    return {
      kind: "request_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function tryExtractOceanreefDirectTotal(
  candidate: ObservationCandidate,
  reportProgress?: ObservationProgressReporter,
): Promise<DirectTotalResult> {
  let parsed: URL;
  try {
    parsed = new URL(candidate.handoffUrl);
  } catch {
    return { kind: "unsupported" };
  }

  if (!parsed.hostname.endsWith("oceanreefresorts.com")) {
    return { kind: "unsupported" };
  }

  const propertyId =
    parsed.searchParams.get("propertyID")?.trim() ??
    parsed.searchParams.get("propertyId")?.trim() ??
    candidate.listingId.trim();

  const checkin = parsed.searchParams.get("checkin")?.trim() ?? "";
  const checkout = parsed.searchParams.get("checkout")?.trim() ?? "";
  if (!propertyId || !checkin || !checkout) {
    return { kind: "unsupported" };
  }

  const adults = Math.max(1, Number(parsed.searchParams.get("adults") ?? "2"));
  const children = Math.max(
    0,
    Number(parsed.searchParams.get("children") ?? "0"),
  );
  const pets = Math.max(0, Number(parsed.searchParams.get("pets") ?? "0"));

  const retryDelaysMs = getHandoffRetryDelaysMs(candidate.adapterKey);
  const endpoint = `${parsed.origin}/ajax/pricesummary/`;
  const body = new URLSearchParams();
  body.set("propertyID", propertyId);
  body.set("checkin", checkin);
  body.set("checkout", checkout);
  body.set("adults", String(adults));
  body.set("children", String(children));
  body.set("pets", String(pets));
  body.set("leaseID", "");
  body.set("optInFees", "");
  body.set("optOutFees", "");
  body.set("customQuoteID", "");
  body.set("chargetemplateid", "");
  body.set("travelInsuranceID", "");
  body.set("promoCodeSubmitted", "0");
  body.set("promocode", "");

  try {
    const responseResult = await fetchWithRetry({
      url: endpoint,
      init: {
        method: "POST",
        headers: {
          accept: "text/html, */*; q=0.01",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
          "user-agent": USER_AGENT,
          referer: candidate.handoffUrl,
          origin: parsed.origin,
        },
        body: body.toString(),
      },
      retryDelaysMs,
      reportProgress,
      retryLabel: "oceanreef pricesummary",
    });

    if (!responseResult.ok) {
      return { kind: "request_error", message: responseResult.message };
    }

    const html = await responseResult.response.text();
    const totals = parseOceanreefTotalsFromHtml(html);
    if (totals.total === null || totals.total <= 0) {
      const lowered = html.toLowerCase();
      if (
        lowered.includes("not available") ||
        lowered.includes("dates unavailable") ||
        lowered.includes("unavailable")
      ) {
        return {
          kind: "status_error",
          message: "Property not available for selected dates",
        };
      }

      return {
        kind: "request_error",
        message: "oceanreef pricesummary payload missing total",
      };
    }

    return {
      kind: "success",
      total: totals.total,
      baseTotal: totals.baseTotal,
      taxesTotal: totals.taxesTotal,
    };
  } catch (error: unknown) {
    return {
      kind: "request_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function tryExtractDirectStreamlineTotal(
  candidate: ObservationCandidate,
  reportProgress?: ObservationProgressReporter,
): Promise<DirectTotalResult> {
  let parsed: URL;
  try {
    parsed = new URL(candidate.handoffUrl);
  } catch {
    return { kind: "unsupported" };
  }

  if (!parsed.pathname.includes("/checkout")) {
    return { kind: "unsupported" };
  }

  const rawUnitId =
    parsed.searchParams.get("unit") ?? parsed.searchParams.get("book_unit");
  const rawStart =
    parsed.searchParams.get("sd") ?? parsed.searchParams.get("book_start_date");
  const rawEnd =
    parsed.searchParams.get("ed") ?? parsed.searchParams.get("book_end_date");
  const rawAdults =
    parsed.searchParams.get("oc") ??
    parsed.searchParams.get("book_occupants") ??
    "1";
  const rawChildren =
    parsed.searchParams.get("os") ??
    parsed.searchParams.get("book_occupants_small") ??
    "0";
  const rawPets = parsed.searchParams.get("book_pets") ?? "0";

  const startDateUs = normalizeToUsDate(rawStart);
  const endDateUs = normalizeToUsDate(rawEnd);
  const unitId = Number(rawUnitId ?? "");
  const adults = Math.max(1, Number(rawAdults));
  const children = Math.max(0, Number(rawChildren));
  const pets = Math.max(0, Number(rawPets));

  if (
    !Number.isFinite(unitId) ||
    !Number.isFinite(adults) ||
    !Number.isFinite(children) ||
    !Number.isFinite(pets) ||
    !startDateUs ||
    !endDateUs
  ) {
    return { kind: "unsupported" };
  }

  const endpoint = `${parsed.origin}/wp-admin/admin-ajax.php`;
  const body = new URLSearchParams();
  body.set("action", "streamlinecore-api-request");
  body.set(
    "params",
    JSON.stringify({
      methodName: "GetPreReservationPrice",
      params: {
        unit_id: unitId,
        startdate: startDateUs,
        enddate: endDateUs,
        occupants: adults,
        occupants_small: children,
        pets,
      },
    }),
  );

  const retryDelaysMs = getHandoffRetryDelaysMs(candidate.adapterKey);

  try {
    const responseResult = await fetchWithRetry({
      url: endpoint,
      init: {
        method: "POST",
        headers: {
          accept: "application/json, text/plain, */*",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "user-agent": USER_AGENT,
          referer: candidate.handoffUrl,
          origin: parsed.origin,
        },
        body: body.toString(),
      },
      retryDelaysMs,
      reportProgress,
      retryLabel: "handoff direct ajax",
    });

    if (!responseResult.ok) {
      return {
        kind: "request_error",
        message: responseResult.message,
      };
    }

    const response = responseResult.response;

    const payload = (await response.json()) as {
      status?: { code?: unknown; description?: unknown };
      data?: { total?: unknown };
    };

    if (payload.status?.code) {
      const description =
        typeof payload.status.description === "string"
          ? payload.status.description
          : String(payload.status.code);
      return {
        kind: "status_error",
        message: description,
      };
    }

    const totalRaw =
      typeof payload.data?.total === "number"
        ? payload.data.total
        : Number(
            String(payload.data?.total ?? "")
              .replace(/,/g, "")
              .trim(),
          );

    if (!Number.isFinite(totalRaw) || totalRaw <= 0) {
      return {
        kind: "request_error",
        message: "Direct total payload missing data.total",
      };
    }

    return {
      kind: "success",
      total: Math.round(totalRaw * 100) / 100,
    };
  } catch (error: unknown) {
    return {
      kind: "request_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function tryExtract30AEscapesDirectTotal(
  candidate: ObservationCandidate,
  reportProgress?: ObservationProgressReporter,
): Promise<DirectTotalResult> {
  let parsed: URL;
  try {
    parsed = new URL(candidate.handoffUrl);
  } catch {
    return { kind: "unsupported" };
  }

  if (
    !parsed.hostname.endsWith("30aescapes.com") ||
    !parsed.pathname.includes("/rentals/book-now.cfm")
  ) {
    return { kind: "unsupported" };
  }

  const propertyid = parsed.searchParams.get("propertyid")?.trim() ?? "";
  const strcheckin = parsed.searchParams.get("strcheckin")?.trim() ?? "";
  const strcheckout = parsed.searchParams.get("strcheckout")?.trim() ?? "";

  if (!propertyid || !strcheckin || !strcheckout) {
    return { kind: "unsupported" };
  }

  const retryDelaysMs = getHandoffRetryDelaysMs(candidate.adapterKey);

  try {
    // Bootstrap the booking page first so downstream ajax calls share browser-like session state.
    const handoffResult = await fetchWithRetry({
      url: candidate.handoffUrl,
      init: {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "user-agent": USER_AGENT,
          referer: candidate.detailUrl,
        },
      },
      retryDelaysMs,
      reportProgress,
      retryLabel: "handoff page",
    });

    if (!handoffResult.ok) {
      return {
        kind: "request_error",
        message: handoffResult.message,
      };
    }

    const handoffResponse = handoffResult.response;

    const handoffHtml = await handoffResponse.text();
    const cookieHeader = buildCookieHeader(
      collectSetCookieValues(handoffResponse.headers),
    );

    const ajaxPath = extract30AEscapesAjaxPath(
      handoffHtml,
      "/rentals/ajax/get-booknow-rates.cfm",
    );
    const endpoint = new URL(ajaxPath, parsed.origin);
    endpoint.searchParams.set("propertyid", propertyid);
    endpoint.searchParams.set("strcheckin", strcheckin);
    endpoint.searchParams.set("strcheckout", strcheckout);

    const attemptDelaysMs = retryDelaysMs;
    for (let attempt = 0; attempt < attemptDelaysMs.length; attempt += 1) {
      if (attemptDelaysMs[attempt] > 0) {
        await sleep(attemptDelaysMs[attempt]);
      }

      const requestUrl = new URL(endpoint.toString());
      requestUrl.searchParams.set("_", String(Date.now()));

      const responseResult = await withValidationHttpRateLimit(async () => {
        try {
          const response = await fetch(requestUrl.toString(), {
            headers: {
              accept: "text/html, */*;q=0.1",
              "x-requested-with": "XMLHttpRequest",
              "user-agent": USER_AGENT,
              referer: candidate.handoffUrl,
              ...(cookieHeader ? { cookie: cookieHeader } : {}),
            },
          });
          if (!response.ok) {
            return {
              ok: false as const,
              message: `30aescapes rates HTTP ${response.status}`,
              statusCode: response.status,
              response: null,
            };
          }
          return {
            ok: true as const,
            message: "",
            statusCode: response.status,
            response,
          };
        } catch (error: unknown) {
          return {
            ok: false as const,
            message: error instanceof Error ? error.message : String(error),
            statusCode: null,
            response: null,
          };
        }
      });

      if (!responseResult.ok || !responseResult.response) {
        reportProgress?.(
          `handoff ajax retry ${attempt + 1}/${attemptDelaysMs.length} failed ${responseResult.statusCode !== null ? `status=${responseResult.statusCode}` : `request_error=${responseResult.message}`}`,
        );
        if (attempt < attemptDelaysMs.length - 1) {
          const nextDelayMs = attemptDelaysMs[attempt + 1] ?? 0;
          reportProgress?.(
            `handoff ajax awaiting next retry delay_ms=${nextDelayMs}`,
          );
          continue;
        }
        return {
          kind: "request_error",
          message:
            responseResult.statusCode !== null
              ? `30aescapes rates HTTP ${responseResult.statusCode}`
              : `30aescapes rates request failed: ${responseResult.message}`,
        };
      }

      const response = responseResult.response;

      const html = await response.text();
      const lowered = html.toLowerCase();
      if (
        lowered.includes("property is not available") ||
        lowered.includes("unit has no availability")
      ) {
        return {
          kind: "status_error",
          message: "Property not available for selected dates",
        };
      }

      const totals = parse30AEscapesTotalsFromAjax(html);
      if (totals.total !== null) {
        return {
          kind: "success",
          total: totals.total,
          baseTotal: totals.baseTotal,
          taxesTotal: totals.taxesTotal,
          dueToday: totals.dueToday,
        };
      }

      reportProgress?.(
        `handoff ajax retry ${attempt + 1}/${attemptDelaysMs.length} missing total amount`,
      );

      if (attempt < attemptDelaysMs.length - 1) {
        const nextDelayMs = attemptDelaysMs[attempt + 1] ?? 0;
        reportProgress?.(
          `handoff ajax awaiting next retry delay_ms=${nextDelayMs}`,
        );
        continue;
      }

      return {
        kind: "request_error",
        message: "30aescapes rates payload missing total amount",
      };
    }

    return {
      kind: "request_error",
      message: "30aescapes rates extraction exhausted retries",
    };
  } catch (error: unknown) {
    return {
      kind: "request_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function validateObservation(
  candidate: ObservationCandidate,
  tolerance: number,
  reportProgress?: ObservationProgressReporter,
): Promise<ValidationFailure | null> {
  if (
    !Number.isFinite(candidate.observedGrandTotal) ||
    candidate.observedGrandTotal <= 0
  ) {
    return {
      listingId: candidate.listingId,
      startDate: candidate.startDate,
      endDate: candidate.endDate,
      observedGrandTotal: candidate.observedGrandTotal,
      handoffUrl: candidate.handoffUrl,
      code: "invalid_observed_total",
      message: "grand_total is not a positive finite number",
      extractedTotal: null,
    };
  }

  const escapesDirect = await tryExtract30AEscapesDirectTotal(
    candidate,
    reportProgress,
  );
  if (escapesDirect.kind === "success") {
    const diff = Math.abs(escapesDirect.total - candidate.observedGrandTotal);
    if (diff > tolerance) {
      return {
        listingId: candidate.listingId,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        observedGrandTotal: candidate.observedGrandTotal,
        handoffUrl: candidate.handoffUrl,
        code: "grand_total_mismatch",
        message: `Observed grand_total=${candidate.observedGrandTotal.toFixed(2)} differs from direct total=${escapesDirect.total.toFixed(2)} (diff=${diff.toFixed(2)})`,
        extractedTotal: escapesDirect.total,
      };
    }

    if (
      candidate.adapterKey === "30aescapes" &&
      candidate.observedBaseTotal !== null &&
      Number.isFinite(candidate.observedBaseTotal) &&
      escapesDirect.baseTotal !== null &&
      Number.isFinite(escapesDirect.baseTotal)
    ) {
      const baseDiff = Math.abs(
        candidate.observedBaseTotal - escapesDirect.baseTotal,
      );
      if (baseDiff > tolerance) {
        return {
          listingId: candidate.listingId,
          startDate: candidate.startDate,
          endDate: candidate.endDate,
          observedGrandTotal: candidate.observedGrandTotal,
          handoffUrl: candidate.handoffUrl,
          code: "component_mismatch",
          message: `Base total mismatch observed=${candidate.observedBaseTotal.toFixed(2)} checkout_rent=${escapesDirect.baseTotal.toFixed(2)} (diff=${baseDiff.toFixed(2)})`,
          extractedTotal: escapesDirect.total,
        };
      }
    }

    if (
      candidate.adapterKey === "30aescapes" &&
      candidate.observedTaxesTotal !== null &&
      Number.isFinite(candidate.observedTaxesTotal) &&
      escapesDirect.taxesTotal !== null &&
      Number.isFinite(escapesDirect.taxesTotal)
    ) {
      const taxesDiff = Math.abs(
        candidate.observedTaxesTotal - escapesDirect.taxesTotal,
      );
      if (taxesDiff > tolerance) {
        return {
          listingId: candidate.listingId,
          startDate: candidate.startDate,
          endDate: candidate.endDate,
          observedGrandTotal: candidate.observedGrandTotal,
          handoffUrl: candidate.handoffUrl,
          code: "component_mismatch",
          message: `Taxes mismatch observed=${candidate.observedTaxesTotal.toFixed(2)} checkout_taxes=${escapesDirect.taxesTotal.toFixed(2)} (diff=${taxesDiff.toFixed(2)})`,
          extractedTotal: escapesDirect.total,
        };
      }
    }

    return null;
  }

  if (candidate.adapterKey === "realjoy30a") {
    const realjoyDirect = await tryExtractRealjoyDirectTotal(
      candidate,
      reportProgress,
    );

    if (realjoyDirect.kind === "success") {
      const diff = Math.abs(realjoyDirect.total - candidate.observedGrandTotal);
      if (diff > tolerance) {
        return {
          listingId: candidate.listingId,
          startDate: candidate.startDate,
          endDate: candidate.endDate,
          observedGrandTotal: candidate.observedGrandTotal,
          handoffUrl: candidate.handoffUrl,
          code: "grand_total_mismatch",
          message: `Observed grand_total=${candidate.observedGrandTotal.toFixed(2)} differs from realjoy ajax total=${realjoyDirect.total.toFixed(2)} (diff=${diff.toFixed(2)})`,
          extractedTotal: realjoyDirect.total,
        };
      }
      return null;
    }

    if (realjoyDirect.kind === "request_error") {
      return {
        listingId: candidate.listingId,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        observedGrandTotal: candidate.observedGrandTotal,
        handoffUrl: candidate.handoffUrl,
        code: "request_error",
        message: `realjoy ajax quote extraction failed: ${realjoyDirect.message}`,
        extractedTotal: null,
      };
    }
  }

  if (candidate.adapterKey === "oceanreef30a") {
    const oceanreefDirect = await tryExtractOceanreefDirectTotal(
      candidate,
      reportProgress,
    );

    if (oceanreefDirect.kind === "success") {
      const diff = Math.abs(
        oceanreefDirect.total - candidate.observedGrandTotal,
      );
      if (diff > tolerance) {
        return {
          listingId: candidate.listingId,
          startDate: candidate.startDate,
          endDate: candidate.endDate,
          observedGrandTotal: candidate.observedGrandTotal,
          handoffUrl: candidate.handoffUrl,
          code: "grand_total_mismatch",
          message: `Observed grand_total=${candidate.observedGrandTotal.toFixed(2)} differs from oceanreef ajax total=${oceanreefDirect.total.toFixed(2)} (diff=${diff.toFixed(2)})`,
          extractedTotal: oceanreefDirect.total,
        };
      }

      if (
        candidate.observedBaseTotal !== null &&
        Number.isFinite(candidate.observedBaseTotal) &&
        oceanreefDirect.baseTotal !== null &&
        Number.isFinite(oceanreefDirect.baseTotal)
      ) {
        const baseDiff = Math.abs(
          candidate.observedBaseTotal - oceanreefDirect.baseTotal,
        );
        if (baseDiff > tolerance) {
          return {
            listingId: candidate.listingId,
            startDate: candidate.startDate,
            endDate: candidate.endDate,
            observedGrandTotal: candidate.observedGrandTotal,
            handoffUrl: candidate.handoffUrl,
            code: "component_mismatch",
            message: `Oceanreef base total mismatch observed=${candidate.observedBaseTotal.toFixed(2)} checkout_rent=${oceanreefDirect.baseTotal.toFixed(2)} (diff=${baseDiff.toFixed(2)})`,
            extractedTotal: oceanreefDirect.total,
          };
        }
      }

      if (
        candidate.observedTaxesTotal !== null &&
        Number.isFinite(candidate.observedTaxesTotal) &&
        oceanreefDirect.taxesTotal !== null &&
        Number.isFinite(oceanreefDirect.taxesTotal)
      ) {
        const taxesDiff = Math.abs(
          candidate.observedTaxesTotal - oceanreefDirect.taxesTotal,
        );
        if (taxesDiff > tolerance) {
          return {
            listingId: candidate.listingId,
            startDate: candidate.startDate,
            endDate: candidate.endDate,
            observedGrandTotal: candidate.observedGrandTotal,
            handoffUrl: candidate.handoffUrl,
            code: "component_mismatch",
            message: `Oceanreef taxes mismatch observed=${candidate.observedTaxesTotal.toFixed(2)} checkout_taxes=${oceanreefDirect.taxesTotal.toFixed(2)} (diff=${taxesDiff.toFixed(2)})`,
            extractedTotal: oceanreefDirect.total,
          };
        }
      }

      return null;
    }

    if (oceanreefDirect.kind === "status_error") {
      return {
        listingId: candidate.listingId,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        observedGrandTotal: candidate.observedGrandTotal,
        handoffUrl: candidate.handoffUrl,
        code: "direct_status_error",
        message: `oceanreef pricesummary returned availability/status error: ${oceanreefDirect.message}`,
        extractedTotal: null,
      };
    }

    if (oceanreefDirect.kind === "request_error") {
      return {
        listingId: candidate.listingId,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        observedGrandTotal: candidate.observedGrandTotal,
        handoffUrl: candidate.handoffUrl,
        code: "request_error",
        message: `oceanreef pricesummary extraction failed: ${oceanreefDirect.message}`,
        extractedTotal: null,
      };
    }
  }

  const signedHandoff = await tryExtractSignedHandoffTotal(
    candidate,
    reportProgress,
  );
  if (signedHandoff.kind === "success") {
    const diff = Math.abs(signedHandoff.total - candidate.observedGrandTotal);
    if (diff > tolerance) {
      return {
        listingId: candidate.listingId,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        observedGrandTotal: candidate.observedGrandTotal,
        handoffUrl: candidate.handoffUrl,
        code: "grand_total_mismatch",
        message: `Observed grand_total=${candidate.observedGrandTotal.toFixed(2)} differs from signed handoff total=${signedHandoff.total.toFixed(2)} (diff=${diff.toFixed(2)})`,
        extractedTotal: signedHandoff.total,
      };
    }
    return null;
  }

  const beachblueCheckout = await tryExtractBeachblueCheckoutTotal(
    candidate,
    reportProgress,
  );
  if (beachblueCheckout.kind === "success") {
    const diff = Math.abs(
      beachblueCheckout.total - candidate.observedGrandTotal,
    );
    if (diff > tolerance) {
      return {
        listingId: candidate.listingId,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        observedGrandTotal: candidate.observedGrandTotal,
        handoffUrl: candidate.handoffUrl,
        code: "grand_total_mismatch",
        message: `Observed grand_total=${candidate.observedGrandTotal.toFixed(2)} differs from beachblue checkout total=${beachblueCheckout.total.toFixed(2)} (diff=${diff.toFixed(2)})`,
        extractedTotal: beachblueCheckout.total,
      };
    }
    return null;
  }

  if (beachblueCheckout.kind === "request_error") {
    return {
      listingId: candidate.listingId,
      startDate: candidate.startDate,
      endDate: candidate.endDate,
      observedGrandTotal: candidate.observedGrandTotal,
      handoffUrl: candidate.handoffUrl,
      code: "request_error",
      message: `beachblue checkout extraction failed: ${beachblueCheckout.message}`,
      extractedTotal: null,
    };
  }

  if (escapesDirect.kind === "status_error") {
    return {
      listingId: candidate.listingId,
      startDate: candidate.startDate,
      endDate: candidate.endDate,
      observedGrandTotal: candidate.observedGrandTotal,
      handoffUrl: candidate.handoffUrl,
      code: "direct_status_error",
      message: `Direct total endpoint returned availability/status error: ${escapesDirect.message}`,
      extractedTotal: null,
    };
  }

  // For 30aescapes, only trust the booking AJAX endpoint.
  // Do not fall back to generic HTML scraping because the UI contains
  // strikeouts and partial-payment rows (e.g. Due Today) that are not
  // canonical grand totals.
  if (candidate.adapterKey === "30aescapes") {
    if (escapesDirect.kind === "request_error") {
      return {
        listingId: candidate.listingId,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        observedGrandTotal: candidate.observedGrandTotal,
        handoffUrl: candidate.handoffUrl,
        code: "request_error",
        message: `30aescapes direct total request failed: ${escapesDirect.message}`,
        extractedTotal: null,
      };
    }
    return {
      listingId: candidate.listingId,
      startDate: candidate.startDate,
      endDate: candidate.endDate,
      observedGrandTotal: candidate.observedGrandTotal,
      handoffUrl: candidate.handoffUrl,
      code: "total_not_found",
      message:
        "30aescapes direct total endpoint returned no extractable Total Amount",
      extractedTotal: null,
    };
  }

  let parsedHandoff: URL | null = null;
  try {
    parsedHandoff = new URL(candidate.handoffUrl);
  } catch {
    parsedHandoff = null;
  }
  const isThirtyAEscapes =
    parsedHandoff?.hostname.endsWith("30aescapes.com") === true &&
    parsedHandoff?.pathname.includes("/rentals/book-now.cfm") === true;

  if (isThirtyAEscapes) {
    return {
      listingId: candidate.listingId,
      startDate: candidate.startDate,
      endDate: candidate.endDate,
      observedGrandTotal: candidate.observedGrandTotal,
      handoffUrl: candidate.handoffUrl,
      code: "request_error",
      message:
        escapesDirect.kind === "request_error"
          ? `30aescapes direct total extraction failed: ${escapesDirect.message}`
          : "30aescapes direct total extraction unavailable",
      extractedTotal: null,
    };
  }

  const direct = await tryExtractDirectStreamlineTotal(
    candidate,
    reportProgress,
  );
  if (direct.kind === "success") {
    const diff = Math.abs(direct.total - candidate.observedGrandTotal);
    if (diff > tolerance) {
      return {
        listingId: candidate.listingId,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        observedGrandTotal: candidate.observedGrandTotal,
        handoffUrl: candidate.handoffUrl,
        code: "grand_total_mismatch",
        message: `Observed grand_total=${candidate.observedGrandTotal.toFixed(2)} differs from direct total=${direct.total.toFixed(2)} (diff=${diff.toFixed(2)})`,
        extractedTotal: direct.total,
      };
    }
    return null;
  }

  if (direct.kind === "status_error") {
    return {
      listingId: candidate.listingId,
      startDate: candidate.startDate,
      endDate: candidate.endDate,
      observedGrandTotal: candidate.observedGrandTotal,
      handoffUrl: candidate.handoffUrl,
      code: "direct_status_error",
      message: `Direct total endpoint returned availability/status error: ${direct.message}`,
      extractedTotal: null,
    };
  }

  try {
    const responseResult = await fetchWithRetry({
      url: candidate.handoffUrl,
      init: {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "user-agent": USER_AGENT,
          referer: candidate.detailUrl,
        },
      },
      retryDelaysMs: getHandoffRetryDelaysMs(candidate.adapterKey),
      reportProgress,
      retryLabel: "handoff page",
    });

    if (!responseResult.ok) {
      return {
        listingId: candidate.listingId,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        observedGrandTotal: candidate.observedGrandTotal,
        handoffUrl: candidate.handoffUrl,
        code: "request_error",
        message: responseResult.message,
        extractedTotal: null,
      };
    }

    const response = responseResult.response;

    const html = await response.text();
    const totalCandidates = extractCandidateTotals(html);
    const best = pickClosestTotal(
      totalCandidates,
      candidate.observedGrandTotal,
    );

    if (!best) {
      return {
        listingId: candidate.listingId,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        observedGrandTotal: candidate.observedGrandTotal,
        handoffUrl: candidate.handoffUrl,
        code: "total_not_found",
        message: "Could not extract checkout total from handoff HTML",
        extractedTotal: null,
      };
    }

    if (best.diff > tolerance) {
      return {
        listingId: candidate.listingId,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        observedGrandTotal: candidate.observedGrandTotal,
        handoffUrl: candidate.handoffUrl,
        code: "grand_total_mismatch",
        message: `Observed grand_total=${candidate.observedGrandTotal.toFixed(2)} differs from extracted total=${best.total.toFixed(2)} (diff=${best.diff.toFixed(2)})`,
        extractedTotal: best.total,
      };
    }

    return null;
  } catch (error: unknown) {
    return {
      listingId: candidate.listingId,
      startDate: candidate.startDate,
      endDate: candidate.endDate,
      observedGrandTotal: candidate.observedGrandTotal,
      handoffUrl: candidate.handoffUrl,
      code: "request_error",
      message: error instanceof Error ? error.message : String(error),
      extractedTotal: null,
    };
  }
}

function collectCandidates(
  sidecar: CanonicalQuotesSidecarRecord,
  maxObservations: number,
  minLeadDays: number,
  utcTodayStartMs: number,
): ObservationCandidate[] {
  const listingId = sidecar.external_listing_id || "unknown";
  const detailUrl = sidecar.detail_url;

  const availableObservations = sidecar.observations.filter(
    (observation) =>
      observation.quote_available === true &&
      typeof observation.grand_total === "number" &&
      Number.isFinite(observation.grand_total) &&
      typeof observation.handoff_url === "string" &&
      observation.handoff_url.length > 0,
  );

  const leadFilteredObservations =
    minLeadDays > 0
      ? availableObservations.filter((observation) => {
          const leadDays = getLeadDaysFromUtcToday(
            observation.start_date,
            utcTodayStartMs,
          );
          return leadDays !== null && leadDays >= minLeadDays;
        })
      : availableObservations;

  const selectedObservations =
    minLeadDays > 0 && leadFilteredObservations.length === 0
      ? availableObservations
      : leadFilteredObservations;

  return selectedObservations.slice(0, maxObservations).map((observation) => ({
    adapterKey: sidecar.adapter_key,
    listingId,
    detailUrl,
    startDate: observation.start_date,
    endDate: observation.end_date,
    observedGrandTotal: observation.grand_total as number,
    observedBaseTotal:
      typeof observation.base_total === "number" &&
      Number.isFinite(observation.base_total)
        ? observation.base_total
        : null,
    observedTaxesTotal:
      typeof observation.taxes_total === "number" &&
      Number.isFinite(observation.taxes_total)
        ? observation.taxes_total
        : null,
    handoffUrl: observation.handoff_url as string,
  }));
}

function printFailures(failures: ValidationFailure[]): void {
  for (const failure of failures.slice(0, 40)) {
    console.error(
      `${chalk.red("listing=")}${chalk.bold(failure.listingId)} ${chalk.red("window=")}${failure.startDate}->${failure.endDate} ${chalk.red("code=")}${failure.code}`,
    );
    console.error(`  ${chalk.yellow(failure.message)}`);
    console.error(
      `  observed_grand_total=${failure.observedGrandTotal.toFixed(2)} extracted_total=${failure.extractedTotal === null ? "n/a" : failure.extractedTotal.toFixed(2)}`,
    );
    console.error(`  handoff_url=${failure.handoffUrl}`);
  }

  if (failures.length > 40) {
    console.error(chalk.yellow(`... ${failures.length - 40} more failure(s)`));
  }
}

export async function runValidateQuoteHandoffAlignmentCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArgs(argv);
  const progress = createScrapeProgress({
    script: `${options.adapterKey}-handoff-qa`,
  });
  const root = process.cwd();
  const quotesDir = resolve(
    root,
    "src",
    "lib",
    "data",
    "external-sources",
    options.adapterKey,
    "details",
    "quotes",
  );

  const files = await collectQuoteFiles(
    quotesDir,
    options.listingId,
    options.maxListings,
  );

  if (files.length === 0) {
    progress.failure(
      `No quote sidecar files selected for adapter=${options.adapterKey}.`,
    );
    return 1;
  }

  const candidates: ObservationCandidate[] = [];
  const utcTodayStartMs = getUtcTodayStartMs();

  for (const fileName of files) {
    const filePath = resolve(quotesDir, fileName);
    const raw = await readFile(filePath, "utf8");
    let sidecar: CanonicalQuotesSidecarRecord;
    try {
      sidecar = JSON.parse(raw) as CanonicalQuotesSidecarRecord;
    } catch {
      continue;
    }

    candidates.push(
      ...collectCandidates(
        sidecar,
        options.maxObservations,
        options.minLeadDays,
        utcTodayStartMs,
      ),
    );
  }

  if (candidates.length === 0) {
    progress.failure(
      `No quote_available observations with handoff URLs found for adapter=${options.adapterKey}.`,
    );
    return 1;
  }

  progress.phase(
    `Running handoff alignment validation adapter=${options.adapterKey} observations=${candidates.length} min_lead_days=${options.minLeadDays} tolerance=${options.tolerance.toFixed(2)}`,
  );

  let completed = 0;
  const startedAt = Date.now();

  const failures = (
    await runWithConcurrency(
      candidates,
      options.concurrency,
      async (candidate) => {
        const result = await validateObservation(
          candidate,
          options.tolerance,
          (message) => {
            progress.tick(
              `adapter=${options.adapterKey} listing=${candidate.listingId} window=${candidate.startDate}->${candidate.endDate} ${message}`,
            );
          },
        );
        completed += 1;
        const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        const outcome = result === null ? "match" : `fail:${result.code}`;
        progress.progress(
          `progress adapter=${options.adapterKey} ${completed}/${candidates.length} listing=${candidate.listingId} window=${candidate.startDate}->${candidate.endDate} outcome=${outcome} elapsed_s=${elapsedSeconds}`,
        );
        return result;
      },
    )
  ).filter((failure): failure is ValidationFailure => failure !== null);

  const result: ValidationResult = {
    tested: candidates.length,
    matched: candidates.length - failures.length,
    failures,
  };

  if (result.failures.length > 0) {
    progress.failure(
      `Handoff alignment failed for adapter=${options.adapterKey} tested=${result.tested} matched=${result.matched} failed=${result.failures.length}`,
    );
    printFailures(result.failures);
    return 1;
  }

  progress.success(
    `Handoff alignment passed for adapter=${options.adapterKey} tested=${result.tested} matched=${result.matched} failed=0`,
  );

  return 0;
}

let exiting = false;
process.on("SIGINT", () => {
  if (exiting) {
    process.exit(130);
  }
  exiting = true;
  process.stderr.write("Operation cancelled by user.\n");
  process.exit(130);
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runValidateQuoteHandoffAlignmentCli()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Handoff alignment validator failed: ${message}\n`);
      process.exit(1);
    });
}
