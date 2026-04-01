import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CanonicalQuoteObservation,
  CanonicalQuotesSidecarRecord,
} from "@/lib/pricing/contracts/quote-observations-contract";

type TargetWindow = {
  listingId: string;
  startDate: string;
  endDate: string;
};

type CliOptions = {
  adapterKey: string;
  dryRun: boolean;
  targets: TargetWindow[];
};

type RefreshResult = {
  total: number;
  baseTotal: number | null;
  taxesTotal: number | null;
};

const DEFAULT_RETRY_DELAYS_MS = [0, 1000, 2500, 5000, 9000];

let httpActive = 0;
let httpLastStartMs = 0;
const httpWaiters: Array<() => void> = [];

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function ratio(numerator: number, denominator: number): number {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return 0;
  }
  return Number((numerator / denominator).toFixed(6));
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
  return DEFAULT_RETRY_DELAYS_MS;
}

function getRetryDelaysMs(): number[] {
  return parseRetryDelaysMs(
    process.env.ESCAPES30A_HANDOFF_AJAX_RETRY_DELAYS_MS ??
      process.env.ESCAPES30A_QUOTE_AJAX_RETRY_DELAYS_MS ??
      "",
  );
}

function getHttpConcurrencyLimit(): number {
  const parsed = Number(
    process.env.QUOTE_HANDOFF_HTTP_CONCURRENCY ??
      process.env.ESCAPES30A_QUOTE_HTTP_CONCURRENCY ??
      "2",
  );
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 2;
  }
  return Math.floor(parsed);
}

function getHttpMinGapMs(): number {
  const parsed = Number(
    process.env.QUOTE_HANDOFF_HTTP_MIN_GAP_MS ??
      process.env.ESCAPES30A_QUOTE_HTTP_MIN_GAP_MS ??
      "300",
  );
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 300;
  }
  return Math.floor(parsed);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireHttpSlot(): Promise<void> {
  while (true) {
    if (httpActive < getHttpConcurrencyLimit()) {
      httpActive += 1;
      break;
    }
    await new Promise<void>((resolve) => {
      httpWaiters.push(resolve);
    });
  }

  const minGapMs = getHttpMinGapMs();
  const waitMs = httpLastStartMs + minGapMs - Date.now();
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  httpLastStartMs = Date.now();
}

function releaseHttpSlot(): void {
  httpActive = Math.max(0, httpActive - 1);
  const next = httpWaiters.shift();
  next?.();
}

async function withRateLimit<T>(task: () => Promise<T>): Promise<T> {
  await acquireHttpSlot();
  try {
    return await task();
  } finally {
    releaseHttpSlot();
  }
}

function parseSetCookieHeader(setCookie: string): string[] {
  if (!setCookie) {
    return [];
  }
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

function parseMoney(value: string): number | null {
  const parsed = Number(value.replace(/,/g, "").trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return roundMoney(parsed);
}

function extractEscapesAjaxPath(handoffHtml: string): string {
  const pattern = /(["'])([^"']*get-booknow-rates\.cfm[^"']*)\1/i;
  const match = handoffHtml.match(pattern);
  const extracted = match?.[2]?.trim() ?? "";

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

function parse30AEscapesTotalsFromAjax(html: string): RefreshResult | null {
  const totalAmountMatch = html.match(
    /Total\s*Amount<\/td>\s*<td>\$\s*([0-9,]+(?:\.[0-9]{2})?)<\/td>/i,
  );
  const rentMatch = html.match(
    /Rent<\/td>\s*<td[^>]*>[\s\S]*?\$\s*([0-9,]+(?:\.[0-9]{2})?)\s*<\/td>/i,
  );
  const taxesMatch = html.match(
    /Taxes<\/td>\s*<td>\$\s*([0-9,]+(?:\.[0-9]{2})?)<\/td>/i,
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
  const total =
    (totalFromTable !== null && totalFromTable > 0 ? totalFromTable : null) ??
    (totalFromScript !== null && totalFromScript > 0 ? totalFromScript : null);

  if (total === null) {
    return null;
  }

  return {
    total,
    baseTotal: rentMatch?.[1] ? parseMoney(rentMatch[1]) : null,
    taxesTotal: taxesMatch?.[1] ? parseMoney(taxesMatch[1]) : null,
  };
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  const delays = getRetryDelaysMs();

  let lastError = "unknown";
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    const delayMs = delays[attempt] ?? 0;
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      const response = await withRateLimit(() => fetch(url, init));
      if (response.ok) {
        return response;
      }
      lastError = `${label} HTTP ${response.status}`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < delays.length - 1) {
      const nextDelayMs = delays[attempt + 1] ?? 0;
      console.log(
        `retry ${attempt + 1}/${delays.length} label=${label} failed; next_delay_ms=${nextDelayMs}`,
      );
    }
  }

  throw new Error(`${label} failed after retries: ${lastError}`);
}

async function pullTotalsFromHandoff(input: {
  handoffUrl: string;
  detailUrl: string;
}): Promise<RefreshResult> {
  const parsed = new URL(input.handoffUrl);
  const propertyid = parsed.searchParams.get("propertyid")?.trim() ?? "";
  const strcheckin = parsed.searchParams.get("strcheckin")?.trim() ?? "";
  const strcheckout = parsed.searchParams.get("strcheckout")?.trim() ?? "";

  if (!propertyid || !strcheckin || !strcheckout) {
    throw new Error("handoff_url missing required query params");
  }

  const handoffResponse = await fetchWithRetry(
    input.handoffUrl,
    {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": "Mozilla/5.0",
        referer: input.detailUrl,
      },
    },
    "handoff_page",
  );

  const handoffHtml = await handoffResponse.text();
  const cookieHeader = buildCookieHeader(
    parseSetCookieHeader(handoffResponse.headers.get("set-cookie") ?? ""),
  );

  const ajaxPath = extractEscapesAjaxPath(handoffHtml);
  const ajaxUrl = new URL(ajaxPath, parsed.origin);
  ajaxUrl.searchParams.set("propertyid", propertyid);
  ajaxUrl.searchParams.set("strcheckin", strcheckin);
  ajaxUrl.searchParams.set("strcheckout", strcheckout);
  ajaxUrl.searchParams.set("_", String(Date.now()));

  const ajaxResponse = await fetchWithRetry(
    ajaxUrl.toString(),
    {
      headers: {
        accept: "text/html, */*;q=0.1",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": "Mozilla/5.0",
        referer: input.handoffUrl,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
    },
    "handoff_ajax",
  );

  const ajaxHtml = await ajaxResponse.text();
  const lowered = ajaxHtml.toLowerCase();
  if (
    lowered.includes("property is not available") ||
    lowered.includes("unit has no availability")
  ) {
    throw new Error("handoff ajax indicates unavailable window");
  }

  const totals = parse30AEscapesTotalsFromAjax(ajaxHtml);
  if (!totals) {
    throw new Error("handoff ajax payload missing total amount");
  }
  return totals;
}

function parseArgs(argv: string[]): CliOptions {
  let adapterKey = "30aescapes";
  let dryRun = false;
  const targets: TargetWindow[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--adapter-key" && value) {
      adapterKey = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg === "--target" && value) {
      const [listingId, startDate, endDate] = value
        .split(":")
        .map((item) => item.trim());
      if (listingId && startDate && endDate) {
        targets.push({ listingId, startDate, endDate });
      }
      index += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return { adapterKey, dryRun, targets };
}

function refreshObservation(
  observation: CanonicalQuoteObservation,
  totals: RefreshResult,
): CanonicalQuoteObservation {
  const nights = Math.max(1, Number(observation.nights) || 7);
  const baseTotal =
    totals.baseTotal ??
    observation.base_total ??
    roundMoney(totals.total / 1.12);
  const taxesTotal = totals.taxesTotal ?? observation.taxes_total ?? 0;
  const feesTotal = Math.max(
    0,
    roundMoney(totals.total - baseTotal - taxesTotal),
  );

  return {
    ...observation,
    sampled_at: new Date().toISOString(),
    captured_at: new Date().toISOString(),
    quote_available: true,
    quote_unavailable_reason: null,
    base_total: roundMoney(baseTotal),
    taxes_total: roundMoney(taxesTotal),
    fees_total_excl_taxes: roundMoney(feesTotal),
    grand_total: roundMoney(totals.total),
    quoted_total: roundMoney(totals.total),
    base_nightly: roundMoney(baseTotal / nights),
    all_in_nightly: roundMoney(totals.total / nights),
    fee_pct_of_base: ratio(feesTotal, baseTotal),
    tax_pct_of_base: ratio(taxesTotal, baseTotal),
    non_base_pct_of_total: ratio(
      Math.max(0, totals.total - baseTotal),
      totals.total,
    ),
    all_in_multiplier: ratio(totals.total, baseTotal),
    source: "quote_api",
  };
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (options.adapterKey !== "30aescapes") {
    console.error(`Unsupported adapter for this script: ${options.adapterKey}`);
    return 1;
  }

  if (options.targets.length === 0) {
    console.error(
      "No targets provided. Use --target listing:start:end (repeatable).",
    );
    return 1;
  }

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

  let updatedCount = 0;

  for (const target of options.targets) {
    const quotePath = resolve(quotesDir, `${target.listingId}.json`);
    const raw = await readFile(quotePath, "utf8");
    const sidecar = JSON.parse(raw) as CanonicalQuotesSidecarRecord;

    const observationIndex = sidecar.observations.findIndex(
      (observation) =>
        observation.start_date === target.startDate &&
        observation.end_date === target.endDate,
    );

    if (observationIndex < 0) {
      throw new Error(
        `No observation found for listing=${target.listingId} window=${target.startDate}->${target.endDate}`,
      );
    }

    const observation = sidecar.observations[observationIndex]!;
    if (
      typeof observation.handoff_url !== "string" ||
      !observation.handoff_url
    ) {
      throw new Error(
        `Missing handoff_url for listing=${target.listingId} window=${target.startDate}->${target.endDate}`,
      );
    }

    console.log(
      `refreshing listing=${target.listingId} window=${target.startDate}->${target.endDate}`,
    );

    const totals = await pullTotalsFromHandoff({
      handoffUrl: observation.handoff_url,
      detailUrl: sidecar.detail_url,
    });

    const refreshed = refreshObservation(observation, totals);
    sidecar.observations[observationIndex] = refreshed;
    sidecar.captured_at = new Date().toISOString();

    if (!options.dryRun) {
      await writeFile(
        quotePath,
        `${JSON.stringify(sidecar, null, 2)}\n`,
        "utf8",
      );
    }

    updatedCount += 1;

    console.log(
      `updated listing=${target.listingId} window=${target.startDate}->${target.endDate} total=${totals.total.toFixed(2)}`,
    );
  }

  console.log(
    `window refresh complete updated=${updatedCount} dry_run=${options.dryRun}`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `Failed to refresh 30aescapes quote windows: ${message}\n`,
      );
      process.exit(1);
    });
}
