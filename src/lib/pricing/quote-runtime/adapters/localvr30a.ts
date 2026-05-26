import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  launch as launchCloakBrowser,
  launchPersistentContext as launchPersistentCloakContext,
} from "cloakbrowser";
import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type LocalVrInvoiceItem = {
  title?: unknown;
  type?: unknown;
  amount?: unknown;
};

type LocalVrMoney = {
  currency?: unknown;
  fareAccommodation?: unknown;
  fareAccommodationAdjusted?: unknown;
  totalFees?: unknown;
  totalTaxes?: unknown;
  hostPayout?: unknown;
  invoiceItems?: unknown;
};

type LocalVrQuoteRecord = {
  _id?: unknown;
  checkInDateLocalized?: unknown;
  checkOutDateLocalized?: unknown;
  rates?: {
    ratePlans?: Array<{
      ratePlan?: {
        money?: LocalVrMoney;
      };
    }>;
  };
  stay?: Array<{
    checkInDateLocalized?: unknown;
    checkOutDateLocalized?: unknown;
  }>;
};

type LocalVrErrorPayload = {
  error?: {
    code?: unknown;
    message?: unknown;
  };
};

type LocalVrQuoteContext = {
  listingId: string;
  detailUrl: string;
};

const ADAPTER_KEY = "localvr30a" as const;
const DEFAULT_TIMEOUT_MS = 20000;
const MIN_VALID_BASE_TOTAL = 100;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

type BrowserProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

type BrowserPageLike = {
  goto(
    url: string,
    options: { waitUntil: "commit" | "domcontentloaded"; timeout: number },
  ): Promise<unknown>;
  content(): Promise<string>;
  url(): string;
  waitForResponse(
    predicate: (response: BrowserResponseLike) => boolean,
    options?: { timeout?: number },
  ): Promise<BrowserResponseLike>;
  evaluate<TArg, TResult>(
    pageFunction: (arg: TArg) => TResult | Promise<TResult>,
    arg: TArg,
  ): Promise<TResult>;
  on?: (event: string, handler: (...args: unknown[]) => void) => unknown;
  off?: (event: string, handler: (...args: unknown[]) => void) => unknown;
  close(): Promise<void>;
};

type BrowserContextLike = {
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
};

type BrowserLike = {
  newContext(options: {
    userAgent: string;
    ignoreHTTPSErrors: boolean;
  }): Promise<BrowserContextLike>;
  close(): Promise<void>;
  disconnect?: () => Promise<void> | void;
  process?: () => { kill: (signal?: string) => boolean } | null;
  kill?: (signal?: string) => unknown;
};

type BrowserQuoteRequestResult = {
  ok: boolean;
  status: number;
  bodyText: string;
  requestError: string | null;
  vercelMitigated: string | null;
  diagnostics: Record<string, unknown>;
};

type BrowserRequestLike = {
  method(): string;
  url(): string;
};

type BrowserResponseLike = {
  ok(): boolean;
  status(): number;
  text(): Promise<string>;
  headers(): Record<string, string>;
  request(): BrowserRequestLike;
};

async function withTimeout<T>(input: {
  promise: Promise<T>;
  timeoutMs: number;
  timeoutMessage: string;
}): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      input.promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(input.timeoutMessage));
        }, input.timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function writeTraceLog(input: {
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  stage: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  const traceToFile = readToggle("LOCALVR30A_QUOTE_TRACE_LOG", true);
  const traceToStdout = readToggle("LOCALVR30A_QUOTE_TRACE_STDOUT", false);
  if (!traceToFile && !traceToStdout) {
    return;
  }

  const entry = {
    ts: new Date().toISOString(),
    adapter: ADAPTER_KEY,
    listing_id: input.listingId,
    check_in: input.checkInIso,
    check_out: input.checkOutIso,
    stage: input.stage,
    ...(input.details ? { details: input.details } : {}),
  };

  try {
    if (traceToFile) {
      const logDir = resolve(process.cwd(), ".tmp", "logs");
      await mkdir(logDir, { recursive: true });
      const logPath = resolve(logDir, "localvr30a-quote-runtime.log");
      await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
    }

    if (traceToStdout) {
      const stage = input.stage;
      const noisyStage =
        stage === "heartbeat" ||
        stage.includes("candidate_post") ||
        stage.includes("read_native_body");

      if (!noisyStage) {
        const details = input.details ?? {};
        const parts: string[] = [];
        const push = (label: string, value: unknown): void => {
          if (value === undefined || value === null) {
            return;
          }
          if (typeof value === "string" && value.trim().length === 0) {
            return;
          }
          parts.push(`${label}=${String(value)}`);
        };

        push("attempt", details.attempt);
        push("status", details.status);
        push("goto", details.gotoStatus);
        push("code", details.code);
        push("elapsedMs", details.elapsedMs);
        push("stage", details.currentStage);

        const compact = parts.length > 0 ? ` ${parts.join(" ")}` : "";
        process.stdout.write(
          `[localvr30a-trace] ${entry.ts} ${stage}${compact}\n`,
        );
      }
    }
  } catch {
    // Never fail quote runtime because trace logging failed.
  }
}

async function closeWithTimeout(input: {
  promise: Promise<void>;
  timeoutMs: number;
  timeoutMessage: string;
}): Promise<boolean> {
  try {
    await withTimeout({
      promise: input.promise,
      timeoutMs: input.timeoutMs,
      timeoutMessage: input.timeoutMessage,
    });
    return true;
  } catch {
    // Close hangs should not block quote execution completion.
    return false;
  }
}

async function forceTerminateBrowser(
  browser: BrowserLike | null,
): Promise<void> {
  if (!browser) {
    return;
  }

  const killSignals = ["SIGTERM", "SIGKILL"];
  for (const signal of killSignals) {
    try {
      if (typeof browser.kill === "function") {
        browser.kill(signal);
      }
    } catch {
      // Best-effort cleanup only.
    }

    try {
      const processHandle = browser.process?.();
      processHandle?.kill(signal);
    } catch {
      // Best-effort cleanup only.
    }
  }

  try {
    await browser.disconnect?.();
  } catch {
    // Best-effort cleanup only.
  }
}

type CheckpointWaitResult = {
  detected: boolean;
  resolved: boolean;
  finalUrl: string;
};

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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseFlightObjects(text: string): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\d+:\s*(\{.*\})\s*$/);
    if (!match?.[1]) {
      continue;
    }

    try {
      const parsed = JSON.parse(match[1]) as unknown;
      if (parsed && typeof parsed === "object") {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore non-JSON flight rows.
    }
  }

  if (objects.length > 0) {
    return objects;
  }

  const trimmed = text.trim();
  const candidates = [trimmed, trimmed.replace(/^\)\]\}'\s*/, "")];
  for (const candidateText of candidates) {
    if (!candidateText) {
      continue;
    }

    try {
      const parsed = JSON.parse(candidateText) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object") {
            objects.push(item as Record<string, unknown>);
          }
        }
        if (objects.length > 0) {
          return objects;
        }
      }

      if (parsed && typeof parsed === "object") {
        const parsedObject = parsed as Record<string, unknown>;
        objects.push(parsedObject);

        const nestedData = parsedObject.data;
        if (
          nestedData &&
          typeof nestedData === "object" &&
          !Array.isArray(nestedData)
        ) {
          objects.push(nestedData as Record<string, unknown>);
        }
        return objects;
      }
    } catch {
      // Ignore parse failures and continue trying candidates.
    }
  }

  return objects;
}

function pickQuoteRecord(
  rows: Array<Record<string, unknown>>,
): LocalVrQuoteRecord | null {
  for (const row of rows) {
    const candidate = row as LocalVrQuoteRecord;
    if (!candidate._id) {
      continue;
    }
    if (candidate.rates || candidate.stay) {
      return candidate;
    }
  }
  return null;
}

function pickErrorRecord(
  rows: Array<Record<string, unknown>>,
): LocalVrErrorPayload | null {
  for (const row of rows) {
    const candidate = row as LocalVrErrorPayload;
    if (candidate.error && typeof candidate.error === "object") {
      return candidate;
    }
  }
  return null;
}

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

function readToggle(name: string, defaultEnabled: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultEnabled;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }

  return defaultEnabled;
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

function hasCheckpointSignal(input: {
  html: string;
  url?: string;
  vercelMitigated?: string | null;
}): boolean {
  const normalizedHtml = input.html.toLowerCase();
  const normalizedUrl = (input.url ?? "").toLowerCase();
  const mitigated = (input.vercelMitigated ?? "").toLowerCase();

  if (mitigated === "challenge") {
    return true;
  }

  if (normalizedUrl.includes("security-checkpoint")) {
    return true;
  }

  if (
    normalizedHtml.includes("vercel security checkpoint") ||
    (normalizedHtml.includes("security checkpoint") &&
      normalizedHtml.includes("vercel"))
  ) {
    return true;
  }

  return false;
}

function hasVercelCheckpointSignal(input: {
  html: string;
  url?: string;
}): boolean {
  const normalizedHtml = input.html.toLowerCase();
  const normalizedUrl = (input.url ?? "").toLowerCase();

  if (normalizedUrl.includes("security-checkpoint")) {
    return true;
  }

  if (
    normalizedHtml.includes("vercel security checkpoint") ||
    (normalizedHtml.includes("security checkpoint") &&
      normalizedHtml.includes("vercel"))
  ) {
    return true;
  }

  return false;
}

async function waitForCheckpointRedirect(input: {
  page: BrowserPageLike;
  timeoutMs: number;
}): Promise<CheckpointWaitResult> {
  let detected = false;

  const maxAttempts = Math.max(
    6,
    Number(process.env.LOCALVR30A_QUOTE_CHECKPOINT_MAX_ATTEMPTS ?? "12") || 12,
  );
  const pauseMs = Math.max(
    250,
    Number(process.env.LOCALVR30A_QUOTE_CHECKPOINT_WAIT_MS ?? "500") || 500,
  );
  const hardDeadline = Date.now() + Math.max(input.timeoutMs, pauseMs * 2);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const currentUrl = input.page.url();
    let currentHtml = "";
    try {
      currentHtml = await input.page.content();
    } catch {
      currentHtml = "";
    }

    const checkpointDetected = hasVercelCheckpointSignal({
      html: currentHtml,
      url: currentUrl,
    });

    if (!checkpointDetected) {
      return {
        detected,
        resolved: detected,
        finalUrl: currentUrl,
      };
    }

    detected = true;

    if (Date.now() + pauseMs > hardDeadline) {
      break;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, pauseMs));
  }

  return {
    detected,
    resolved: false,
    finalUrl: input.page.url(),
  };
}

async function requestQuoteViaCloakBrowser(input: {
  endpoint: string;
  detailUrl: string;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  timeoutMs: number;
}): Promise<BrowserQuoteRequestResult> {
  const headless = readToggle("LOCALVR30A_QUOTE_HEADLESS", true);
  // Keep proxy behavior deterministic for localvr30a.
  // Runtime flags are intentionally not supported for this adapter.
  const useProxy = true;
  const requireProxy = true;
  const proxy = resolveProxy(useProxy);
  const userAgent =
    process.env.LOCALVR30A_QUOTE_USER_AGENT?.trim() || USER_AGENT;
  const persistentProfileExperimentEnabled = readToggle(
    "LOCALVR30A_QUOTE_EXPERIMENTAL_PERSISTENT_PROFILE",
    false,
  );
  const persistentProfileEnabled =
    readToggle("LOCALVR30A_QUOTE_PERSISTENT_PROFILE", false) &&
    persistentProfileExperimentEnabled;
  const persistentProfileDir = persistentProfileEnabled
    ? resolve(
        process.cwd(),
        process.env.LOCALVR30A_QUOTE_PERSISTENT_PROFILE_DIR?.trim() ||
          ".tmp/cloak-profiles/localvr30a",
        input.listingId
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-"),
      )
    : null;
  // Keep adapter strictly single-shot: one flow, one result.
  const maxAttempts = 1;
  const computedAttemptTimeoutDefault = Math.max(
    9000,
    Math.floor(input.timeoutMs * 0.55),
  );
  const attemptTimeoutMs = Math.max(
    3000,
    Math.min(
      input.timeoutMs,
      Number(
        process.env.LOCALVR30A_QUOTE_ATTEMPT_TIMEOUT_MS ??
          String(computedAttemptTimeoutDefault),
      ) || computedAttemptTimeoutDefault,
    ),
  );
  const navigationTimeoutMs = Math.min(
    20000,
    Math.max(attemptTimeoutMs * 2, 8000),
  );
  const retryDelayMs = 0;
  const computedNativeResponseTimeoutDefault = Math.max(
    6000,
    Math.floor(input.timeoutMs * 0.5),
  );
  const nativeResponseTimeoutMs = Math.max(
    4000,
    Math.min(
      input.timeoutMs,
      Number(
        process.env.LOCALVR30A_QUOTE_NATIVE_RESPONSE_TIMEOUT_MS ??
          String(computedNativeResponseTimeoutDefault),
      ) || computedNativeResponseTimeoutDefault,
    ),
  );
  const launchTimeoutMs = Math.max(
    8000,
    Math.min(
      input.timeoutMs,
      Number(process.env.LOCALVR30A_QUOTE_LAUNCH_TIMEOUT_MS ?? "25000") ||
        25000,
    ),
  );

  if (requireProxy && !proxy) {
    return {
      ok: false,
      status: 0,
      bodyText: "",
      requestError: "proxy_required_but_not_configured",
      vercelMitigated: null,
      diagnostics: {
        proxyRequired: true,
        proxyConfigured: false,
      },
    };
  }

  const diagnostics = {
    flowStartedAtMs: performance.now(),
    flowElapsedMs: 0,
    maxAttempts,
    attemptTimeoutMs,
    navigationTimeoutMs,
    nativeResponseTimeoutMs,
    retryDelayMs,
    attempts: 0,
    gotoStatuses: [] as number[],
    checkpointWaitCount: 0,
    checkpointDetectedCount: 0,
    checkpointResolvedCount: 0,
    nativePostObservedCount: 0,
    retryChallengeCount: 0,
    retryNoNativePostCount: 0,
    retryEmptyBodyCount: 0,
    lastResponseStatus: null as number | null,
    attemptTimings: [] as Array<Record<string, unknown>>,
    currentStage: "init",
  };

  const traceStage = async (
    stage: string,
    details?: Record<string, unknown>,
  ): Promise<void> => {
    diagnostics.currentStage = stage;
    await writeTraceLog({
      listingId: input.listingId,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      stage,
      details,
    });
  };

  let browser: BrowserLike | null = null;
  let context: BrowserContextLike | null = null;

  try {
    await traceStage("launch_browser", {
      launchTimeoutMs,
      headless,
      hasProxy: Boolean(proxy),
      persistentProfileExperimentEnabled,
      persistentProfileEnabled,
      persistentProfileDir,
    });
    await traceStage("create_context");
    if (persistentProfileEnabled && persistentProfileDir) {
      await mkdir(persistentProfileDir, { recursive: true });
      context = await withTimeout({
        promise: launchPersistentCloakContext({
          userDataDir: persistentProfileDir,
          headless,
          userAgent,
          ...(proxy ? { proxy } : {}),
        }) as unknown as Promise<BrowserContextLike>,
        timeoutMs: launchTimeoutMs,
        timeoutMessage: `cloakbrowser_persistent_context_launch_timeout_${launchTimeoutMs}ms`,
      });
    } else {
      browser = (await withTimeout({
        promise: launchCloakBrowser({
          headless,
          ...(proxy ? { proxy } : {}),
        }) as unknown as Promise<BrowserLike>,
        timeoutMs: launchTimeoutMs,
        timeoutMessage: `cloakbrowser_launch_timeout_${launchTimeoutMs}ms`,
      })) as unknown as BrowserLike;

      context = await withTimeout({
        promise: browser.newContext({
          userAgent,
          ignoreHTTPSErrors: false,
        }),
        timeoutMs: Math.max(4000, Math.min(launchTimeoutMs, 12000)),
        timeoutMessage: "create_context_timeout",
      });
    }

    await traceStage("create_page");
    const page = await withTimeout({
      promise: context.newPage(),
      timeoutMs: Math.max(4000, Math.min(launchTimeoutMs, 12000)),
      timeoutMessage: "create_page_timeout",
    });

    let recentNetworkEvents: Array<Record<string, unknown>> = [];
    const pushNetworkEvent = (event: Record<string, unknown>): void => {
      recentNetworkEvents.push(event);
      if (recentNetworkEvents.length > 100) {
        recentNetworkEvents = recentNetworkEvents.slice(-100);
      }
    };

    const requestListener = (...args: unknown[]): void => {
      const requestLike = args[0] as
        | {
            method?: () => string;
            url?: () => string;
          }
        | undefined;
      pushNetworkEvent({
        ts: new Date().toISOString(),
        kind: "request",
        method: requestLike?.method?.() ?? null,
        url: requestLike?.url?.() ?? null,
      });
    };

    const responseListener = (...args: unknown[]): void => {
      const responseLike = args[0] as
        | {
            status?: () => number;
            request?: () => { method?: () => string; url?: () => string };
          }
        | undefined;
      const responseRequest = responseLike?.request?.();
      pushNetworkEvent({
        ts: new Date().toISOString(),
        kind: "response",
        status: responseLike?.status?.() ?? null,
        method: responseRequest?.method?.() ?? null,
        url: responseRequest?.url?.() ?? null,
      });
    };

    const requestFailedListener = (...args: unknown[]): void => {
      const requestLike = args[0] as
        | {
            method?: () => string;
            url?: () => string;
            failure?: () => { errorText?: string } | null;
          }
        | undefined;
      pushNetworkEvent({
        ts: new Date().toISOString(),
        kind: "request_failed",
        method: requestLike?.method?.() ?? null,
        url: requestLike?.url?.() ?? null,
        error: requestLike?.failure?.()?.errorText ?? null,
      });
    };

    page.on?.("request", requestListener);
    page.on?.("response", responseListener);
    page.on?.("requestfailed", requestFailedListener);

    const heartbeatHandle = setInterval(() => {
      void writeTraceLog({
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        stage: "heartbeat",
        details: {
          currentStage: diagnostics.currentStage,
          elapsedMs: Math.round(
            performance.now() - diagnostics.flowStartedAtMs,
          ),
          attempts: diagnostics.attempts,
          gotoStatuses: diagnostics.gotoStatuses,
          recentNetworkEvents: recentNetworkEvents.slice(-12),
        },
      });
    }, 1000);
    heartbeatHandle.unref();

    try {
      let latestChallengeStatus = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const attemptTiming: Record<string, unknown> = {
          attempt,
          startedAtMs: performance.now(),
        };
        diagnostics.attemptTimings.push(attemptTiming);

        // Start listening before navigation so we never miss the immediate
        // post-seed quote request that the live page dispatches on load.
        attemptTiming.nativeResponseWaitStartedAtMs = performance.now();
        let postCandidatesSeen = 0;
        let postPathMatchedCount = 0;
        let postDateMismatchCount = 0;
        let matchedRequestUrl: string | null = null;
        let matchedRequestHeaders: Record<string, string> | null = null;
        let matchedRequestPostData: string | null = null;
        const nativeResponsePromise = page
          .waitForResponse(
            (candidate) => {
              const request = candidate.request();
              if (request.method().toUpperCase() !== "POST") {
                return false;
              }

              postCandidatesSeen += 1;

              try {
                const req = new URL(request.url());
                const endpoint = new URL(input.endpoint);
                const sameOrigin = req.origin === endpoint.origin;
                const propertyPath = req.pathname.startsWith("/property/");
                const pathHasListingId = req.pathname.includes(input.listingId);
                const sameOriginPath =
                  sameOrigin && propertyPath && pathHasListingId;
                const candidateCheckIn = req.searchParams.get("checkIn");
                const candidateCheckOut = req.searchParams.get("checkOut");
                const dateMatched =
                  candidateCheckIn === input.checkInIso &&
                  candidateCheckOut === input.checkOutIso;

                if (sameOriginPath) {
                  postPathMatchedCount += 1;
                  if (!dateMatched) {
                    postDateMismatchCount += 1;
                  }
                }

                if (postCandidatesSeen <= 25 || postCandidatesSeen % 20 === 0) {
                  void writeTraceLog({
                    listingId: input.listingId,
                    checkInIso: input.checkInIso,
                    checkOutIso: input.checkOutIso,
                    stage: `attempt_${attempt}_candidate_post`,
                    details: {
                      postCandidatesSeen,
                      postPathMatchedCount,
                      postDateMismatchCount,
                      requestUrl: request.url(),
                      sameOriginPath,
                      sameOrigin,
                      propertyPath,
                      pathHasListingId,
                      dateMatched,
                      candidateCheckIn,
                      candidateCheckOut,
                    },
                  });
                }

                if (sameOriginPath && dateMatched) {
                  matchedRequestUrl = request.url();
                  matchedRequestHeaders = request.headers();
                  matchedRequestPostData = request.postData();
                }

                return sameOriginPath && dateMatched;
              } catch {
                return false;
              }
            },
            { timeout: nativeResponseTimeoutMs },
          )
          .catch(() => null);

        diagnostics.attempts = attempt;
        await traceStage(`attempt_${attempt}_goto`);

        attemptTiming.gotoStartedAtMs = performance.now();
        const gotoResponse = await withTimeout({
          promise: page.goto(input.endpoint, {
            waitUntil: "domcontentloaded",
            timeout: navigationTimeoutMs,
          }),
          timeoutMs: navigationTimeoutMs + 1500,
          timeoutMessage: `goto_timeout_${navigationTimeoutMs + 1500}ms`,
        });
        attemptTiming.gotoCompletedAtMs = performance.now();

        const gotoStatus = gotoResponse?.status() ?? null;
        await traceStage(`attempt_${attempt}_goto_done`, {
          attempt,
          gotoStatus,
          status: gotoStatus,
        });
        if (typeof gotoStatus === "number" && Number.isFinite(gotoStatus)) {
          diagnostics.gotoStatuses.push(gotoStatus);
        }

        diagnostics.checkpointWaitCount += 1;
        await traceStage(`attempt_${attempt}_checkpoint_wait`);
        attemptTiming.checkpointWaitStartedAtMs = performance.now();
        const checkpointResult = await withTimeout({
          promise: waitForCheckpointRedirect({
            page,
            timeoutMs: attemptTimeoutMs,
          }),
          timeoutMs: Math.max(attemptTimeoutMs + 1000, 5000),
          timeoutMessage: `checkpoint_wait_timeout_${Math.max(attemptTimeoutMs + 1000, 5000)}ms`,
        });
        attemptTiming.checkpointWaitCompletedAtMs = performance.now();
        if (checkpointResult.detected) {
          diagnostics.checkpointDetectedCount += 1;
        }
        if (checkpointResult.resolved) {
          diagnostics.checkpointResolvedCount += 1;
        }
        attemptTiming.checkpointDetected = checkpointResult.detected;
        attemptTiming.checkpointResolved = checkpointResult.resolved;

        if (checkpointResult.detected && !checkpointResult.resolved) {
          attemptTiming.outcome = "checkpoint_not_resolved";
          latestChallengeStatus = 429;
          if (attempt < maxAttempts) {
            diagnostics.retryChallengeCount += 1;
            await new Promise<void>((resolve) =>
              setTimeout(resolve, retryDelayMs),
            );
            attemptTiming.completedAtMs = performance.now();
            attemptTiming.elapsedMs =
              Number(attemptTiming.completedAtMs) -
              Number(attemptTiming.startedAtMs);
            continue;
          }

          diagnostics.flowElapsedMs =
            performance.now() - diagnostics.flowStartedAtMs;
          return {
            ok: false,
            status: 429,
            bodyText: "",
            requestError: `security_checkpoint_persisted final_url=${checkpointResult.finalUrl}`,
            vercelMitigated: "challenge",
            diagnostics,
          };
        }

        await traceStage(`attempt_${attempt}_wait_native_post`, {
          postCandidatesSeen,
          postPathMatchedCount,
          postDateMismatchCount,
        });
        const nativeResponse = await withTimeout({
          promise: nativeResponsePromise,
          timeoutMs: nativeResponseTimeoutMs + 1500,
          timeoutMessage: `native_post_external_timeout_${nativeResponseTimeoutMs + 1500}ms`,
        }).catch(async () => {
          await traceStage(`attempt_${attempt}_wait_native_post_timeout`, {
            nativeResponseTimeoutMs,
            externalTimeoutMs: nativeResponseTimeoutMs + 1500,
          });
          return null;
        });
        await traceStage(`attempt_${attempt}_wait_native_post_done`, {
          attempt,
          status: nativeResponse?.status() ?? null,
        });
        attemptTiming.nativeResponseObservedAtMs = performance.now();
        if (!nativeResponse) {
          attemptTiming.outcome = "native_post_not_observed";
          if (attempt < maxAttempts) {
            diagnostics.retryNoNativePostCount += 1;
            await new Promise<void>((resolve) =>
              setTimeout(resolve, retryDelayMs),
            );
            attemptTiming.completedAtMs = performance.now();
            attemptTiming.elapsedMs =
              Number(attemptTiming.completedAtMs) -
              Number(attemptTiming.startedAtMs);
            continue;
          }
          diagnostics.flowElapsedMs =
            performance.now() - diagnostics.flowStartedAtMs;
          return {
            ok: false,
            status: 0,
            bodyText: "",
            requestError: "native_quote_post_not_observed",
            vercelMitigated: null,
            diagnostics,
          };
        }
        diagnostics.nativePostObservedCount += 1;

        let nativeBodyText = "";
        let nativeBodyReadError: string | null = null;
        await traceStage(`attempt_${attempt}_read_native_body`);
        try {
          nativeBodyText = await withTimeout({
            promise: nativeResponse.text(),
            timeoutMs: Math.max(2500, Math.min(12000, nativeResponseTimeoutMs)),
            timeoutMessage: "native_body_read_timeout",
          });
        } catch (error) {
          nativeBodyReadError =
            error instanceof Error ? error.message : String(error);
          nativeBodyText = "";
        }

        if (nativeBodyText.trim().length === 0) {
          try {
            const nativeBodyBuffer = await withTimeout({
              promise: nativeResponse.body(),
              timeoutMs: Math.max(
                2500,
                Math.min(12000, nativeResponseTimeoutMs),
              ),
              timeoutMessage: "native_body_buffer_read_timeout",
            });
            if (nativeBodyBuffer.length > 0) {
              nativeBodyText = nativeBodyBuffer.toString("utf8");
            }
          } catch (error) {
            if (!nativeBodyReadError) {
              nativeBodyReadError =
                error instanceof Error ? error.message : String(error);
            }
          }
        }

        if (
          nativeBodyText.trim().length === 0 &&
          matchedRequestUrl &&
          matchedRequestHeaders &&
          matchedRequestPostData
        ) {
          const allowedReplayHeaders = new Set([
            "accept",
            "accept-language",
            "baggage",
            "cache-control",
            "content-type",
            "next-action",
            "next-router-state-tree",
            "origin",
            "pragma",
            "referer",
            "rsc",
            "sentry-trace",
            "x-nextjs-data",
          ]);
          const replayHeaders: Record<string, string> = {};
          for (const [headerKey, headerValue] of Object.entries(
            matchedRequestHeaders,
          )) {
            const normalized = headerKey.toLowerCase();
            if (!allowedReplayHeaders.has(normalized)) {
              continue;
            }
            replayHeaders[normalized] = headerValue;
          }
          if (!replayHeaders.accept) {
            replayHeaders.accept = "text/x-component";
          }

          await traceStage(`attempt_${attempt}_read_native_body_replay_start`, {
            hasNextAction: Boolean(replayHeaders["next-action"]),
            hasRouterStateTree: Boolean(
              replayHeaders["next-router-state-tree"],
            ),
            postDataLength: matchedRequestPostData.length,
          });

          const replayResult = await withTimeout({
            promise: page.evaluate(
              async (payload) => {
                try {
                  const replayResponse = await fetch(payload.url, {
                    method: "POST",
                    headers: payload.headers,
                    body: payload.body,
                    credentials: "include",
                    mode: "same-origin",
                  });
                  const replayText = await replayResponse.text();
                  return {
                    ok: replayResponse.ok,
                    status: replayResponse.status,
                    contentType: replayResponse.headers.get("content-type"),
                    text: replayText,
                    error: null,
                  };
                } catch (error) {
                  return {
                    ok: false,
                    status: 0,
                    contentType: null,
                    text: "",
                    error:
                      error instanceof Error ? error.message : String(error),
                  };
                }
              },
              {
                url: matchedRequestUrl,
                headers: replayHeaders,
                body: matchedRequestPostData,
              },
            ),
            timeoutMs: Math.max(3000, Math.min(15000, nativeResponseTimeoutMs)),
            timeoutMessage: "native_body_replay_timeout",
          }).catch((error) => ({
            ok: false,
            status: 0,
            contentType: null,
            text: "",
            error: error instanceof Error ? error.message : String(error),
          }));

          await traceStage(`attempt_${attempt}_read_native_body_replay_done`, {
            status: replayResult.status,
            ok: replayResult.ok,
            contentType: replayResult.contentType,
            bodyLength: replayResult.text.length,
            error: replayResult.error,
          });

          if (replayResult.text.trim().length > 0) {
            nativeBodyText = replayResult.text;
            nativeBodyReadError = null;
          } else if (replayResult.error && !nativeBodyReadError) {
            nativeBodyReadError = replayResult.error;
          }
        }

        await traceStage(`attempt_${attempt}_read_native_body_done`, {
          status: nativeResponse.status(),
          bodyLength: nativeBodyText.length,
          contentType: nativeResponse.headers()["content-type"] ?? null,
          contentLength: nativeResponse.headers()["content-length"] ?? null,
          bodyReadError: nativeBodyReadError,
        });
        attemptTiming.nativeBodyReadAtMs = performance.now();
        attemptTiming.nativeBodyLength = nativeBodyText.length;

        if (nativeBodyText.trim().length === 0) {
          attemptTiming.outcome = "native_post_empty_body";
          if (attempt < maxAttempts) {
            diagnostics.retryEmptyBodyCount += 1;
            await new Promise<void>((resolve) =>
              setTimeout(resolve, retryDelayMs),
            );
            attemptTiming.completedAtMs = performance.now();
            attemptTiming.elapsedMs =
              Number(attemptTiming.completedAtMs) -
              Number(attemptTiming.startedAtMs);
            continue;
          }

          diagnostics.flowElapsedMs =
            performance.now() - diagnostics.flowStartedAtMs;
          return {
            ok: false,
            status: nativeResponse.status(),
            bodyText: "",
            requestError: "native_quote_post_empty_body",
            vercelMitigated:
              nativeResponse.headers()["x-vercel-mitigated"] ?? null,
            diagnostics,
          };
        }

        const response = {
          ok: nativeResponse.ok(),
          status: nativeResponse.status(),
          bodyText: nativeBodyText,
          requestError: null,
          vercelMitigated:
            nativeResponse.headers()["x-vercel-mitigated"] ?? null,
          diagnostics,
        };
        diagnostics.lastResponseStatus = response.status;

        const transientRequestError =
          !!response.requestError &&
          /abort|timeout|network|failed/i.test(response.requestError);
        if (transientRequestError && attempt < maxAttempts) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, retryDelayMs),
          );
          continue;
        }

        const challengeDetected = hasCheckpointSignal({
          html: response.bodyText,
          url: page.url(),
          vercelMitigated: response.vercelMitigated,
        });

        const retriableChallenge = response.status === 429 || challengeDetected;
        if (retriableChallenge && attempt < maxAttempts) {
          attemptTiming.outcome = "challenge_retry";
          latestChallengeStatus = response.status || 429;
          diagnostics.retryChallengeCount += 1;
          await new Promise<void>((resolve) =>
            setTimeout(resolve, retryDelayMs),
          );
          attemptTiming.completedAtMs = performance.now();
          attemptTiming.elapsedMs =
            Number(attemptTiming.completedAtMs) -
            Number(attemptTiming.startedAtMs);
          continue;
        }

        if (retriableChallenge && !response.ok) {
          attemptTiming.outcome = "challenge_final_failure";
          attemptTiming.completedAtMs = performance.now();
          attemptTiming.elapsedMs =
            Number(attemptTiming.completedAtMs) -
            Number(attemptTiming.startedAtMs);
          diagnostics.flowElapsedMs =
            performance.now() - diagnostics.flowStartedAtMs;
          return {
            ...response,
            status: response.status || latestChallengeStatus || 429,
          };
        }

        attemptTiming.outcome = "success";
        await traceStage(`attempt_${attempt}_success`);
        attemptTiming.completedAtMs = performance.now();
        attemptTiming.elapsedMs =
          Number(attemptTiming.completedAtMs) -
          Number(attemptTiming.startedAtMs);
        diagnostics.flowElapsedMs =
          performance.now() - diagnostics.flowStartedAtMs;
        return response;
      }

      diagnostics.flowElapsedMs =
        performance.now() - diagnostics.flowStartedAtMs;
      return {
        ok: false,
        status: latestChallengeStatus || 429,
        bodyText: "",
        requestError: "quote_attempts_exhausted_after_challenge",
        vercelMitigated: "challenge",
        diagnostics,
      };
    } catch (error: unknown) {
      await writeTraceLog({
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        stage: "exception",
        details: {
          currentStage: diagnostics.currentStage,
          message: error instanceof Error ? error.message : String(error),
        },
      });
      diagnostics.flowElapsedMs =
        performance.now() - diagnostics.flowStartedAtMs;
      return {
        ok: false,
        status: 0,
        bodyText: "",
        requestError:
          error instanceof Error
            ? error.message
            : "Unknown browser request error",
        vercelMitigated: null,
        diagnostics,
      };
    } finally {
      clearInterval(heartbeatHandle);
      page.off?.("request", requestListener);
      page.off?.("response", responseListener);
      page.off?.("requestfailed", requestFailedListener);

      await traceStage("cleanup_page_close");
      const pageClosed = await closeWithTimeout({
        promise: page.close(),
        timeoutMs: 5000,
        timeoutMessage: "page_close_timeout_5000ms",
      });
      if (!pageClosed) {
        await traceStage("cleanup_page_close_timeout");
      }
    }
  } catch (error: unknown) {
    diagnostics.flowElapsedMs = performance.now() - diagnostics.flowStartedAtMs;
    return {
      ok: false,
      status: 0,
      bodyText: "",
      requestError:
        error instanceof Error
          ? error.message
          : "Unknown browser request error",
      vercelMitigated: null,
      diagnostics,
    };
  } finally {
    await traceStage("cleanup_context_close");
    if (context) {
      const contextClosed = await closeWithTimeout({
        promise: context.close(),
        timeoutMs: 5000,
        timeoutMessage: "context_close_timeout_5000ms",
      });
      if (!contextClosed) {
        await traceStage("cleanup_context_close_timeout");
      }
    }
    await traceStage("cleanup_browser_close");
    if (browser) {
      const browserClosed = await closeWithTimeout({
        promise: browser.close(),
        timeoutMs: 5000,
        timeoutMessage: "browser_close_timeout_5000ms",
      });
      if (!browserClosed) {
        await traceStage("cleanup_browser_close_timeout");
        await forceTerminateBrowser(browser);
        await traceStage("cleanup_browser_force_terminate");
      }
    }
  }
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

function buildPropertyQuoteUrl(input: {
  detailUrl: string;
  adults: number;
  children: number;
  checkInDate: string;
  checkOutDate: string;
}): string {
  const parsed = new URL(input.detailUrl);
  parsed.searchParams.set(
    "guests",
    String(Math.max(1, input.adults + input.children)),
  );
  parsed.searchParams.set("adults", String(Math.max(1, input.adults)));
  parsed.searchParams.set("children", String(Math.max(0, input.children)));
  parsed.searchParams.set("infants", "0");
  parsed.searchParams.set("checkIn", input.checkInDate);
  parsed.searchParams.set("checkOut", input.checkOutDate);
  return parsed.toString();
}

function extractQuoteContext(
  input: QuoteExecutionRequest,
): LocalVrQuoteContext {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? input.quoteContext
      : null;

  const listingId =
    asString(context?.listing_id) ??
    asString(context?.property_id) ??
    asString(context?.unit_id);
  if (!listingId) {
    throw new Error(
      `Missing required quoteContext.listing_id for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const detailUrl = asString(context?.detail_url);
  if (!detailUrl) {
    throw new Error(
      `Missing required quoteContext.detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  return {
    listingId,
    detailUrl,
  };
}

export async function executeLocalvr30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  let quoteContext: LocalVrQuoteContext;
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

  const endpoint = buildPropertyQuoteUrl({
    detailUrl: quoteContext.detailUrl,
    adults: input.adults,
    children: input.children,
    checkInDate: input.checkInIso,
    checkOutDate: input.checkOutIso,
  });

  let body = "";
  let rows: Array<Record<string, unknown>> = [];
  let responseOk = false;
  let responseStatus = 0;
  let runtimeDiagnostics: Record<string, unknown> = {};

  try {
    const browserResult = await requestQuoteViaCloakBrowser({
      endpoint,
      detailUrl: quoteContext.detailUrl,
      listingId: quoteContext.listingId,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      adults: input.adults,
      children: input.children,
      timeoutMs,
    });

    runtimeDiagnostics = browserResult.diagnostics;

    if (browserResult.requestError) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: /abort|timeout/i.test(browserResult.requestError)
            ? "QUOTE_TIMEOUT"
            : "QUOTE_REQUEST_FAILED",
          message: browserResult.requestError,
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            diagnostics: runtimeDiagnostics,
          },
        }),
      };
    }

    responseOk = browserResult.ok;
    responseStatus = browserResult.status;
    body = browserResult.bodyText;
    rows = parseFlightObjects(body);
    runtimeDiagnostics = {
      ...runtimeDiagnostics,
      responseStatus,
      responseBodyLength: body.length,
      parsedRowCount: rows.length,
    };
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error && /abort|timeout/i.test(error.message)
        ? `Quote request timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : "Quote request failed";

    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code:
          error instanceof Error && /abort|timeout/i.test(error.message)
            ? "QUOTE_TIMEOUT"
            : "QUOTE_REQUEST_FAILED",
        message: errorMessage,
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          diagnostics: runtimeDiagnostics,
        },
      }),
    };
  }

  const quote = pickQuoteRecord(rows);
  const errorPayload = pickErrorRecord(rows);
  const errorCode = asString(errorPayload?.error?.code);
  const errorMessage = asString(errorPayload?.error?.message);

  if (!responseOk || !quote) {
    const reasonParts = [] as string[];
    if (!responseOk) {
      reasonParts.push(`http_${responseStatus}`);
    }
    if (errorCode) {
      reasonParts.push(errorCode);
    }
    if (errorMessage) {
      reasonParts.push(errorMessage);
    }

    if (!quote) {
      runtimeDiagnostics = {
        ...runtimeDiagnostics,
        responseBodyPreview:
          body.length > 240 ? `${body.slice(0, 240)}...` : body,
      };
    }

    return {
      success: true,
      elapsedMs: performance.now() - startedAt,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: false,
        quoteUnavailableReason:
          reasonParts.join("; ") || "quote_response_missing_or_invalid",
        currency: "USD",
        baseTotal: null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: null,
        quotedTotal: null,
        handoffUrl: endpoint,
        diagnostics: runtimeDiagnostics,
      },
    };
  }

  const money = quote.rates?.ratePlans?.[0]?.ratePlan?.money;
  const currency = asString(money?.currency) ?? "USD";
  const baseTotal =
    toFiniteNumber(money?.fareAccommodationAdjusted) ??
    toFiniteNumber(money?.fareAccommodation);
  const taxesTotal = toFiniteNumber(money?.totalTaxes);
  const feesTotal = toFiniteNumber(money?.totalFees);
  const grandTotal = toFiniteNumber(money?.hostPayout);

  const invoiceItems = Array.isArray(money?.invoiceItems)
    ? (money?.invoiceItems as LocalVrInvoiceItem[])
    : [];
  const feeLines: Array<{ name: string; amount: number }> = [];
  for (const item of invoiceItems) {
    const name = asString(item.title);
    const type = asString(item.type);
    const amount = toFiniteNumber(item.amount);
    if (!name || amount === null) {
      continue;
    }
    if (type === "TAX" || type === "ACCOMMODATION_FARE") {
      continue;
    }
    feeLines.push({ name, amount: roundCurrency(amount) });
  }

  const handoffUrl = buildPropertyQuoteUrl({
    detailUrl: quoteContext.detailUrl,
    adults: input.adults,
    children: input.children,
    checkInDate:
      asString(quote.checkInDateLocalized) ??
      asString(quote.stay?.[0]?.checkInDateLocalized) ??
      input.checkInIso,
    checkOutDate:
      asString(quote.checkOutDateLocalized) ??
      asString(quote.stay?.[0]?.checkOutDateLocalized) ??
      input.checkOutIso,
  });

  const roundedBase = baseTotal === null ? null : roundCurrency(baseTotal);
  const roundedTaxes = taxesTotal === null ? null : roundCurrency(taxesTotal);
  const roundedFees = feesTotal === null ? null : roundCurrency(feesTotal);
  const roundedGrand = grandTotal === null ? null : roundCurrency(grandTotal);
  const unavailableReason = validateAvailableTotals({
    baseTotal: roundedBase,
    taxesTotal: roundedTaxes,
    feesTotal: roundedFees,
    grandTotal: roundedGrand,
  });
  const available = unavailableReason === null;

  return {
    success: true,
    elapsedMs: performance.now() - startedAt,
    observation: {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: available,
      quoteUnavailableReason: available ? null : unavailableReason,
      currency,
      baseTotal: available ? roundedBase : null,
      taxesTotal: available ? roundedTaxes : null,
      feesTotalExclTaxes: available ? roundedFees : null,
      grandTotal: available ? roundedGrand : null,
      quotedTotal: available ? roundedGrand : null,
      handoffUrl,
      diagnostics: runtimeDiagnostics,
    },
  };
}
