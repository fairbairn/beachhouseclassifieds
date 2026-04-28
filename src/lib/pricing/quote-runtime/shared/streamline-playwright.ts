import { chromium, type BrowserContext } from "playwright";

import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

export type StreamlineEnvelope<TData = unknown> = {
  data?: TData;
  status?: {
    code?: unknown;
    description?: unknown;
  };
};

export type StreamlinePostResult<TData = unknown> = {
  httpStatus: number;
  ok: boolean;
  payload: StreamlineEnvelope<TData> | null;
  bodyText: string;
  requestError: string | null;
  parseError: string | null;
};

export async function postStreamlineApiRequest<TData = unknown>(input: {
  context: BrowserContext;
  endpoint: string;
  detailUrl: string;
  origin: string;
  methodName: string;
  params: Record<string, unknown>;
  timeoutMs: number;
}): Promise<StreamlinePostResult<TData>> {
  try {
    const response = await input.context.request.post(input.endpoint, {
      headers: {
        accept: "application/json,text/plain,*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        referer: input.detailUrl,
        origin: input.origin,
        "x-requested-with": "XMLHttpRequest",
      },
      data: new URLSearchParams({
        action: "streamlinecore-api-request",
        params: JSON.stringify({
          methodName: input.methodName,
          params: input.params,
        }),
      }).toString(),
      timeout: input.timeoutMs,
    });

    const bodyText = await response.text();
    let payload: StreamlineEnvelope<TData> | null = null;
    let parseError: string | null = null;

    try {
      payload = JSON.parse(bodyText) as StreamlineEnvelope<TData>;
    } catch (error: unknown) {
      parseError = error instanceof Error ? error.message : "Invalid JSON";
    }

    return {
      httpStatus: response.status(),
      ok: response.ok(),
      payload,
      bodyText,
      requestError: null,
      parseError,
    };
  } catch (error: unknown) {
    return {
      httpStatus: 0,
      ok: false,
      payload: null,
      bodyText: "",
      requestError:
        error instanceof Error
          ? error.message
          : "Unknown browser request error",
      parseError: null,
    };
  }
}

type StreamlineQuoteContext = {
  listingId: string;
  detailUrl: string;
  endpointUrl: string;
  origin: string;
};

type StreamlineFee = {
  value?: unknown;
};

type StreamlinePreReservationPayload = {
  price?: unknown;
  taxes?: unknown;
  total?: unknown;
  currency?: unknown;
  required_fees?: unknown;
  taxes_details?: unknown;
};

const DEFAULT_ENDPOINT_PATH = "/wp-admin/admin-ajax.php";
const DEFAULT_TIMEOUT_MS = 20000;

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

function toPositiveIntString(value: unknown): string | null {
  const parsed =
    typeof value === "string" ? Number(value.trim()) : Number(value ?? NaN);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return String(Math.floor(parsed));
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

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

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

function extractQuoteContext(
  input: QuoteExecutionRequest,
  adapterKey: string,
): StreamlineQuoteContext {
  const context = input.quoteContext;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new Error(
      `Missing required quoteContext for ${adapterKey} listing ${input.listingId}`,
    );
  }

  const listingId =
    toPositiveIntString(context.listing_id) ??
    toPositiveIntString(context.unit_id);
  if (!listingId) {
    throw new Error(
      `Missing required quoteContext.listing_id for ${adapterKey} listing ${input.listingId}`,
    );
  }

  const detailUrl =
    typeof context.detail_url === "string" ? context.detail_url.trim() : "";
  if (!detailUrl) {
    throw new Error(
      `Missing required quoteContext.detail_url for ${adapterKey} listing ${input.listingId}`,
    );
  }

  const origin = new URL(detailUrl).origin;

  return {
    listingId,
    detailUrl,
    endpointUrl: `${origin}${DEFAULT_ENDPOINT_PATH}`,
    origin,
  };
}

function buildCheckoutUrl(input: {
  detailUrl: string;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
}): string {
  const origin = new URL(input.detailUrl).origin;
  const params = new URLSearchParams();
  params.set("unit", input.listingId);
  params.set("sd", input.checkInIso);
  params.set("ed", input.checkOutIso);
  params.set("oc", String(Math.max(1, Math.floor(input.adults))));
  params.set("os", String(Math.max(0, Math.floor(input.children))));
  return `${origin}/checkout/?${params.toString()}`;
}

function toError(input: {
  adapterKey: string;
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
      adapterKey: input.adapterKey,
      listingId: input.listingId,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      ...(input.details ?? {}),
    },
  };
}

function buildStreamlineParams(input: {
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  availability: boolean;
}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    unit_id: Number(input.listingId),
    startdate: toUsDate(input.checkInIso),
    enddate: toUsDate(input.checkOutIso),
    occupants: String(Math.max(1, Math.floor(input.adults))),
    occupants_small: String(Math.max(0, Math.floor(input.children))),
    pets: "0",
    include_coupon_information: 1,
  };

  if (input.availability) {
    params.use_room_type_logic = 0;
  } else {
    params.optional_default_enabled = "yes";
  }

  return params;
}

function parsePricingTotals(data: StreamlinePreReservationPayload): {
  currency: string;
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotal: number | null;
  grandTotal: number | null;
} {
  const baseTotalRaw = toFiniteNumber(data.price);
  const nonBaseTotalRaw = toFiniteNumber(data.taxes);
  const grandTotalRaw = toFiniteNumber(data.total);

  const feesTotal = Array.isArray(data.required_fees)
    ? roundCurrency(
        (data.required_fees as StreamlineFee[]).reduce((sum, line) => {
          const amount = toFiniteNumber(line.value);
          return sum + (amount !== null && amount > 0 ? amount : 0);
        }, 0),
      )
    : null;

  const taxesDetailTotal = Array.isArray(data.taxes_details)
    ? roundCurrency(
        (data.taxes_details as StreamlineFee[]).reduce((sum, line) => {
          const amount = toFiniteNumber(line.value);
          return sum + (amount !== null && amount > 0 ? amount : 0);
        }, 0),
      )
    : null;

  let taxesTotal: number | null = taxesDetailTotal;
  if (taxesTotal === null && nonBaseTotalRaw !== null && feesTotal !== null) {
    taxesTotal = roundCurrency(Math.max(nonBaseTotalRaw - feesTotal, 0));
  }
  if (taxesTotal === null && nonBaseTotalRaw !== null && nonBaseTotalRaw > 0) {
    taxesTotal = roundCurrency(nonBaseTotalRaw);
  }

  const baseTotal =
    baseTotalRaw !== null && baseTotalRaw > 0
      ? roundCurrency(baseTotalRaw)
      : null;
  const grandTotal =
    grandTotalRaw !== null && grandTotalRaw > 0
      ? roundCurrency(grandTotalRaw)
      : null;

  return {
    currency: asOptionalString(data.currency) ?? "USD",
    baseTotal,
    taxesTotal,
    feesTotal,
    grandTotal,
  };
}

function readToggle(name: string, defaultEnabled = true): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultEnabled;
  }
  return raw !== "0";
}

export async function executeStreamlinePlaywrightQuote(input: {
  adapterKey: string;
  envPrefix: string;
  request: QuoteExecutionRequest;
}): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.request.options?.timeoutMs);

  let contextData: StreamlineQuoteContext;
  try {
    contextData = extractQuoteContext(input.request, input.adapterKey);
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        adapterKey: input.adapterKey,
        code: "QUOTE_CONTEXT_MISSING",
        message:
          error instanceof Error ? error.message : "Missing quote context",
        retryable: false,
        listingId: input.request.listingId,
        checkInIso: input.request.checkInIso,
        checkOutIso: input.request.checkOutIso,
      }),
    };
  }

  const handoffUrl = buildCheckoutUrl({
    detailUrl: contextData.detailUrl,
    listingId: contextData.listingId,
    checkInIso: input.request.checkInIso,
    checkOutIso: input.request.checkOutIso,
    adults: input.request.adults,
    children: input.request.children,
  });

  const headless = readToggle(`${input.envPrefix}_HEADLESS`, true);
  const pricingFirst = readToggle(`${input.envPrefix}_PRICING_FIRST`, true);
  const fallbackAvailability = readToggle(
    `${input.envPrefix}_FALLBACK_AVAILABILITY`,
    true,
  );
  const skipLanding = readToggle(`${input.envPrefix}_SKIP_LANDING`, true);
  const userAgent =
    process.env[`${input.envPrefix}_USER_AGENT`]?.trim() || null;

  const browser = await chromium.launch({ headless });

  try {
    const context = await browser.newContext({
      ...(userAgent ? { userAgent } : {}),
      ignoreHTTPSErrors: false,
    });

    let detailStatus: number | null = null;
    if (!skipLanding) {
      const page = await context.newPage();
      try {
        const response = await page.goto(contextData.detailUrl, {
          waitUntil: "commit",
          timeout: Math.max(1000, Math.floor(timeoutMs / 2)),
        });
        detailStatus = response?.status() ?? null;
      } catch (error: unknown) {
        return {
          success: false,
          elapsedMs: performance.now() - startedAt,
          error: toError({
            adapterKey: input.adapterKey,
            code: "QUOTE_REQUEST_FAILED",
            message:
              error instanceof Error
                ? `Detail page load failed: ${error.message}`
                : "Detail page load failed",
            retryable: true,
            listingId: input.request.listingId,
            checkInIso: input.request.checkInIso,
            checkOutIso: input.request.checkOutIso,
            details: {
              handoffUrl,
              detailUrl: contextData.detailUrl,
            },
          }),
        };
      }

      if (detailStatus !== null && detailStatus >= 400) {
        return {
          success: false,
          elapsedMs: performance.now() - startedAt,
          error: toError({
            adapterKey: input.adapterKey,
            code: "QUOTE_UNAVAILABLE",
            message: `Detail page load failed with status ${detailStatus}`,
            retryable: true,
            listingId: input.request.listingId,
            checkInIso: input.request.checkInIso,
            checkOutIso: input.request.checkOutIso,
            details: {
              handoffUrl,
              detailUrl: contextData.detailUrl,
              detailStatus,
            },
          }),
        };
      }
    }

    const pricingResponse =
      await postStreamlineApiRequest<StreamlinePreReservationPayload>({
        context,
        endpoint: contextData.endpointUrl,
        detailUrl: contextData.detailUrl,
        origin: contextData.origin,
        methodName: "GetPreReservationPrice",
        params: buildStreamlineParams({
          listingId: contextData.listingId,
          checkInIso: input.request.checkInIso,
          checkOutIso: input.request.checkOutIso,
          adults: input.request.adults,
          children: input.request.children,
          availability: false,
        }),
        timeoutMs,
      });

    if (pricingResponse.requestError || !pricingResponse.ok) {
      if (pricingFirst && fallbackAvailability) {
        const availabilityResponse = await postStreamlineApiRequest({
          context,
          endpoint: contextData.endpointUrl,
          detailUrl: contextData.detailUrl,
          origin: contextData.origin,
          methodName: "VerifyPropertyAvailability",
          params: buildStreamlineParams({
            listingId: contextData.listingId,
            checkInIso: input.request.checkInIso,
            checkOutIso: input.request.checkOutIso,
            adults: input.request.adults,
            children: input.request.children,
            availability: true,
          }),
          timeoutMs,
        });

        const availabilityCode = asOptionalString(
          availabilityResponse.payload?.status?.code,
        );

        return {
          success: false,
          elapsedMs: performance.now() - startedAt,
          error: toError({
            adapterKey: input.adapterKey,
            code: "QUOTE_UNAVAILABLE",
            message: availabilityResponse.requestError
              ? `Availability request failed: ${availabilityResponse.requestError}`
              : availabilityCode
                ? (asOptionalString(
                    availabilityResponse.payload?.status?.description,
                  ) ?? availabilityCode)
                : `VerifyPropertyAvailability failed with status ${availabilityResponse.httpStatus}`,
            retryable: true,
            listingId: input.request.listingId,
            checkInIso: input.request.checkInIso,
            checkOutIso: input.request.checkOutIso,
            details: {
              handoffUrl,
              detailStatus,
              pricingStatus: pricingResponse.httpStatus,
              availabilityStatus: availabilityResponse.httpStatus,
            },
          }),
        };
      }

      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          adapterKey: input.adapterKey,
          code: "QUOTE_UNAVAILABLE",
          message: pricingResponse.requestError
            ? `Quote request failed: ${pricingResponse.requestError}`
            : `Quote request failed with status ${pricingResponse.httpStatus}`,
          retryable: true,
          listingId: input.request.listingId,
          checkInIso: input.request.checkInIso,
          checkOutIso: input.request.checkOutIso,
          details: {
            handoffUrl,
            detailStatus,
            pricingStatus: pricingResponse.httpStatus,
          },
        }),
      };
    }

    const pricingCode = asOptionalString(pricingResponse.payload?.status?.code);
    if (pricingCode) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          adapterKey: input.adapterKey,
          code: "QUOTE_UNAVAILABLE",
          message:
            asOptionalString(pricingResponse.payload?.status?.description) ??
            pricingCode,
          retryable: true,
          listingId: input.request.listingId,
          checkInIso: input.request.checkInIso,
          checkOutIso: input.request.checkOutIso,
          details: {
            handoffUrl,
            detailStatus,
            pricingStatus: pricingResponse.httpStatus,
          },
        }),
      };
    }

    const pricingPayload = pricingResponse.payload?.data;
    if (!pricingPayload) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          adapterKey: input.adapterKey,
          code: "QUOTE_RESPONSE_INCOMPLETE",
          message: "Quote response missing pricing payload",
          retryable: true,
          listingId: input.request.listingId,
          checkInIso: input.request.checkInIso,
          checkOutIso: input.request.checkOutIso,
          details: {
            handoffUrl,
            detailStatus,
            pricingStatus: pricingResponse.httpStatus,
          },
        }),
      };
    }

    const totals = parsePricingTotals(pricingPayload);
    if (
      totals.baseTotal === null ||
      totals.grandTotal === null ||
      totals.grandTotal <= totals.baseTotal
    ) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          adapterKey: input.adapterKey,
          code: "QUOTE_RESPONSE_INCOMPLETE",
          message: "Quote response is missing expected totals",
          retryable: true,
          listingId: input.request.listingId,
          checkInIso: input.request.checkInIso,
          checkOutIso: input.request.checkOutIso,
          details: {
            handoffUrl,
            detailStatus,
            pricingStatus: pricingResponse.httpStatus,
          },
        }),
      };
    }

    return {
      success: true,
      elapsedMs: performance.now() - startedAt,
      observation: {
        startDate: input.request.checkInIso,
        endDate: input.request.checkOutIso,
        quoteAvailable: true,
        currency: totals.currency,
        baseTotal: totals.baseTotal,
        taxesTotal: totals.taxesTotal,
        feesTotalExclTaxes: totals.feesTotal,
        grandTotal: totals.grandTotal,
        quotedTotal: totals.grandTotal,
        handoffUrl,
      },
    };
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        adapterKey: input.adapterKey,
        code: "QUOTE_REQUEST_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "Unexpected quote request failure",
        retryable: true,
        listingId: input.request.listingId,
        checkInIso: input.request.checkInIso,
        checkOutIso: input.request.checkOutIso,
        details: {
          handoffUrl,
        },
      }),
    };
  } finally {
    await browser.close();
  }
}
