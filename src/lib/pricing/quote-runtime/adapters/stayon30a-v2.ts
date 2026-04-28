import "@/core/tooling/env/load-env-profile";

import { chromium, type BrowserContext } from "playwright";

import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type StreamlineFee = {
  name?: unknown;
  value?: unknown;
};

type StreamlinePreReservationPayload = {
  unit_id?: unknown;
  price?: unknown;
  taxes?: unknown;
  total?: unknown;
  currency?: unknown;
  required_fees?: unknown;
  taxes_details?: unknown;
};

type StreamlinePreReservationResponse = {
  data?: StreamlinePreReservationPayload;
  status?: {
    code?: unknown;
    description?: unknown;
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
};

const ADAPTER_KEY = "stayon30a" as const;
const MIN_VALID_BASE_TOTAL = 100;
const DEFAULT_TIMEOUT_MS = 20000;

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

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

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
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

function buildCheckoutUrl(input: {
  detailUrl: string;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
}): string {
  let origin = "https://www.stayon30a.com";
  try {
    origin = new URL(input.detailUrl).origin;
  } catch {
    origin = "https://www.stayon30a.com";
  }
  const params = new URLSearchParams();
  params.set("unit", input.listingId);
  params.set("sd", input.checkInIso);
  params.set("ed", input.checkOutIso);
  params.set("oc", String(Math.max(1, input.adults)));
  params.set("os", String(Math.max(0, input.children)));
  return `${origin}/checkout/?${params.toString()}`;
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

  if (input.grandTotal === null || input.grandTotal <= input.baseTotal) {
    return "grand_total_not_greater_than_base_total";
  }

  if (input.feesTotal === null) {
    return "fees_total_missing";
  }

  if (input.feesTotal < 0) {
    return "fees_total_negative";
  }

  if (input.feesTotal >= input.baseTotal) {
    return "fees_total_gte_base_total";
  }

  return null;
}

function resolveRuntimeQuoteContext(input: QuoteExecutionRequest): {
  listingId: string;
  detailUrl: string;
} {
  const quoteContext =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? input.quoteContext
      : null;

  const detailUrl = asOptionalString(quoteContext?.detail_url);
  if (!detailUrl) {
    throw new Error(
      `Missing required quoteContext.detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const listingIdFromContext =
    asOptionalString(quoteContext?.listing_id) ??
    asOptionalString(quoteContext?.unit_id);

  return {
    listingId: listingIdFromContext ?? input.listingId,
    detailUrl,
  };
}

async function postStreamlineRequestViaContext(input: {
  context: BrowserContext;
  endpoint: string;
  detailUrl: string;
  origin: string;
  paramsJson: string;
  timeoutMs: number;
}): Promise<{
  status: number;
  ok: boolean;
  bodyText: string;
  error: string | null;
}> {
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
        params: input.paramsJson,
      }).toString(),
      timeout: input.timeoutMs,
    });

    return {
      status: response.status(),
      ok: response.ok(),
      bodyText: await response.text(),
      error: null,
    };
  } catch (error: unknown) {
    return {
      status: 0,
      ok: false,
      bodyText: "",
      error:
        error instanceof Error
          ? error.message
          : "Unknown browser request error",
    };
  }
}

export async function executeStayon30aV2SingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);
  const fallbackHandoffUrlWithoutContext = `https://www.stayon30a.com/checkout/?sd=${encodeURIComponent(input.checkInIso)}&ed=${encodeURIComponent(input.checkOutIso)}&oc=${Math.max(1, input.adults)}&os=${Math.max(0, input.children)}`;

  let runtimeContext: { listingId: string; detailUrl: string };
  try {
    runtimeContext = resolveRuntimeQuoteContext(input);
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
        details: {
          handoffUrl: fallbackHandoffUrlWithoutContext,
        },
      }),
    };
  }

  const runtimeHandoffUrl = buildCheckoutUrl({
    detailUrl: runtimeContext.detailUrl,
    listingId: runtimeContext.listingId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: Math.max(1, input.adults),
    children: Math.max(0, input.children),
  });

  const origin = new URL(runtimeContext.detailUrl).origin;
  const endpoint = `${origin}/wp-admin/admin-ajax.php`;
  const headless = process.env.STAYON30A_V2_HEADLESS !== "0";
  const configuredUserAgent =
    process.env.STAYON30A_V2_USER_AGENT?.trim() || null;
  const skipLanding = process.env.STAYON30A_V2_SKIP_LANDING === "1";

  const browser = await chromium.launch({
    headless,
    // proxy: resolvePlaywrightProxy(),
  });

  try {
    const context = await browser.newContext({
      ...(configuredUserAgent ? { userAgent: configuredUserAgent } : {}),
      ignoreHTTPSErrors: false,
    });

    // await context.addInitScript(() => {
    //   Object.defineProperty(navigator, "webdriver", {
    //     configurable: true,
    //     get: () => undefined,
    //   });
    // });

    let landingStatus: number | null = null;
    if (!skipLanding) {
      const page = await context.newPage();
      try {
        const landingResponse = await page.goto(runtimeContext.detailUrl, {
          waitUntil: "commit",
          timeout: Math.max(1000, Math.floor(timeoutMs / 2)),
        });

        landingStatus = landingResponse?.status() ?? null;
        if (landingStatus !== null && landingStatus >= 400) {
          return {
            success: false,
            elapsedMs: performance.now() - startedAt,
            error: toError({
              code: "QUOTE_UNAVAILABLE",
              message: `Detail page load failed with status ${landingStatus}`,
              retryable: true,
              listingId: input.listingId,
              checkInIso: input.checkInIso,
              checkOutIso: input.checkOutIso,
              details: {
                handoffUrl: runtimeHandoffUrl,
                detailUrl: runtimeContext.detailUrl,
                detailStatus: landingStatus,
              },
            }),
          };
        }
      } catch (error: unknown) {
        return {
          success: false,
          elapsedMs: performance.now() - startedAt,
          error: toError({
            code: "QUOTE_REQUEST_FAILED",
            message:
              error instanceof Error
                ? `Detail page load failed: ${error.message}`
                : "Detail page load failed",
            retryable: true,
            listingId: input.listingId,
            checkInIso: input.checkInIso,
            checkOutIso: input.checkOutIso,
            details: {
              handoffUrl: runtimeHandoffUrl,
              detailUrl: runtimeContext.detailUrl,
            },
          }),
        };
      }
    }

    const availabilityPayload = JSON.stringify({
      methodName: "VerifyPropertyAvailability",
      params: {
        unit_id: Number(runtimeContext.listingId),
        startdate: toUsDate(input.checkInIso),
        enddate: toUsDate(input.checkOutIso),
        occupants: String(Math.max(1, input.adults)),
        occupants_small: String(Math.max(0, input.children)),
        pets: "0",
        use_room_type_logic: 0,
        include_coupon_information: 1,
      },
    });

    const availabilityResponse = await postStreamlineRequestViaContext({
      context,
      endpoint,
      detailUrl: runtimeContext.detailUrl,
      origin,
      paramsJson: availabilityPayload,
      timeoutMs,
    });

    let availabilityAllowsQuote = availabilityResponse.ok;
    const availabilityBlockedByAccessControls =
      availabilityResponse.status === 403;

    if (availabilityResponse.error) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_REQUEST_FAILED",
          message: `Availability request failed: ${availabilityResponse.error}`,
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            handoffUrl: runtimeHandoffUrl,
            detailStatus: landingStatus,
            availabilityStatus: availabilityResponse.status,
          },
        }),
      };
    }

    if (availabilityResponse.ok) {
      try {
        const availabilityJson = JSON.parse(
          availabilityResponse.bodyText,
        ) as StreamlinePreReservationResponse;
        const availabilityCode = asOptionalString(
          availabilityJson.status?.code,
        );
        if (availabilityCode) {
          availabilityAllowsQuote = false;
          if (!availabilityBlockedByAccessControls) {
            return {
              success: false,
              elapsedMs: performance.now() - startedAt,
              error: toError({
                code: "QUOTE_UNAVAILABLE",
                message:
                  asOptionalString(availabilityJson.status?.description) ??
                  availabilityCode,
                retryable: true,
                listingId: input.listingId,
                checkInIso: input.checkInIso,
                checkOutIso: input.checkOutIso,
                details: {
                  handoffUrl: runtimeHandoffUrl,
                  detailStatus: landingStatus,
                  availabilityStatus: availabilityResponse.status,
                },
              }),
            };
          }
        }
      } catch {
        // Continue into quote call for robustness when response body is malformed.
      }
    }

    if (!availabilityAllowsQuote && !availabilityBlockedByAccessControls) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_UNAVAILABLE",
          message: `VerifyPropertyAvailability failed with status ${availabilityResponse.status}`,
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            handoffUrl: runtimeHandoffUrl,
            detailStatus: landingStatus,
            availabilityStatus: availabilityResponse.status,
          },
        }),
      };
    }

    const quotePayload = JSON.stringify({
      methodName: "GetPreReservationPrice",
      params: {
        unit_id: Number(runtimeContext.listingId),
        startdate: toUsDate(input.checkInIso),
        enddate: toUsDate(input.checkOutIso),
        occupants: String(Math.max(1, input.adults)),
        occupants_small: String(Math.max(0, input.children)),
        pets: "0",
        include_coupon_information: 1,
        optional_default_enabled: "yes",
      },
    });

    const quoteResponse = await postStreamlineRequestViaContext({
      context,
      endpoint,
      detailUrl: runtimeContext.detailUrl,
      origin,
      paramsJson: quotePayload,
      timeoutMs,
    });

    if (quoteResponse.error) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_REQUEST_FAILED",
          message: `Quote request failed: ${quoteResponse.error}`,
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            handoffUrl: runtimeHandoffUrl,
            detailStatus: landingStatus,
            availabilityStatus: availabilityResponse.status,
            quoteStatus: quoteResponse.status,
          },
        }),
      };
    }

    if (!quoteResponse.ok) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_UNAVAILABLE",
          message: `Quote request failed with status ${quoteResponse.status}`,
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            handoffUrl: runtimeHandoffUrl,
            detailStatus: landingStatus,
            availabilityStatus: availabilityResponse.status,
            quoteStatus: quoteResponse.status,
          },
        }),
      };
    }

    const payload = JSON.parse(
      quoteResponse.bodyText,
    ) as StreamlinePreReservationResponse;
    const statusCode = asOptionalString(payload.status?.code);

    if (statusCode) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_UNAVAILABLE",
          message: asOptionalString(payload.status?.description) ?? statusCode,
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            handoffUrl: runtimeHandoffUrl,
            detailStatus: landingStatus,
            availabilityStatus: availabilityResponse.status,
            quoteStatus: quoteResponse.status,
          },
        }),
      };
    }

    const data = payload.data;
    const baseTotalRaw = toFiniteNumber(data?.price);
    const nonBaseTotalRaw = toFiniteNumber(data?.taxes);
    const grandTotalRaw = toFiniteNumber(data?.total);

    const feeLines = Array.isArray(data?.required_fees)
      ? (data.required_fees as StreamlineFee[])
          .map((line) => {
            const amount = toFiniteNumber(line.value);
            const name = asOptionalString(line.name);
            if (!name || amount === null || amount < 0) {
              return null;
            }
            return {
              name,
              amount: roundCurrency(amount),
            };
          })
          .filter(
            (line): line is { name: string; amount: number } => line !== null,
          )
      : [];

    const taxesDetailTotal = Array.isArray(data?.taxes_details)
      ? roundCurrency(
          (data.taxes_details as StreamlineFee[]).reduce((sum, line) => {
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
    if (
      taxesTotal === null &&
      nonBaseTotalRaw !== null &&
      nonBaseTotalRaw > 0
    ) {
      taxesTotal = roundCurrency(nonBaseTotalRaw);
    }

    const rawObservation: RawObservation = {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: true,
      quoteUnavailableReason: null,
      baseTotal,
      taxesTotal,
      feesTotal,
      grandTotal,
      currency: asOptionalString(data?.currency) ?? "USD",
      handoffUrl: runtimeHandoffUrl,
    };

    const availabilityError = validateAvailableTotals({
      baseTotal: rawObservation.baseTotal,
      taxesTotal: rawObservation.taxesTotal,
      feesTotal: rawObservation.feesTotal,
      grandTotal: rawObservation.grandTotal,
    });

    if (availabilityError) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_UNAVAILABLE",
          message: availabilityError,
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            handoffUrl: runtimeHandoffUrl,
            detailStatus: landingStatus,
            availabilityStatus: availabilityResponse.status,
            quoteStatus: quoteResponse.status,
          },
        }),
      };
    }

    return {
      success: true,
      elapsedMs: performance.now() - startedAt,
      observation: {
        startDate: rawObservation.startDate,
        endDate: rawObservation.endDate,
        quoteAvailable: true,
        currency: rawObservation.currency,
        baseTotal: rawObservation.baseTotal,
        taxesTotal: rawObservation.taxesTotal,
        feesTotalExclTaxes: rawObservation.feesTotal,
        grandTotal: rawObservation.grandTotal,
        quotedTotal: rawObservation.grandTotal,
        handoffUrl: rawObservation.handoffUrl,
      },
    };
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_REQUEST_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "Unexpected quote request failure",
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          handoffUrl: runtimeHandoffUrl,
        },
      }),
    };
  } finally {
    await browser.close();
  }
}
