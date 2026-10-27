import { shouldAdapterUseProxy } from "@/lib/pricing/proxy/adapter-proxy-policy";
import { launch as launchCloakBrowser } from "cloakbrowser";
import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

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
};

type BrowserProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

type BrowserRequestResponseLike = {
  ok(): boolean;
  status(): number;
  text(): Promise<string>;
};

type BrowserRequestClientLike = {
  get(
    endpoint: string,
    options: {
      headers: Record<string, string>;
      timeout: number;
    },
  ): Promise<BrowserRequestResponseLike>;
};

type BrowserPageLike = {
  goto(
    url: string,
    options: { waitUntil: "commit" | "domcontentloaded"; timeout: number },
  ): Promise<unknown>;
  evaluate<TArg, TResult>(
    pageFunction: (arg: TArg) => TResult | Promise<TResult>,
    arg: TArg,
  ): Promise<TResult>;
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

const ADAPTER_KEY = "exclusive30a" as const;
const BASE_HOST = "https://www.exclusive30a.com";
const QUOTE_ENDPOINT = `${BASE_HOST}/quote`;
const DEFAULT_TIMEOUT_MS = 20000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const USE_PROXY = shouldAdapterUseProxy(ADAPTER_KEY);

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

function resolveProxy(useProxy: boolean): BrowserProxyConfig | null {
  if (!useProxy) {
    return null;
  }

  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    process.env.https_proxy ??
    process.env.http_proxy;
  const normalized = proxy?.trim();
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    const server = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    const username = parsed.username
      ? decodeURIComponent(parsed.username)
      : undefined;
    const password = parsed.password
      ? decodeURIComponent(parsed.password)
      : undefined;

    return {
      server,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };
  } catch {
    return { server: normalized };
  }
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
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

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNumericPropertyId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = String(Math.floor(value));
    return /^\d+$/.test(normalized) ? normalized : null;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    return /^\d+$/.test(normalized) ? normalized : null;
  }

  return null;
}

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return null;
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

function parseFeeLinesTotal(body: ExclusiveQuoteBody): number | null {
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
      if (!name || amount === null || amount < 0) {
        continue;
      }
      lines.push({ name, amount });
    }
  }

  const serviceFee = parseCurrencyLike(body.serviceFeeTotal);
  if (serviceFee !== null && serviceFee > 0) {
    lines.push({ name: "Service Fee", amount: serviceFee });
  }

  if (lines.length === 0) {
    return null;
  }

  return roundCurrency(lines.reduce((sum, line) => sum + line.amount, 0));
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
  return `${BASE_HOST}/booking/review/?${params.toString()}`;
}

function normalizeHandoffUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith(`${BASE_HOST}/booking/review/?`)) {
    return trimmed.replace(
      `${BASE_HOST}/booking/review/?`,
      `${BASE_HOST}/booking/review?`,
    );
  }
  return trimmed;
}

function buildSessionBoundHandoffDiagnostics(input: {
  detailUrl: string;
  handoffUrl: string;
}): Record<string, unknown> {
  return {
    handoffRequiresDetailPreflight: true,
    handoffFlow: ["detail_page", "book_now", "booking_review"],
    detailUrl: input.detailUrl,
    handoffUrl: input.handoffUrl,
  };
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
  minNightsStayReq: number;
  timeoutMs: number;
}): Promise<RawObservation> {
  const params = new URLSearchParams();
  params.set("arrival", input.startDate);
  params.set("departure", input.endDate);
  params.set("pid", input.listingId);
  params.set("numberOfAdult", String(Math.max(1, input.adults)));
  params.set("numberOfChild", String(Math.max(0, input.children)));
  params.set("numberOfPets", String(Math.max(0, input.pets)));
  params.set("travelInsurance", "");
  params.set("compositePropertyID", "");
  params.set("nights", String(input.nights));
  params.set(
    "min_nights_stay_req",
    String(Math.max(1, input.minNightsStayReq)),
  );
  params.set("_", String(Date.now()));
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

  const requestUrl = `${QUOTE_ENDPOINT}?${params.toString()}`;

  let browser: BrowserLike | null = null;
  let context: BrowserContextLike | null = null;
  let responseOk = false;
  let responseStatus = 0;
  let responseText = "";
  let requestError: string | null = null;

  try {
    const proxy = resolveProxy(USE_PROXY);
    browser = (await launchCloakBrowser({
      headless: true,
      ...(proxy ? { proxy } : {}),
    })) as BrowserLike;

    context = await browser.newContext({
      userAgent: USER_AGENT,
      ignoreHTTPSErrors: false,
    });

    const page = await context.newPage();
    try {
      await page.goto(input.detailUrl, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(120000, Math.max(15000, input.timeoutMs * 2)),
      });

      const response = await page.evaluate(
        async (args: {
          requestUrl: string;
          referer: string;
          timeoutMs: number;
        }) => {
          const controller = new AbortController();
          const timeoutHandle = setTimeout(
            () => controller.abort(),
            args.timeoutMs,
          );

          try {
            const result = await fetch(args.requestUrl, {
              method: "GET",
              headers: {
                accept: "application/json, text/javascript, */*; q=0.01",
                "x-requested-with": "XMLHttpRequest",
              },
              credentials: "include",
              referrer: args.referer,
              signal: controller.signal,
            });

            const text = await result.text();
            return {
              ok: result.ok,
              status: result.status,
              text,
              error: null as string | null,
            };
          } catch (error: unknown) {
            const message =
              error instanceof Error
                ? error.message
                : "Unknown browser quote request error";
            return {
              ok: false,
              status: 0,
              text: "",
              error: message,
            };
          } finally {
            clearTimeout(timeoutHandle);
          }
        },
        {
          requestUrl,
          referer: input.detailUrl,
          timeoutMs: input.timeoutMs,
        },
      );

      responseOk = response.ok;
      responseStatus = response.status;
      responseText = response.text;
      requestError = response.error;
    } finally {
      await page.close().catch(() => undefined);
    }
  } catch (error: unknown) {
    requestError =
      error instanceof Error
        ? error.message
        : "Unknown browser quote request error";
  } finally {
    if (context) {
      await context.close().catch(() => undefined);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }

  if (requestError) {
    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable: false,
      quoteUnavailableReason: requestError,
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl: fallbackHandoffUrl,
    };
  }

  if (!responseOk) {
    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable: false,
      quoteUnavailableReason: `Quote request failed with status ${responseStatus}`,
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl: fallbackHandoffUrl,
    };
  }

  let parsed: ExclusiveQuoteResponse;
  try {
    parsed = JSON.parse(responseText) as ExclusiveQuoteResponse;
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
    };
  }

  const body = parsed.body ?? {};
  const result = asString(body.result).toLowerCase();

  const baseTotal =
    parseCurrencyLike(body.guestDiscountedRent) ??
    parseCurrencyLike(body.nightlyRates);
  const taxesTotal = parseCurrencyLike(body.taxes);
  const feesTotal =
    parseCurrencyLike(body.otherChargesTotal) ?? parseFeeLinesTotal(body);
  const grandTotal = parseCurrencyLike(body.grandTotal);

  const cidRaw = body.cid;
  const cid =
    typeof cidRaw === "string" || typeof cidRaw === "number"
      ? String(cidRaw)
      : "";
  const handoffUrl = normalizeHandoffUrl(
    asString(body.bookingURL).trim() ||
      buildFallbackHandoffUrl({
        startDate: input.startDate,
        endDate: input.endDate,
        listingId: input.listingId,
        adults: input.adults,
        promoCode: asString(body.promoCode).trim() || input.promoCode,
        cid,
        nights: input.nights,
      }),
  );

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
  };
}

function resolveRuntimeQuoteContext(input: QuoteExecutionRequest): {
  detailUrl: string;
  quoteContext: Record<string, unknown>;
} {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? { ...input.quoteContext }
      : null;

  const detailUrl = asNonEmptyString(context?.detail_url);
  const propertyId =
    normalizeNumericPropertyId(context?.property_id) ??
    normalizeNumericPropertyId(context?.pid) ??
    normalizeNumericPropertyId(context?.unitID) ??
    normalizeNumericPropertyId(context?.unit_id) ??
    normalizeNumericPropertyId(context?.listing_id);

  if (!detailUrl || !propertyId) {
    throw new Error(
      `Missing required quoteContext.property_id/detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  return {
    detailUrl,
    quoteContext: {
      ...context,
      detail_url: detailUrl,
      pid: propertyId,
      property_id: propertyId,
    },
  };
}

export async function executeExclusive30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  let runtimeContext: {
    detailUrl: string;
    quoteContext: Record<string, unknown>;
  };

  try {
    runtimeContext = resolveRuntimeQuoteContext(input);
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: 0,
      error: {
        code: "QUOTE_CONTEXT_MISSING",
        message:
          error instanceof Error ? error.message : "Quote context missing",
        retryable: false,
        details: {
          adapterKey: ADAPTER_KEY,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
        },
      },
    };
  }

  const startedAt = Date.now();
  const propertyId = normalizeNumericPropertyId(
    runtimeContext.quoteContext.property_id,
  );
  if (!propertyId) {
    return {
      success: false,
      elapsedMs: 0,
      error: {
        code: "QUOTE_CONTEXT_MISSING",
        message: `Missing required quoteContext.property_id for ${ADAPTER_KEY} listing ${input.listingId}`,
        retryable: false,
        details: {
          adapterKey: ADAPTER_KEY,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
        },
      },
    };
  }

  const fallbackHandoffUrl = buildFallbackHandoffUrl({
    startDate: input.checkInIso,
    endDate: input.checkOutIso,
    listingId: propertyId,
    adults: Math.max(1, Math.floor(input.adults)),
    promoCode: "",
    cid: "",
    nights: Math.max(
      1,
      Math.round(
        (new Date(`${input.checkOutIso}T00:00:00.000Z`).getTime() -
          new Date(`${input.checkInIso}T00:00:00.000Z`).getTime()) /
          86400000,
      ),
    ),
  });

  try {
    const nights = Math.max(
      1,
      Math.round(
        (new Date(`${input.checkOutIso}T00:00:00.000Z`).getTime() -
          new Date(`${input.checkInIso}T00:00:00.000Z`).getTime()) /
          86400000,
      ),
    );

    const minNightsStayReq =
      normalizePositiveInt(runtimeContext.quoteContext.min_nights_stay_req) ??
      1;

    const raw = await fetchQuote({
      detailUrl: runtimeContext.detailUrl,
      listingId: propertyId,
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      nights,
      adults: Math.max(1, Math.floor(input.adults)),
      children: Math.max(0, Math.floor(input.children)),
      pets: 0,
      promoCode: "",
      minNightsStayReq,
      timeoutMs: normalizeTimeoutMs(input.options?.timeoutMs),
    });

    const elapsedMs = Date.now() - startedAt;
    if (!raw.quoteAvailable) {
      return {
        success: false,
        elapsedMs,
        error: {
          code: "QUOTE_UNAVAILABLE",
          message: raw.quoteUnavailableReason ?? "Quote unavailable",
          retryable: true,
          details: {
            adapterKey: ADAPTER_KEY,
            listingId: input.listingId,
            checkInIso: input.checkInIso,
            checkOutIso: input.checkOutIso,
            handoffUrl: raw.handoffUrl,
            diagnostics: buildSessionBoundHandoffDiagnostics({
              detailUrl: runtimeContext.detailUrl,
              handoffUrl: raw.handoffUrl,
            }),
          },
        },
      };
    }

    return {
      success: true,
      elapsedMs,
      observation: {
        startDate: raw.startDate,
        endDate: raw.endDate,
        quoteAvailable: true,
        currency: raw.currency,
        baseTotal: raw.baseTotal,
        taxesTotal: raw.taxesTotal,
        feesTotalExclTaxes: raw.feesTotal,
        grandTotal: raw.grandTotal,
        quotedTotal: raw.grandTotal,
        detailUrl: runtimeContext.detailUrl,
        handoffUrl: raw.handoffUrl,
        diagnostics: buildSessionBoundHandoffDiagnostics({
          detailUrl: runtimeContext.detailUrl,
          handoffUrl: raw.handoffUrl,
        }),
      },
    };
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: 0,
      error: {
        code: "QUOTE_EXECUTION_FAILED",
        message:
          error instanceof Error ? error.message : "Quote execution failed",
        retryable: false,
        details: {
          adapterKey: ADAPTER_KEY,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          handoffUrl: fallbackHandoffUrl,
        },
      },
    };
  }
}
