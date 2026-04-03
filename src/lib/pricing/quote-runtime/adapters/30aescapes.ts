import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type EscapesQuoteContext = {
  propertyId: string;
  detailUrl: string | null;
};

type BookNowTotals = {
  quotedTotal: number | null;
  baseTotal: number | null;
  taxesTotal: number | null;
  unavailable: boolean;
};

const ADAPTER_KEY = "30aescapes" as const;
const BASE_HOST = "https://www.30aescapes.com";
const DEFAULT_TIMEOUT_MS = 20000;

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function parseMoney(value: string): number | null {
  const parsed = Number(value.replace(/,/g, "").trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return roundCurrency(parsed);
}

function extractTableLabelAmount(html: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<td[^>]*>\\s*${escaped}\\s*<\\/td>\\s*<td[^>]*>\\s*\\$\\s*([0-9,]+(?:\\.[0-9]{2})?)\\s*<\\/td>`,
    "i",
  );
  const match = html.match(pattern);
  return match?.[1] ? parseMoney(match[1]) : null;
}

function extractScriptValueAmount(
  html: string,
  fieldId: string,
): number | null {
  const escaped = fieldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    String.raw`\$\(\s*['"]#${escaped}['"]\s*\)\.val\(\s*['"]([0-9,]+(?:\.[0-9]{2})?)['"]\s*\)`,
    "i",
  );
  const value = html.match(pattern)?.[1];
  return value ? parseMoney(value) : null;
}

function parseSetCookieHeader(setCookie: string): string[] {
  if (!setCookie) {
    return [];
  }

  return setCookie
    .split(/,(?=\s*[A-Za-z0-9_.-]+=)/g)
    .map((item) => item.trim())
    .filter(Boolean);
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
    if (name) {
      cookieMap.set(name, value);
    }
  }

  return [...cookieMap.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function extractEscapesAjaxPath(html: string): string {
  const match = html.match(/(["'])([^"']*get-booknow-rates\.cfm[^"']*)\1/i);
  const extracted = match?.[2]?.trim();
  if (!extracted) {
    return "/rentals/ajax/get-booknow-rates.cfm";
  }

  if (extracted.startsWith("http://") || extracted.startsWith("https://")) {
    try {
      return new URL(extracted).pathname;
    } catch {
      return "/rentals/ajax/get-booknow-rates.cfm";
    }
  }

  if (extracted.startsWith("/")) {
    return extracted;
  }

  if (extracted.startsWith("ajax/")) {
    return `/rentals/${extracted}`;
  }

  return "/rentals/ajax/get-booknow-rates.cfm";
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

  return [0, 1000, 2500, 5000, 9000];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

function toError(input: {
  code: string;
  message: string;
  retryable: boolean;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  details?: Record<string, unknown>;
}) {
  return {
    code: input.code,
    message: input.message,
    retryable: input.retryable,
    details: {
      adapterKey: ADAPTER_KEY,
      listingId: input.listingId,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      ...(input.details ?? {}),
    },
  };
}

function extractQuoteContext(
  input: QuoteExecutionRequest,
): EscapesQuoteContext {
  const context = input.quoteContext;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new Error(
      `Missing required quoteContext.property_id for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const propertyIdRaw =
    typeof context.property_id === "string" ? context.property_id.trim() : "";
  if (!propertyIdRaw) {
    throw new Error(
      `Missing required quoteContext.property_id for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const detailUrlRaw =
    typeof context.detail_url === "string" ? context.detail_url.trim() : "";

  return {
    propertyId: propertyIdRaw,
    detailUrl: detailUrlRaw || null,
  };
}

function buildHandoffUrl(input: {
  propertyId: string;
  checkInIso: string;
  checkOutIso: string;
}): string {
  return `${BASE_HOST}/rentals/book-now.cfm?propertyid=${encodeURIComponent(input.propertyId)}&strcheckin=${encodeURIComponent(toUsDate(input.checkInIso))}&strcheckout=${encodeURIComponent(toUsDate(input.checkOutIso))}`;
}

async function fetchEscapesBookNowTotals(input: {
  handoffUrl: string;
  refererUrl: string | null;
  timeoutMs: number;
}): Promise<BookNowTotals> {
  let handoff: URL;
  try {
    handoff = new URL(input.handoffUrl, BASE_HOST);
  } catch {
    return {
      quotedTotal: null,
      baseTotal: null,
      taxesTotal: null,
      unavailable: false,
    };
  }

  const propertyid = handoff.searchParams.get("propertyid")?.trim() ?? "";
  const strcheckin = handoff.searchParams.get("strcheckin")?.trim() ?? "";
  const strcheckout = handoff.searchParams.get("strcheckout")?.trim() ?? "";
  if (!propertyid || !strcheckin || !strcheckout) {
    return {
      quotedTotal: null,
      baseTotal: null,
      taxesTotal: null,
      unavailable: false,
    };
  }

  const parseAjaxPayload = (ajaxHtml: string): BookNowTotals => {
    const lowered = ajaxHtml.toLowerCase();
    if (
      lowered.includes("property is not available") ||
      lowered.includes("unit has no availability")
    ) {
      return {
        quotedTotal: null,
        baseTotal: null,
        taxesTotal: null,
        unavailable: true,
      };
    }

    const quotedTotal =
      extractTableLabelAmount(ajaxHtml, "Total Amount") ??
      extractScriptValueAmount(ajaxHtml, "BookingValue");
    const taxesTotal =
      extractTableLabelAmount(ajaxHtml, "Taxes") ??
      extractScriptValueAmount(ajaxHtml, "TaxValue");
    const baseTotal =
      extractTableLabelAmount(ajaxHtml, "Rent") ??
      (quotedTotal !== null && taxesTotal !== null
        ? roundCurrency(quotedTotal - taxesTotal)
        : null);

    return {
      quotedTotal,
      baseTotal,
      taxesTotal,
      unavailable: false,
    };
  };

  try {
    const handoffController = new AbortController();
    const handoffTimer = setTimeout(
      () => handoffController.abort(),
      input.timeoutMs,
    );

    let handoffResponse: Response;
    try {
      handoffResponse = await fetch(handoff.toString(), {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "user-agent": "Mozilla/5.0",
          ...(input.refererUrl ? { referer: input.refererUrl } : {}),
        },
        signal: handoffController.signal,
      });
    } finally {
      clearTimeout(handoffTimer);
    }

    if (!handoffResponse.ok) {
      return {
        quotedTotal: null,
        baseTotal: null,
        taxesTotal: null,
        unavailable: false,
      };
    }

    const handoffHtml = await handoffResponse.text();
    const cookieHeader = buildCookieHeader(
      parseSetCookieHeader(handoffResponse.headers.get("set-cookie") ?? ""),
    );

    const ajaxPath = extractEscapesAjaxPath(handoffHtml);
    const ajaxUrl = new URL(ajaxPath, handoff.origin);
    ajaxUrl.searchParams.set("propertyid", propertyid);
    ajaxUrl.searchParams.set("strcheckin", strcheckin);
    ajaxUrl.searchParams.set("strcheckout", strcheckout);
    ajaxUrl.searchParams.set("_", String(Date.now()));

    const attemptDelaysMs = parseRetryDelaysMs(
      process.env.ESCAPES30A_QUOTE_AJAX_RETRY_DELAYS_MS ?? "",
    );

    for (
      let attemptIndex = 0;
      attemptIndex < attemptDelaysMs.length;
      attemptIndex += 1
    ) {
      const delayMs = attemptDelaysMs[attemptIndex] ?? 0;
      if (delayMs > 0) {
        await sleep(delayMs);
      }

      ajaxUrl.searchParams.set("_", String(Date.now()));

      const ajaxController = new AbortController();
      const ajaxTimer = setTimeout(
        () => ajaxController.abort(),
        input.timeoutMs,
      );

      let ajaxResponse: Response;
      try {
        ajaxResponse = await fetch(ajaxUrl.toString(), {
          headers: {
            accept: "text/html, */*;q=0.1",
            "x-requested-with": "XMLHttpRequest",
            "user-agent": "Mozilla/5.0",
            referer: handoff.toString(),
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
          },
          signal: ajaxController.signal,
        });
      } finally {
        clearTimeout(ajaxTimer);
      }

      if (!ajaxResponse.ok) {
        if (attemptIndex < attemptDelaysMs.length - 1) {
          continue;
        }

        return {
          quotedTotal: null,
          baseTotal: null,
          taxesTotal: null,
          unavailable: false,
        };
      }

      const ajaxHtml = await ajaxResponse.text();
      const parsed = parseAjaxPayload(ajaxHtml);
      if (parsed.unavailable || parsed.quotedTotal !== null) {
        return parsed;
      }

      if (attemptIndex < attemptDelaysMs.length - 1) {
        continue;
      }
    }

    return {
      quotedTotal: null,
      baseTotal: null,
      taxesTotal: null,
      unavailable: false,
    };
  } catch {
    return {
      quotedTotal: null,
      baseTotal: null,
      taxesTotal: null,
      unavailable: false,
    };
  }
}

export async function execute30AEscapesSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  let quoteContext: EscapesQuoteContext;
  try {
    quoteContext = extractQuoteContext(input);
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_CONTEXT_MISSING",
        message:
          error instanceof Error ? error.message : "Missing quote context",
        retryable: false,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
      }),
    };
  }

  const handoffUrl = buildHandoffUrl({
    propertyId: quoteContext.propertyId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
  });

  const checkoutFirst = await fetchEscapesBookNowTotals({
    handoffUrl,
    refererUrl: quoteContext.detailUrl,
    timeoutMs,
  });

  if (checkoutFirst.unavailable) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_UNAVAILABLE",
        message: "Quote unavailable for selected stay window",
        retryable: false,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
      }),
    };
  }

  if (checkoutFirst.quotedTotal === null) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_RESPONSE_INCOMPLETE",
        message: "Checkout total unavailable from 30aescapes quote flow",
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
      }),
    };
  }

  const baseTotal = checkoutFirst.baseTotal;
  const taxesTotal = checkoutFirst.taxesTotal;
  const quotedTotal = checkoutFirst.quotedTotal;
  const grandTotal = quotedTotal;

  const feesTotalExclTaxes =
    baseTotal !== null && taxesTotal !== null
      ? roundCurrency(Math.max(0, grandTotal - baseTotal - taxesTotal))
      : null;

  return {
    success: true,
    elapsedMs: performance.now() - startedAt,
    observation: {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: true,
      currency: "USD",
      baseTotal,
      taxesTotal,
      feesTotalExclTaxes,
      grandTotal,
      quotedTotal,
      handoffUrl,
    },
  };
}
