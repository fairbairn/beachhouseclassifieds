import "@/core/tooling/env/load-env-profile";

import { launch as launchCloakBrowser } from "cloakbrowser";
import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

const ADAPTER_KEY = "stayon30a" as const;
const ENV_PREFIX = "STAYON30A" as const;
const DEFAULT_TIMEOUT_MS = 20000;
const MIN_VALID_BASE_TOTAL = 100;
const DEFAULT_ENDPOINT_PATH = "/wp-json/homelocal/v1/quotes";

type HomeLocalRatePlan = {
  id?: unknown;
  currency?: unknown;
  total?: unknown;
  totalUsd?: unknown;
  totalTaxesUsd?: unknown;
  totalFeesUsd?: unknown;
  total_taxes?: unknown;
  total_fees?: unknown;
  totalRentDiscounted?: unknown;
  totalRentDiscountedUsd?: unknown;
  total_rent?: unknown;
  subTotalUsd?: unknown;
  sub_total?: unknown;
};

type HomeLocalQuoteResponse = {
  id?: unknown;
  code?: unknown;
  message?: unknown;
  rateplans?: unknown;
};

type BrowserRequestResponseLike = {
  ok(): boolean;
  status(): number;
  text(): Promise<string>;
};

type BrowserRequestClientLike = {
  post(
    endpoint: string,
    options: {
      headers: Record<string, string>;
      data: string;
      timeout: number;
    },
  ): Promise<BrowserRequestResponseLike>;
};

type BrowserPageLike = {
  goto(
    url: string,
    options: { waitUntil: "commit" | "domcontentloaded"; timeout: number },
  ): Promise<unknown>;
  close(): Promise<void>;
};

type BrowserContextLike = {
  request: BrowserRequestClientLike;
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
};

type BrowserLike = {
  newContext(options: {
    userAgent: string;
    ignoreHTTPSErrors: boolean;
  }): Promise<BrowserContextLike>;
  close(): Promise<void>;
};

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.-]/g, "").trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function toPositiveIntString(value: unknown): string | null {
  const parsed =
    typeof value === "string" ? Number(value.trim()) : Number(value ?? NaN);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return String(Math.floor(parsed));
}

function toOpaqueIdString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return String(Math.floor(value));
  }
  return null;
}

function readToggle(name: string, defaultEnabled = true): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultEnabled;
  }
  return raw !== "0";
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

function buildHandoffUrl(input: {
  detailUrl: string;
  checkInIso: string;
  checkOutIso: string;
}): string {
  const parsed = new URL(input.detailUrl);
  parsed.searchParams.set("checkin", input.checkInIso);
  parsed.searchParams.set("checkout", input.checkOutIso);
  return parsed.toString();
}

function buildCheckoutHandoffUrl(input: {
  detailUrl: string;
  quoteId: string | null;
  ratePlanId: string | null;
}): string | null {
  if (!input.quoteId || !input.ratePlanId) {
    return null;
  }
  const detailParsed = new URL(input.detailUrl);
  const checkout = new URL("/checkout/", detailParsed.origin);
  checkout.searchParams.set("qid", input.quoteId);
  checkout.searchParams.set("rpid", input.ratePlanId);
  return checkout.toString();
}

function extractQuoteContext(input: QuoteExecutionRequest): {
  propertyId: string;
  detailUrl: string;
  endpointUrl: string;
  origin: string;
} {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? input.quoteContext
      : null;

  const propertyId =
    toPositiveIntString(context?.property_id) ??
    toPositiveIntString(context?.listing_id) ??
    toPositiveIntString(context?.unit_id);
  if (!propertyId) {
    throw new Error(
      `Missing required quoteContext.property_id/listing_id for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const detailUrl =
    typeof context?.detail_url === "string" ? context.detail_url.trim() : "";
  if (!detailUrl) {
    throw new Error(
      `Missing required quoteContext.detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const origin = new URL(detailUrl).origin;
  return {
    propertyId,
    detailUrl,
    endpointUrl: `${origin}${DEFAULT_ENDPOINT_PATH}`,
    origin,
  };
}

function parseRatePlan(
  payload: HomeLocalQuoteResponse,
): HomeLocalRatePlan | null {
  if (!Array.isArray(payload.rateplans)) {
    return null;
  }
  const first = payload.rateplans[0];
  if (!first || typeof first !== "object") {
    return null;
  }
  return first as HomeLocalRatePlan;
}

function validateAvailableTotals(input: {
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotal: number | null;
  grandTotal: number | null;
}): string | null {
  if (input.baseTotal === null || input.baseTotal < MIN_VALID_BASE_TOTAL) {
    return `base_total_below_minimum(${MIN_VALID_BASE_TOTAL})`;
  }
  if (input.taxesTotal === null || input.taxesTotal <= 0) {
    return "taxes_total_not_positive";
  }
  if (input.feesTotal === null || input.feesTotal < 0) {
    return "fees_total_invalid";
  }
  if (input.grandTotal === null || input.grandTotal <= input.baseTotal) {
    return "grand_total_not_greater_than_base_total";
  }
  return null;
}

export async function executeStayon30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  let contextData: {
    propertyId: string;
    detailUrl: string;
    endpointUrl: string;
    origin: string;
  };
  try {
    contextData = extractQuoteContext(input);
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
    detailUrl: contextData.detailUrl,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
  });

  const headless = readToggle(`${ENV_PREFIX}_HEADLESS`, true);
  const userAgent =
    process.env[`${ENV_PREFIX}_USER_AGENT`]?.trim() ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  let browser: BrowserLike | null = null;
  let context: BrowserContextLike | null = null;
  try {
    browser = (await launchCloakBrowser({
      headless,
    })) as unknown as BrowserLike;
    context = await browser.newContext({
      userAgent,
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();
    try {
      await page.goto(contextData.detailUrl, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(120000, Math.max(timeoutMs * 2, 15000)),
      });
    } finally {
      await page.close();
    }

    const guests = Math.max(
      1,
      Math.floor(input.adults) + Math.floor(input.children),
    );
    const response = await context.request.post(contextData.endpointUrl, {
      headers: {
        accept: "application/json,text/plain,*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        referer: contextData.detailUrl,
        origin: contextData.origin,
        "x-requested-with": "XMLHttpRequest",
      },
      data: new URLSearchParams({
        checkin: input.checkInIso,
        checkout: input.checkOutIso,
        guests: String(guests),
        coupon: "",
        property_id: contextData.propertyId,
        traffic_source: "",
      }).toString(),
      timeout: timeoutMs,
    });

    const bodyText = await response.text();
    let payload: HomeLocalQuoteResponse | null = null;
    try {
      payload = JSON.parse(bodyText) as HomeLocalQuoteResponse;
    } catch {
      payload = null;
    }

    const ratePlanFromPayload = payload ? parseRatePlan(payload) : null;
    const quoteId = toOpaqueIdString(payload?.id);
    const ratePlanId = toOpaqueIdString(ratePlanFromPayload?.id);
    const checkoutHandoffUrl = buildCheckoutHandoffUrl({
      detailUrl: contextData.detailUrl,
      quoteId,
      ratePlanId,
    });
    const resolvedHandoffUrl = checkoutHandoffUrl ?? handoffUrl;

    if (!response.ok) {
      const message =
        asOptionalString(payload?.message) ??
        `HomeLocal quote request failed with status ${response.status()}`;
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_UNAVAILABLE",
          message,
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            detail_url: handoffUrl,
            handoff_url: resolvedHandoffUrl,
            endpointUrl: contextData.endpointUrl,
            propertyId: contextData.propertyId,
            quoteStatus: response.status(),
            serviceCode: asOptionalString(payload?.code),
            qid: quoteId,
            rpid: ratePlanId,
          },
        }),
      };
    }

    const ratePlan = ratePlanFromPayload;
    if (!ratePlan) {
      return {
        success: true,
        elapsedMs: performance.now() - startedAt,
        observation: {
          startDate: input.checkInIso,
          endDate: input.checkOutIso,
          quoteAvailable: false,
          quoteUnavailableReason:
            asOptionalString(payload?.message) ?? "missing_rateplan_data",
          currency: null,
          baseTotal: null,
          taxesTotal: null,
          feesTotalExclTaxes: null,
          grandTotal: null,
          quotedTotal: null,
          detailUrl: handoffUrl,
          handoffUrl: resolvedHandoffUrl,
        },
      };
    }

    const baseTotalRaw =
      toFiniteNumber(ratePlan.totalRentDiscounted) ??
      toFiniteNumber(ratePlan.totalRentDiscountedUsd) ??
      toFiniteNumber(ratePlan.total_rent) ??
      toFiniteNumber(ratePlan.subTotalUsd) ??
      toFiniteNumber(ratePlan.sub_total);
    const taxesTotalRaw =
      toFiniteNumber(ratePlan.totalTaxesUsd) ??
      toFiniteNumber(ratePlan.total_taxes);
    const feesTotalRaw =
      toFiniteNumber(ratePlan.totalFeesUsd) ??
      toFiniteNumber(ratePlan.total_fees) ??
      0;
    const grandTotalRaw =
      toFiniteNumber(ratePlan.totalUsd) ?? toFiniteNumber(ratePlan.total);

    const baseTotal =
      baseTotalRaw !== null && baseTotalRaw > 0
        ? roundCurrency(baseTotalRaw)
        : null;
    const taxesTotal =
      taxesTotalRaw !== null && taxesTotalRaw >= 0
        ? roundCurrency(taxesTotalRaw)
        : null;
    const feesTotal =
      feesTotalRaw !== null && feesTotalRaw >= 0
        ? roundCurrency(feesTotalRaw)
        : null;
    const grandTotal =
      grandTotalRaw !== null && grandTotalRaw > 0
        ? roundCurrency(grandTotalRaw)
        : null;

    const unavailableReason = validateAvailableTotals({
      baseTotal,
      taxesTotal,
      feesTotal,
      grandTotal,
    });
    const quoteAvailable = unavailableReason === null;

    return {
      success: true,
      elapsedMs: performance.now() - startedAt,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable,
        quoteUnavailableReason: unavailableReason,
        currency: asOptionalString(ratePlan.currency) ?? "USD",
        baseTotal: quoteAvailable ? baseTotal : null,
        taxesTotal: quoteAvailable ? taxesTotal : null,
        feesTotalExclTaxes: quoteAvailable ? feesTotal : null,
        grandTotal: quoteAvailable ? grandTotal : null,
        quotedTotal: quoteAvailable ? grandTotal : null,
        detailUrl: handoffUrl,
        handoffUrl: resolvedHandoffUrl,
      },
    };
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_REQUEST_FAILED",
        message:
          error instanceof Error ? error.message : "HomeLocal quote failed",
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          detail_url: handoffUrl,
          handoff_url: handoffUrl,
          endpointUrl: contextData.endpointUrl,
          propertyId: contextData.propertyId,
        },
      }),
    };
  } finally {
    if (context) {
      await context.close().catch(() => undefined);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
