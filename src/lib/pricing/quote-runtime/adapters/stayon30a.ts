import "@/core/tooling/env/load-env-profile";

import { shouldAdapterUseProxy } from "@/lib/pricing/proxy/adapter-proxy-policy";
import { launch as launchCloakBrowser } from "cloakbrowser";
import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

const ADAPTER_KEY = "stayon30a" as const;
const ENV_PREFIX = "STAYON30A" as const;
const DEFAULT_TIMEOUT_MS = 20000;
const MIN_VALID_BASE_TOTAL = 100;
const DEFAULT_NEXT_ACTION_ID = "40505fdee50656891037fb5e081afde30365bd1908";
const USE_PROXY = shouldAdapterUseProxy(ADAPTER_KEY);

type BrowserProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

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
  currency?: unknown;
  subTotal?: unknown;
  taxes?: unknown;
  total?: unknown;
  fees?: unknown;
  hasFees?: unknown;
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

type QuoteTransportResponse = {
  ok: boolean;
  status: number;
  bodyText: string;
  contentType: string | null;
  mode: "direct_http" | "cloakbrowser_request";
};

let cachedProxyDispatcherPromise: Promise<unknown | null> | null = null;

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

function normalizeNonNegativeCurrency(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  // Protect against floating-point drift like -0.00000001 on fee derivation.
  if (value < 0 && value > -0.01) {
    return 0;
  }
  return value;
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

function resolveProxyUrl(useProxy: boolean): string | null {
  if (!useProxy) {
    return null;
  }

  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    process.env.https_proxy ??
    process.env.http_proxy;
  const normalized = proxy?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

async function resolveProxyDispatcher(): Promise<unknown | null> {
  const proxyUrl = resolveProxyUrl(USE_PROXY);
  if (!proxyUrl) {
    return null;
  }

  try {
    const undiciModule = (await import("undici")) as {
      ProxyAgent?: new (input: { uri: string }) => unknown;
    };
    const ProxyAgent = undiciModule.ProxyAgent;
    if (!ProxyAgent) {
      return null;
    }
    return new ProxyAgent({ uri: proxyUrl });
  } catch {
    return null;
  }
}

async function getProxyDispatcher(): Promise<unknown | null> {
  if (!cachedProxyDispatcherPromise) {
    cachedProxyDispatcherPromise = resolveProxyDispatcher();
  }
  return cachedProxyDispatcherPromise;
}

function getSetCookieValues(headers: Headers): string[] {
  const withSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof withSetCookie.getSetCookie === "function") {
    return withSetCookie.getSetCookie();
  }

  const fallback = headers.get("set-cookie");
  if (!fallback) {
    return [];
  }
  return fallback.split(/,(?=[^;,]+=)/g);
}

function toCookieHeaderFromSetCookie(values: string[]): string | null {
  const cookies: string[] = [];
  for (const value of values) {
    const firstPart = value.split(";")[0]?.trim() ?? "";
    if (!firstPart || !firstPart.includes("=")) {
      continue;
    }
    cookies.push(firstPart);
  }
  if (cookies.length === 0) {
    return null;
  }
  return cookies.join("; ");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { dispatcher?: unknown },
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
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

function extractSlugFromDetailUrl(detailUrl: string): string | null {
  try {
    const parsed = new URL(detailUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] !== "property" || !parts[1]) {
      return null;
    }
    const slug = parts[1].trim().toLowerCase();
    return slug.length > 0 ? slug : null;
  } catch {
    return null;
  }
}

function buildReserveCheckoutUrl(input: {
  detailUrl: string;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  guests: number;
}): string | null {
  const slug = extractSlugFromDetailUrl(input.detailUrl);
  if (!slug) {
    return null;
  }

  const detailParsed = new URL(input.detailUrl);
  const checkout = new URL("/checkout", detailParsed.origin);
  checkout.searchParams.set("listing", input.listingId);
  checkout.searchParams.set("property", slug);
  checkout.searchParams.set("checkIn", input.checkInIso);
  checkout.searchParams.set("checkOut", input.checkOutIso);
  checkout.searchParams.set(
    "guests",
    String(Math.max(1, Math.floor(input.guests))),
  );
  return checkout.toString();
}

function buildNextRouterStateTreeHeader(detailUrl: string): string | null {
  const slug = extractSlugFromDetailUrl(detailUrl);
  if (!slug) {
    return null;
  }

  const state = [
    "",
    {
      children: [
        "property",
        {
          children: [
            ["slug", slug, "d", null],
            { children: ["__PAGE__", {}, null, null, 0] },
            null,
            null,
            0,
          ],
        },
        null,
        null,
        0,
      ],
    },
    null,
    null,
    16,
  ];
  return encodeURIComponent(JSON.stringify(state));
}

function looksLikeNextActionResponse(input: {
  bodyText: string;
  contentType: string | null;
}): boolean {
  if (input.contentType?.toLowerCase().includes("text/x-component")) {
    return true;
  }

  const body = input.bodyText.trim();
  if (!body) {
    return false;
  }

  if (/^0:\s*\{/.test(body) || /^1:\s*\{/.test(body)) {
    return true;
  }

  return parsePostActionPayload(body) !== null;
}

async function requestQuoteViaDirectHttp(input: {
  detailUrl: string;
  endpointUrl: string;
  origin: string;
  nextActionId: string;
  nextRouterStateTree: string | null;
  payloadJson: string;
  timeoutMs: number;
  userAgent: string;
  dispatcher: unknown | null;
}): Promise<QuoteTransportResponse> {
  const bootstrapInit: RequestInit & { dispatcher?: unknown } = {
    method: "GET",
    headers: {
      "user-agent": input.userAgent,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  };
  if (input.dispatcher) {
    bootstrapInit.dispatcher = input.dispatcher;
  }

  const bootstrapResponse = await fetchWithTimeout(
    input.detailUrl,
    bootstrapInit,
    Math.min(120000, Math.max(input.timeoutMs, 10000)),
  );

  const cookieHeader = toCookieHeaderFromSetCookie(
    getSetCookieValues(bootstrapResponse.headers),
  );

  const quoteInit: RequestInit & { dispatcher?: unknown } = {
    method: "POST",
    headers: {
      accept: "text/x-component",
      "content-type": "text/plain;charset=UTF-8",
      "next-action": input.nextActionId,
      ...(input.nextRouterStateTree
        ? { "next-router-state-tree": input.nextRouterStateTree }
        : {}),
      referer: input.detailUrl,
      origin: input.origin,
      "user-agent": input.userAgent,
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    body: input.payloadJson,
  };
  if (input.dispatcher) {
    quoteInit.dispatcher = input.dispatcher;
  }

  const quoteResponse = await fetchWithTimeout(
    input.endpointUrl,
    quoteInit,
    input.timeoutMs,
  );

  const bodyText = await quoteResponse.text();
  return {
    ok: quoteResponse.ok,
    status: quoteResponse.status,
    contentType: quoteResponse.headers.get("content-type"),
    bodyText,
    mode: "direct_http",
  };
}

function extractQuoteContext(input: QuoteExecutionRequest): {
  listingId: string;
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

  const listingId =
    toOpaqueIdString(context?.property_id) ??
    toOpaqueIdString(context?.listing_id) ??
    toOpaqueIdString(context?.unit_id);
  if (!listingId) {
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
    listingId,
    detailUrl,
    endpointUrl: detailUrl,
    origin,
  };
}

function parsePostActionPayload(
  bodyText: string,
): HomeLocalQuoteResponse | null {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return null;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidateLine =
    lines.find((line) => /^1:\s*\{/.test(line)) ??
    lines.find((line) => /^\{/.test(line)) ??
    null;
  if (!candidateLine) {
    return null;
  }

  const jsonText = candidateLine.startsWith("1:")
    ? candidateLine.slice(2).trim()
    : candidateLine;
  try {
    return JSON.parse(jsonText) as HomeLocalQuoteResponse;
  } catch {
    return null;
  }
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
  const proxy = resolveProxy(USE_PROXY);

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
  const directHttpEnabled = readToggle(`${ENV_PREFIX}_DIRECT_HTTP`, true);
  const userAgent =
    process.env[`${ENV_PREFIX}_USER_AGENT`]?.trim() ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  let browser: BrowserLike | null = null;
  let context: BrowserContextLike | null = null;
  try {
    const guests = Math.max(
      1,
      Math.floor(input.adults) + Math.floor(input.children),
    );
    const nextActionId =
      process.env[`${ENV_PREFIX}_NEXT_ACTION_ID`]?.trim() ||
      DEFAULT_NEXT_ACTION_ID;
    const nextRouterStateTree = buildNextRouterStateTreeHeader(
      contextData.detailUrl,
    );

    const payload = [
      {
        listingId: contextData.listingId,
        checkIn: input.checkInIso,
        checkOut: input.checkOutIso,
        guests,
        pets: 0,
        coupon: "$undefined",
      },
    ];
    const payloadJson = JSON.stringify(payload);

    let transportResponse: QuoteTransportResponse | null = null;
    if (directHttpEnabled) {
      try {
        const dispatcher = await getProxyDispatcher();
        const directResponse = await requestQuoteViaDirectHttp({
          detailUrl: contextData.detailUrl,
          endpointUrl: contextData.endpointUrl,
          origin: contextData.origin,
          nextActionId,
          nextRouterStateTree,
          payloadJson,
          timeoutMs,
          userAgent,
          dispatcher,
        });
        if (
          directResponse.ok ||
          looksLikeNextActionResponse({
            bodyText: directResponse.bodyText,
            contentType: directResponse.contentType,
          })
        ) {
          transportResponse = directResponse;
        }
      } catch {
        // Fall through to CloakBrowser request path.
      }
    }

    if (!transportResponse) {
      browser = (await launchCloakBrowser({
        headless,
        ...(proxy ? { proxy } : {}),
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

      const response = await context.request.post(contextData.endpointUrl, {
        headers: {
          accept: "text/x-component",
          "next-action": nextActionId,
          ...(nextRouterStateTree
            ? { "next-router-state-tree": nextRouterStateTree }
            : {}),
          referer: contextData.detailUrl,
          origin: contextData.origin,
        },
        data: payloadJson,
        timeout: timeoutMs,
      });

      transportResponse = {
        ok: response.ok(),
        status: response.status(),
        bodyText: await response.text(),
        contentType: null,
        mode: "cloakbrowser_request",
      };
    }

    const bodyText = transportResponse.bodyText;
    const bodySnippet = bodyText.replace(/\s+/g, " ").trim().slice(0, 1200);
    const payloadResponse = parsePostActionPayload(bodyText);

    const ratePlanFromPayload = payloadResponse
      ? parseRatePlan(payloadResponse)
      : null;
    const quoteId = toOpaqueIdString(payloadResponse?.id);
    const ratePlanId = toOpaqueIdString(ratePlanFromPayload?.id);
    const checkoutHandoffUrl = buildCheckoutHandoffUrl({
      detailUrl: contextData.detailUrl,
      quoteId,
      ratePlanId,
    });
    const reserveCheckoutUrl = buildReserveCheckoutUrl({
      detailUrl: contextData.detailUrl,
      listingId: contextData.listingId,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      guests,
    });
    const resolvedHandoffUrl =
      checkoutHandoffUrl ?? reserveCheckoutUrl ?? handoffUrl;

    if (!transportResponse.ok) {
      const message =
        asOptionalString(payloadResponse?.message) ??
        `HomeLocal quote request failed with status ${transportResponse.status}`;
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
            listingId: contextData.listingId,
            quoteStatus: transportResponse.status,
            request_mode: transportResponse.mode,
            proxyEnabledByPolicy: USE_PROXY,
            proxyConfigured: Boolean(proxy),
            serviceCode: asOptionalString(payloadResponse?.code),
            qid: quoteId,
            rpid: ratePlanId,
          },
        }),
      };
    }

    const ratePlan = ratePlanFromPayload;
    const baseTotalRaw =
      (ratePlan
        ? (toFiniteNumber(ratePlan.totalRentDiscounted) ??
          toFiniteNumber(ratePlan.totalRentDiscountedUsd) ??
          toFiniteNumber(ratePlan.total_rent) ??
          toFiniteNumber(ratePlan.subTotalUsd) ??
          toFiniteNumber(ratePlan.sub_total))
        : null) ?? toFiniteNumber(payloadResponse?.subTotal);
    const taxesTotalRaw =
      (ratePlan
        ? (toFiniteNumber(ratePlan.totalTaxesUsd) ??
          toFiniteNumber(ratePlan.total_taxes))
        : null) ?? toFiniteNumber(payloadResponse?.taxes);
    const feesTotalRaw =
      (ratePlan
        ? (toFiniteNumber(ratePlan.totalFeesUsd) ??
          toFiniteNumber(ratePlan.total_fees))
        : null) ?? toFiniteNumber(payloadResponse?.fees);
    const grandTotalRaw =
      (ratePlan
        ? (toFiniteNumber(ratePlan.totalUsd) ?? toFiniteNumber(ratePlan.total))
        : null) ?? toFiniteNumber(payloadResponse?.total);

    const derivedFeesTotalRaw = normalizeNonNegativeCurrency(
      feesTotalRaw ??
        (grandTotalRaw !== null &&
        baseTotalRaw !== null &&
        taxesTotalRaw !== null
          ? grandTotalRaw - baseTotalRaw - taxesTotalRaw
          : null),
    );

    const noFeesFlag = payloadResponse?.hasFees === false;

    if (
      baseTotalRaw === null &&
      taxesTotalRaw === null &&
      grandTotalRaw === null
    ) {
      return {
        success: true,
        elapsedMs: performance.now() - startedAt,
        observation: {
          startDate: input.checkInIso,
          endDate: input.checkOutIso,
          quoteAvailable: false,
          quoteUnavailableReason:
            asOptionalString(payloadResponse?.message) ??
            `missing_rateplan_data response=${bodySnippet || "<empty>"}`,
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

    const baseTotal =
      baseTotalRaw !== null && baseTotalRaw > 0
        ? roundCurrency(baseTotalRaw)
        : null;
    const taxesTotal =
      taxesTotalRaw !== null && taxesTotalRaw >= 0
        ? roundCurrency(taxesTotalRaw)
        : null;
    const feesTotalCandidate =
      (derivedFeesTotalRaw !== null && derivedFeesTotalRaw >= 0
        ? derivedFeesTotalRaw
        : null) ?? (noFeesFlag ? 0 : null);
    const feesTotal =
      feesTotalCandidate !== null ? roundCurrency(feesTotalCandidate) : null;
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
        currency:
          asOptionalString(ratePlan?.currency) ??
          asOptionalString(payloadResponse?.currency) ??
          "USD",
        baseTotal: quoteAvailable ? baseTotal : null,
        taxesTotal: quoteAvailable ? taxesTotal : null,
        feesTotalExclTaxes: quoteAvailable ? feesTotal : null,
        grandTotal: quoteAvailable ? grandTotal : null,
        quotedTotal: quoteAvailable ? grandTotal : null,
        detailUrl: handoffUrl,
        handoffUrl: resolvedHandoffUrl,
        diagnostics: {
          request_mode: transportResponse.mode,
          proxyEnabledByPolicy: USE_PROXY,
          proxyConfigured: Boolean(proxy),
        },
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
          listingId: contextData.listingId,
          proxyEnabledByPolicy: USE_PROXY,
          proxyConfigured: Boolean(proxy),
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
