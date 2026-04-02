import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { QuoteProgress } from "@/lib/pricing/quotes/types";

type LegacyQuoteCliOptions = {
  maxListings: number;
  listingId: string | null;
  weeks: number;
  nights: number;
  refreshMode: "full" | "dynamic" | "static";
  passthroughArgs: string[];
};

type RunLegacyAdapterQuoteViaEngineInput = {
  adapterKey: string;
  engineScriptRaw: string;
  argv: string[];
  progress?: QuoteProgress;
  windowDaysEnvVar?: string;
  nightsEnvVar?: string;
  maxQueriesEnvVar?: string;
  defaultMaxListings?: number;
  minWeeks?: number;
};

const DEFAULT_MAX_LISTINGS = 10;
const DEFAULT_WEEKS = 24;
const DEFAULT_NIGHTS = 7;

function parseArgs(
  argv: string[],
  defaultMaxListings: number,
): LegacyQuoteCliOptions {
  let maxListings = defaultMaxListings;
  let listingId: string | null = null;
  let weeks = DEFAULT_WEEKS;
  let nights = DEFAULT_NIGHTS;
  let refreshMode: "full" | "dynamic" | "static" = "dynamic";
  const passthroughArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--max-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxListings = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--listing-id" && value) {
      listingId = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--weeks" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        weeks = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--nights" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        nights = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--refresh-mode" && value) {
      if (value === "full" || value === "dynamic" || value === "static") {
        refreshMode = value;
      }
      index += 1;
      continue;
    }

    if (arg === "--all-listings") {
      maxListings = Number.POSITIVE_INFINITY;
      continue;
    }

    passthroughArgs.push(arg);
  }

  return {
    maxListings,
    listingId,
    weeks,
    nights,
    refreshMode,
    passthroughArgs,
  };
}

type CanonicalIndexEntry = {
  detail_url?: unknown;
  external_listing_id?: unknown;
  quote_context?: unknown;
};

async function loadCanonicalIndex(
  adapterKey: string,
): Promise<CanonicalIndexEntry[]> {
  const indexPath = resolve(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    adapterKey,
    "details",
    "index.json",
  );

  const raw = await readFile(indexPath, "utf8");
  const parsed = JSON.parse(raw) as CanonicalIndexEntry[];
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Canonical manifest is malformed for adapter '${adapterKey}' at ${indexPath}.`,
    );
  }
  return parsed;
}

async function countAdapterCanonicalListings(
  adapterKey: string,
): Promise<number> {
  const entries = await loadCanonicalIndex(adapterKey);
  return entries.filter(
    (entry) =>
      typeof entry.detail_url === "string" &&
      entry.detail_url.trim().length > 0,
  ).length;
}

async function resolveDetailUrlByListingId(
  adapterKey: string,
  listingId: string,
): Promise<string> {
  const canonicalEntries = await loadCanonicalIndex(adapterKey);
  const canonicalEntry = canonicalEntries.find(
    (entry) =>
      typeof entry.external_listing_id === "string" &&
      entry.external_listing_id.trim() === listingId,
  );
  if (!canonicalEntry) {
    throw new Error(
      `Listing '${listingId}' is not present in canonical manifest for adapter '${adapterKey}'.`,
    );
  }

  const detailUrl =
    typeof canonicalEntry.detail_url === "string"
      ? canonicalEntry.detail_url.trim()
      : "";

  if (!detailUrl) {
    throw new Error(
      `Missing detail_url in canonical manifest for adapter '${adapterKey}' listing '${listingId}'.`,
    );
  }

  return detailUrl;
}

function runNpmScript(scriptRaw: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("npm", ["run", scriptRaw, "--", ...args], {
      stdio: "inherit",
      env: process.env,
    });

    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (signal) {
        rejectPromise(
          new Error(`Quote capture cancelled by signal ${signal}.`),
        );
        return;
      }

      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(`Quote capture engine exited with code ${code ?? 1}.`),
      );
    });
  });
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));
}

function resolveFreshHoursDefault(): number {
  const raw = Number(process.env.QUOTE_CAPTURE_FRESH_HOURS ?? "24");
  if (!Number.isFinite(raw) || raw <= 0) {
    return 24;
  }
  return Math.floor(raw);
}

async function runWithEnv<T>(
  updates: Record<string, string>,
  callback: () => Promise<T>,
): Promise<T> {
  const previousValues = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(updates)) {
    previousValues.set(name, process.env[name]);
    process.env[name] = value;
  }

  try {
    return await callback();
  } finally {
    for (const [name, prior] of previousValues.entries()) {
      if (typeof prior === "string") {
        process.env[name] = prior;
      } else {
        delete process.env[name];
      }
    }
  }
}

export async function runLegacyAdapterQuoteViaEngine(
  input: RunLegacyAdapterQuoteViaEngineInput,
): Promise<void> {
  const options = parseArgs(
    input.argv,
    Math.max(1, input.defaultMaxListings ?? DEFAULT_MAX_LISTINGS),
  );
  const minWeeks = Math.max(1, input.minWeeks ?? 1);
  const weeks = Math.max(minWeeks, options.weeks);
  const nights = Math.max(1, options.nights);
  const targetWindowDays = Math.max(minWeeks * 7, weeks * 7);
  const maxQueries = Math.max(minWeeks, weeks);

  const envUpdates: Record<string, string> = {};
  if (input.windowDaysEnvVar) {
    envUpdates[input.windowDaysEnvVar] = String(targetWindowDays);
  }
  if (input.nightsEnvVar) {
    envUpdates[input.nightsEnvVar] = String(nights);
  }
  if (input.maxQueriesEnvVar) {
    envUpdates[input.maxQueriesEnvVar] = String(maxQueries);
  }

  const engineArgs: string[] = ["--refresh-mode", options.refreshMode];
  if (
    !hasFlag(options.passthroughArgs, "--mode") &&
    !hasFlag(options.passthroughArgs, "--run-mode")
  ) {
    engineArgs.push("--run-mode", "quote");
  }
  if (options.listingId) {
    const detailUrl = await resolveDetailUrlByListingId(
      input.adapterKey,
      options.listingId,
    );
    engineArgs.push("--detail-url", detailUrl);
  } else {
    engineArgs.push("--refresh-known");

    let maxListings = options.maxListings;
    if (!Number.isFinite(maxListings)) {
      maxListings = await countAdapterCanonicalListings(input.adapterKey);
    }
    if (maxListings > 0) {
      engineArgs.push("--max-listings", String(Math.floor(maxListings)));
    }
  }

  engineArgs.push(...options.passthroughArgs);

  if (!hasFlag(engineArgs, "--detail-fetch-concurrency")) {
    const fastConcurrency = Math.max(
      1,
      Number(process.env.QUOTE_CAPTURE_DETAIL_FETCH_CONCURRENCY ?? "8") || 8,
    );
    engineArgs.push("--detail-fetch-concurrency", String(fastConcurrency));
  }
  if (!hasFlag(engineArgs, "--detail-fetch-delay-ms")) {
    engineArgs.push("--detail-fetch-delay-ms", "0");
  }

  // In quote mode, avoid re-pulling recently refreshed detail artifacts unless caller overrides.
  if (
    !hasFlag(engineArgs, "--skip-fresh-details") &&
    !hasFlag(engineArgs, "--skip-existing-details")
  ) {
    engineArgs.push("--skip-fresh-details");
    if (!hasFlag(engineArgs, "--fresh-hours")) {
      engineArgs.push("--fresh-hours", String(resolveFreshHoursDefault()));
    }
  }

  input.progress?.info(
    `[${input.adapterKey}] quote-capture refresh-mode=${options.refreshMode} weeks=${weeks} nights=${nights}`,
  );
  await runWithEnv(envUpdates, () =>
    runNpmScript(input.engineScriptRaw, engineArgs),
  );
  input.progress?.success(
    `[${input.adapterKey}] quote-capture complete via engine refresh`,
  );
}
