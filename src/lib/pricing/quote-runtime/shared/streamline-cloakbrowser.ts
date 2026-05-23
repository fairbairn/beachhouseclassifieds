import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  launch as launchCloakBrowser,
  launchPersistentContext as launchPersistentCloakContext,
} from "cloakbrowser";
import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type BrowserProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

type RequestResponseLike = {
  text(): Promise<string>;
  status(): number;
  ok(): boolean;
};

type RequestClientLike = {
  post(
    endpoint: string,
    options: {
      headers: Record<string, string>;
      data: string;
      timeout: number;
    },
  ): Promise<RequestResponseLike>;
};

type PageGotoResponseLike = {
  status(): number;
  headers(): Record<string, string>;
};

type BrowserPageLike = {
  goto(
    url: string,
    options: { waitUntil: "commit" | "domcontentloaded"; timeout: number },
  ): Promise<PageGotoResponseLike | null>;
  close(): Promise<void>;
};

type BrowserContextLike = {
  request: RequestClientLike;
  addCookies(cookies: unknown[]): Promise<void>;
  cookies(origin: string): Promise<Array<{ name: string }>>;
  addInitScript(script: () => void): Promise<void>;
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
  context: BrowserContextLike;
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
const ADAPTERS_REQUIRING_LANDING_SESSION = new Set<string>(["stayon30a"]);
const DEFAULT_USER_AGENT_CANDIDATES = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/137.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; OnePlus 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
] as const;

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

function resolveDetailLoadTimeoutMs(timeoutMs: number): number {
  // Detail navigation should have a larger budget than API calls, especially
  // when anti-bot challenge pages need to load before retrying.
  return Math.min(120000, Math.max(15000, Math.floor(timeoutMs * 2)));
}

function resolveChallengeWaitMs(input: {
  timeoutMs: number;
  headless: boolean;
}): number {
  if (input.headless) {
    return Math.min(8000, Math.max(2000, Math.floor(input.timeoutMs / 3)));
  }

  // In headed mode, allow enough time for a human to complete challenge UI.
  return Math.min(60000, Math.max(30000, Math.floor(input.timeoutMs / 2)));
}

async function launchCloakBrowserInstance(input: {
  adapterKey: string;
  listingId: string;
  envPrefix: string;
  userAgent: string;
  headless: boolean;
  proxy: BrowserProxyConfig | null;
}): Promise<{
  context: BrowserContextLike;
  close: () => Promise<void>;
  stealthRequested: boolean;
  stealthActive: boolean;
  stealthError: string | null;
  realChromeRequested: boolean;
  persistentProfileEnabled: boolean;
  persistentProfileDir: string | null;
  disableHttp2: boolean;
}> {
  const stealthRequested = readToggle(
    `${input.envPrefix}_STEALTH`,
    readToggle("STREAMLINE_STEALTH", false),
  );
  const realChromeRequested = readToggle(
    `${input.envPrefix}_REAL_CHROME`,
    readToggle("STREAMLINE_REAL_CHROME", false),
  );
  const persistentProfileEnabled = readToggle(
    `${input.envPrefix}_PERSISTENT_PROFILE`,
    readToggle("STREAMLINE_PERSISTENT_PROFILE", false),
  );
  const disableHttp2Configured = readToggle(
    `${input.envPrefix}_DISABLE_HTTP2`,
    readToggle("STREAMLINE_DISABLE_HTTP2", false),
  );
  const warmupOnceEnabled = readToggle(
    `${input.envPrefix}_PERSISTENT_PROFILE_WARMUP_ONCE`,
    readToggle("STREAMLINE_PERSISTENT_PROFILE_WARMUP_ONCE", false),
  );

  let disableHttp2 = disableHttp2Configured;
  let shouldWriteWarmupMarker = false;

  if (persistentProfileEnabled) {
    const configuredProfileDir = readFirstEnv([
      `${input.envPrefix}_PERSISTENT_PROFILE_DIR`,
      "STREAMLINE_PERSISTENT_PROFILE_DIR",
    ]);

    const listingScopedSegment = input.listingId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-");

    const profileBaseDir = configuredProfileDir
      ? resolve(
          process.cwd(),
          configuredProfileDir,
          input.adapterKey.toLowerCase(),
        )
      : resolve(
          process.cwd(),
          ".tmp",
          "cloak-profiles",
          input.adapterKey.toLowerCase(),
        );
    const profileDir = resolve(profileBaseDir, listingScopedSegment);

    await mkdir(profileDir, { recursive: true });

    const warmupMarkerPath = resolve(profileDir, ".warmup-http2-complete");
    if (warmupOnceEnabled && !disableHttp2Configured) {
      try {
        await access(warmupMarkerPath);
      } catch {
        disableHttp2 = true;
        shouldWriteWarmupMarker = true;
      }
    }

    const args = disableHttp2 ? ["--disable-http2"] : [];

    const context = (await launchPersistentCloakContext({
      userDataDir: profileDir,
      headless: input.headless,
      userAgent: input.userAgent,
      ...(input.proxy ? { proxy: input.proxy } : {}),
      ...(args.length > 0 ? { args } : {}),
    })) as BrowserContextLike;

    if (shouldWriteWarmupMarker) {
      await writeFile(
        warmupMarkerPath,
        `${new Date().toISOString()}\n`,
        "utf8",
      );
    }

    return {
      context,
      close: () => context.close(),
      stealthRequested,
      // CloakBrowser ships stealth defaults at the browser layer.
      stealthActive: true,
      stealthError: realChromeRequested
        ? "STREAMLINE_REAL_CHROME toggle ignored in CloakBrowser path"
        : null,
      realChromeRequested,
      persistentProfileEnabled,
      persistentProfileDir: profileDir,
      disableHttp2,
    };
  }

  const args = disableHttp2 ? ["--disable-http2"] : [];

  const launchOptions: Record<string, unknown> = {
    headless: input.headless,
    userAgent: input.userAgent,
    ignoreHTTPSErrors: false,
    ...(args.length > 0 ? { args } : {}),
    ...(input.proxy ? { proxy: input.proxy } : {}),
  };

  const browser = (await launchCloakBrowser(launchOptions)) as BrowserLike;
  const context = await browser.newContext({
    userAgent: input.userAgent,
    ignoreHTTPSErrors: false,
  });

  return {
    context,
    close: () => browser.close(),
    stealthRequested,
    // CloakBrowser ships stealth defaults at the browser layer.
    stealthActive: true,
    stealthError: realChromeRequested
      ? "STREAMLINE_REAL_CHROME toggle ignored in CloakBrowser path"
      : null,
    realChromeRequested,
    persistentProfileEnabled,
    persistentProfileDir: null,
    disableHttp2,
  };
}

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

async function seedCloudflareCookies(input: {
  context: BrowserContextLike;
  detailUrl: string;
  envPrefix: string;
}): Promise<{
  seededCfClearance: boolean;
  seededCfBm: boolean;
}> {
  const cfClearance = readEnv(`${input.envPrefix}_CF_CLEARANCE`);
  const cfBm = readEnv(`${input.envPrefix}_CF_BM`);

  if (!cfClearance && !cfBm) {
    return {
      seededCfClearance: false,
      seededCfBm: false,
    };
  }

  const hostname = new URL(input.detailUrl).hostname;
  const cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite: "None";
  }> = [];

  if (cfClearance) {
    cookies.push({
      name: "cf_clearance",
      value: cfClearance,
      domain: hostname,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "None",
    });
  }

  if (cfBm) {
    cookies.push({
      name: "__cf_bm",
      value: cfBm,
      domain: hostname,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "None",
    });
  }

  await input.context.addCookies(cookies);

  return {
    seededCfClearance: Boolean(cfClearance),
    seededCfBm: Boolean(cfBm),
  };
}

async function waitForCookie(input: {
  context: BrowserContextLike;
  origin: string;
  cookieName: string;
  timeoutMs: number;
  pollMs?: number;
}): Promise<boolean> {
  const pollMs = Math.max(200, Math.floor(input.pollMs ?? 750));
  const startedAt = Date.now();

  while (Date.now() - startedAt < input.timeoutMs) {
    const cookies = await input.context.cookies(input.origin);
    if (cookies.some((cookie) => cookie.name === input.cookieName)) {
      return true;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }

  return false;
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

function readFirstEnv(keys: string[]): string | null {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function resolveSkipLanding(input: {
  adapterKey: string;
  envPrefix: string;
}): boolean {
  const defaultSkipLanding = !ADAPTERS_REQUIRING_LANDING_SESSION.has(
    input.adapterKey,
  );
  return readToggle(`${input.envPrefix}_SKIP_LANDING`, defaultSkipLanding);
}

function parseUserAgentPool(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split("||")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function hashString(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function resolveUserAgent(input: {
  envPrefix: string;
  adapterKey: string;
  request: QuoteExecutionRequest;
}): string {
  const explicitUserAgent =
    process.env[`${input.envPrefix}_USER_AGENT`]?.trim();
  if (explicitUserAgent) {
    return explicitUserAgent;
  }

  const envPool = parseUserAgentPool(
    readFirstEnv([
      `${input.envPrefix}_USER_AGENT_POOL`,
      "STREAMLINE_USER_AGENT_POOL",
    ]),
  );

  const candidates =
    envPool.length > 0 ? envPool : [...DEFAULT_USER_AGENT_CANDIDATES];

  const hashSeed = `${input.adapterKey}:${input.request.listingId}:${input.request.checkInIso}:${input.request.checkOutIso}`;
  const index = hashString(hashSeed) % candidates.length;
  return candidates[index] ?? DEFAULT_USER_AGENT_CANDIDATES[0];
}

function resolveBrowserProxy(envPrefix: string): {
  server: string;
  username?: string;
  password?: string;
} | null {
  const proxyUrl = readFirstEnv([
    `${envPrefix}_HTTPS_PROXY`,
    `${envPrefix}_HTTP_PROXY`,
    `${envPrefix}_PROXY`,
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
  ]);

  if (!proxyUrl) {
    return null;
  }

  try {
    const parsed = new URL(proxyUrl);
    const server = `${parsed.protocol}//${parsed.host}`;
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
    return {
      server: proxyUrl,
    };
  }
}

export async function executeStreamlineCloakBrowserQuote(input: {
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
  const skipLanding = resolveSkipLanding({
    adapterKey: input.adapterKey,
    envPrefix: input.envPrefix,
  });
  const userAgent = resolveUserAgent({
    envPrefix: input.envPrefix,
    adapterKey: input.adapterKey,
    request: input.request,
  });
  const proxy = resolveBrowserProxy(input.envPrefix);
  const detailLoadTimeoutMs = resolveDetailLoadTimeoutMs(timeoutMs);
  const detailChallengeWaitMs = resolveChallengeWaitMs({
    timeoutMs,
    headless,
  });

  let launchState: {
    context: BrowserContextLike;
    close: () => Promise<void>;
    stealthRequested: boolean;
    stealthActive: boolean;
    stealthError: string | null;
    realChromeRequested: boolean;
    persistentProfileEnabled: boolean;
    persistentProfileDir: string | null;
    disableHttp2: boolean;
  };
  try {
    launchState = await launchCloakBrowserInstance({
      adapterKey: input.adapterKey,
      listingId: input.request.listingId,
      envPrefix: input.envPrefix,
      userAgent,
      headless,
      proxy,
    });
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        adapterKey: input.adapterKey,
        code: "QUOTE_REQUEST_FAILED",
        message:
          error instanceof Error
            ? `Browser launch failed: ${error.message}`
            : "Browser launch failed",
        retryable: true,
        listingId: input.request.listingId,
        checkInIso: input.request.checkInIso,
        checkOutIso: input.request.checkOutIso,
        details: {
          handoffUrl,
        },
      }),
    };
  }
  const context = launchState.context;

  const launchDiagnostics: Record<string, unknown> = {
    browserEngine: "cloakbrowser",
    stealthRequested: launchState.stealthRequested,
    stealthActive: launchState.stealthActive,
    realChromeRequested: launchState.realChromeRequested,
    proxyConfigured: Boolean(proxy),
    proxyServer: proxy?.server ?? null,
    proxyAuthConfigured: Boolean(proxy?.username || proxy?.password),
    persistentProfileEnabled: launchState.persistentProfileEnabled,
    persistentProfileDir: launchState.persistentProfileDir,
    disableHttp2: launchState.disableHttp2,
    effectiveUserAgent: userAgent,
    ...(launchState.stealthError
      ? { stealthError: launchState.stealthError }
      : {}),
  };

  try {
    const seededCookies = await seedCloudflareCookies({
      context,
      detailUrl: contextData.detailUrl,
      envPrefix: input.envPrefix,
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        configurable: true,
        get: () => undefined,
      });
    });

    let detailStatus: number | null = null;
    let detailInitialStatus: number | null = null;
    let detailRetryStatus: number | null = null;
    let detailCfMitigatedInitial: string | null = null;
    let detailCfMitigatedRetry: string | null = null;
    let detailChallengeRetryAttempted = false;
    let detailHasCfClearanceCookie = false;
    if (!skipLanding) {
      const page = await context.newPage();
      try {
        const response = await page.goto(contextData.detailUrl, {
          waitUntil: "commit",
          timeout: detailLoadTimeoutMs,
        });
        detailInitialStatus = response?.status() ?? null;
        detailStatus = detailInitialStatus;
        detailCfMitigatedInitial =
          response?.headers()["cf-mitigated"]?.trim() ?? null;

        if (
          detailInitialStatus === 403 &&
          detailCfMitigatedInitial?.toLowerCase() === "challenge"
        ) {
          detailChallengeRetryAttempted = true;

          // Allow challenge completion and wait for the clearance cookie.
          detailHasCfClearanceCookie = await waitForCookie({
            context,
            origin: contextData.origin,
            cookieName: "cf_clearance",
            timeoutMs: detailChallengeWaitMs,
          });

          if (!detailHasCfClearanceCookie) {
            return {
              success: false,
              elapsedMs: performance.now() - startedAt,
              error: toError({
                adapterKey: input.adapterKey,
                code: "EDGE_CHALLENGE_BLOCKED",
                message:
                  "Cloudflare challenge did not issue cf_clearance cookie within wait window",
                retryable: true,
                listingId: input.request.listingId,
                checkInIso: input.request.checkInIso,
                checkOutIso: input.request.checkOutIso,
                details: {
                  handoffUrl,
                  detailUrl: contextData.detailUrl,
                  detailStatus,
                  detailInitialStatus,
                  detailRetryStatus,
                  detailCfMitigatedInitial,
                  detailCfMitigatedRetry,
                  detailChallengeRetryAttempted,
                  detailHasCfClearanceCookie,
                  detailLoadTimeoutMs,
                  detailChallengeWaitMs,
                  seededCfClearanceCookie: seededCookies.seededCfClearance,
                  seededCfBmCookie: seededCookies.seededCfBm,
                  ...launchDiagnostics,
                },
              }),
            };
          }

          const retryResponse = await page.goto(contextData.detailUrl, {
            waitUntil: "domcontentloaded",
            timeout: detailLoadTimeoutMs,
          });
          detailRetryStatus = retryResponse?.status() ?? null;
          detailStatus = detailRetryStatus;
          detailCfMitigatedRetry =
            retryResponse?.headers()["cf-mitigated"]?.trim() ?? null;
        }
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
              detailInitialStatus,
              detailRetryStatus,
              detailCfMitigatedInitial,
              detailCfMitigatedRetry,
              detailChallengeRetryAttempted,
              detailHasCfClearanceCookie,
              detailLoadTimeoutMs,
              detailChallengeWaitMs,
              seededCfClearanceCookie: seededCookies.seededCfClearance,
              seededCfBmCookie: seededCookies.seededCfBm,
              ...launchDiagnostics,
            },
          }),
        };
      } finally {
        await page.close();
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
              detailInitialStatus,
              detailRetryStatus,
              detailCfMitigatedInitial,
              detailCfMitigatedRetry,
              detailChallengeRetryAttempted,
              detailHasCfClearanceCookie,
              detailLoadTimeoutMs,
              detailChallengeWaitMs,
              seededCfClearanceCookie: seededCookies.seededCfClearance,
              seededCfBmCookie: seededCookies.seededCfBm,
              ...launchDiagnostics,
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
              detailInitialStatus,
              detailRetryStatus,
              detailCfMitigatedInitial,
              detailCfMitigatedRetry,
              detailChallengeRetryAttempted,
              detailHasCfClearanceCookie,
              detailLoadTimeoutMs,
              detailChallengeWaitMs,
              seededCfClearanceCookie: seededCookies.seededCfClearance,
              seededCfBmCookie: seededCookies.seededCfBm,
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
            detailInitialStatus,
            detailRetryStatus,
            detailCfMitigatedInitial,
            detailCfMitigatedRetry,
            detailChallengeRetryAttempted,
            detailHasCfClearanceCookie,
            detailLoadTimeoutMs,
            detailChallengeWaitMs,
            seededCfClearanceCookie: seededCookies.seededCfClearance,
            seededCfBmCookie: seededCookies.seededCfBm,
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
            detailInitialStatus,
            detailRetryStatus,
            detailCfMitigatedInitial,
            detailCfMitigatedRetry,
            detailChallengeRetryAttempted,
            detailHasCfClearanceCookie,
            detailLoadTimeoutMs,
            detailChallengeWaitMs,
            seededCfClearanceCookie: seededCookies.seededCfClearance,
            seededCfBmCookie: seededCookies.seededCfBm,
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
            detailInitialStatus,
            detailRetryStatus,
            detailCfMitigatedInitial,
            detailCfMitigatedRetry,
            detailChallengeRetryAttempted,
            detailHasCfClearanceCookie,
            detailLoadTimeoutMs,
            detailChallengeWaitMs,
            seededCfClearanceCookie: seededCookies.seededCfClearance,
            seededCfBmCookie: seededCookies.seededCfBm,
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
            detailInitialStatus,
            detailRetryStatus,
            detailCfMitigatedInitial,
            detailCfMitigatedRetry,
            detailChallengeRetryAttempted,
            detailHasCfClearanceCookie,
            detailLoadTimeoutMs,
            detailChallengeWaitMs,
            seededCfClearanceCookie: seededCookies.seededCfClearance,
            seededCfBmCookie: seededCookies.seededCfBm,
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
    await launchState.close();
  }
}
