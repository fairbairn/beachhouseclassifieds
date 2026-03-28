type EnvReader = Record<string, string | undefined>;

type AdapterRuntimeDefaults = {
  detailFetchDelayMs: number;
  detailFetchConcurrency: number;
  availabilityHorizonDays: number;
  maxCalendarAdvanceMonths: number;
};

type AdapterRuntimeAliases = Partial<
  Record<
    | "DETAIL_FETCH_DELAY_MS"
    | "DETAIL_FETCH_CONCURRENCY"
    | "AVAILABILITY_HORIZON_DAYS"
    | "MAX_CALENDAR_ADVANCE_MONTHS",
    string[]
  >
>;

export type AdapterRuntimeOptions = {
  managerKey: string;
  defaults: AdapterRuntimeDefaults;
  aliases?: AdapterRuntimeAliases;
  env?: EnvReader;
};

export type ResolvedAdapterRuntime = {
  envPrefix: string;
  detailFetchDelayMs: number;
  detailFetchConcurrency: number;
  availabilityHorizonDays: number;
  maxCalendarAdvanceMonths: number;
  envNames: {
    detailFetchDelayMs: string[];
    detailFetchConcurrency: string[];
    availabilityHorizonDays: string[];
    maxCalendarAdvanceMonths: string[];
  };
};

type DiscoveryReporter = (message: string) => void;

type DiscoveryExpected = {
  source: string;
  expected: number | null;
  initialDiscovered: number;
};

type DiscoveryProgress = {
  stage: string;
  discovered: number;
  step?: number;
  maxSteps?: number;
  noGrowthRounds?: number;
  extras?: Record<string, string | number | boolean | null | undefined>;
};

type DiscoveryEarlyStop = {
  reason: string;
  discovered: number;
  step?: number;
  maxSteps?: number;
  extras?: Record<string, string | number | boolean | null | undefined>;
};

type DiscoverySummary = {
  selected: number;
  bySource?: Record<string, number>;
  expected?: number | null;
  notes?: string;
};

function normalizeEnvPrefix(managerKey: string): string {
  return managerKey
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseIntegerEnv(raw: string | undefined): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.floor(parsed);
}

function readBoundedInt(
  env: EnvReader,
  names: string[],
  fallback: number,
  minimum: number,
): number {
  for (const name of names) {
    const parsed = parseIntegerEnv(env[name]);
    if (parsed === null) {
      continue;
    }
    return Math.max(minimum, parsed);
  }
  return fallback;
}

function buildEnvNames(
  prefix: string,
  canonicalSuffix: "DETAIL_FETCH_DELAY_MS" | "DETAIL_FETCH_CONCURRENCY" | "AVAILABILITY_HORIZON_DAYS" | "MAX_CALENDAR_ADVANCE_MONTHS",
  aliases: AdapterRuntimeAliases | undefined,
): string[] {
  const canonicalName = `${prefix}_${canonicalSuffix}`;
  const aliasNames = aliases?.[canonicalSuffix] ?? [];
  return [canonicalName, ...aliasNames];
}

export function resolveAdapterRuntime(options: AdapterRuntimeOptions): ResolvedAdapterRuntime {
  const env = options.env ?? process.env;
  const envPrefix = normalizeEnvPrefix(options.managerKey);

  const detailFetchDelayNames = buildEnvNames(
    envPrefix,
    "DETAIL_FETCH_DELAY_MS",
    options.aliases,
  );
  const detailFetchConcurrencyNames = buildEnvNames(
    envPrefix,
    "DETAIL_FETCH_CONCURRENCY",
    {
      ...options.aliases,
      DETAIL_FETCH_CONCURRENCY: [
        `${envPrefix}_FETCH_CONCURRENCY`,
        ...(options.aliases?.DETAIL_FETCH_CONCURRENCY ?? []),
      ],
    },
  );
  const availabilityHorizonNames = buildEnvNames(
    envPrefix,
    "AVAILABILITY_HORIZON_DAYS",
    options.aliases,
  );
  const maxCalendarAdvanceNames = buildEnvNames(
    envPrefix,
    "MAX_CALENDAR_ADVANCE_MONTHS",
    {
      ...options.aliases,
      MAX_CALENDAR_ADVANCE_MONTHS: [
        `${envPrefix}_CALENDAR_MAX_MONTHS`,
        ...(options.aliases?.MAX_CALENDAR_ADVANCE_MONTHS ?? []),
      ],
    },
  );

  return {
    envPrefix,
    detailFetchDelayMs: readBoundedInt(
      env,
      detailFetchDelayNames,
      options.defaults.detailFetchDelayMs,
      0,
    ),
    detailFetchConcurrency: readBoundedInt(
      env,
      detailFetchConcurrencyNames,
      options.defaults.detailFetchConcurrency,
      1,
    ),
    availabilityHorizonDays: readBoundedInt(
      env,
      availabilityHorizonNames,
      options.defaults.availabilityHorizonDays,
      1,
    ),
    maxCalendarAdvanceMonths: readBoundedInt(
      env,
      maxCalendarAdvanceNames,
      options.defaults.maxCalendarAdvanceMonths,
      1,
    ),
    envNames: {
      detailFetchDelayMs: detailFetchDelayNames,
      detailFetchConcurrency: detailFetchConcurrencyNames,
      availabilityHorizonDays: availabilityHorizonNames,
      maxCalendarAdvanceMonths: maxCalendarAdvanceNames,
    },
  };
}

function formatKeyValue(
  key: string,
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || typeof value === "undefined") {
    return `${key}=unknown`;
  }
  return `${key}=${value}`;
}

function formatExtras(
  extras: Record<string, string | number | boolean | null | undefined> | undefined,
): string {
  if (!extras) {
    return "";
  }

  const pairs = Object.entries(extras)
    .map(([key, value]) => formatKeyValue(key, value))
    .join(" ");

  return pairs ? ` ${pairs}` : "";
}

export function createDiscoveryLogger(reportProgress: DiscoveryReporter): {
  expected(event: DiscoveryExpected): void;
  progress(event: DiscoveryProgress): void;
  earlyStop(event: DiscoveryEarlyStop): void;
  summary(event: DiscoverySummary): void;
} {
  return {
    expected(event: DiscoveryExpected): void {
      reportProgress(
        [
          "discovery expected",
          formatKeyValue("source", event.source),
          formatKeyValue("expected", event.expected),
          formatKeyValue("initial", event.initialDiscovered),
        ].join(" "),
      );
    },
    progress(event: DiscoveryProgress): void {
      const stepText =
        typeof event.step === "number" && typeof event.maxSteps === "number"
          ? ` step=${event.step}/${event.maxSteps}`
          : "";
      const noGrowthText =
        typeof event.noGrowthRounds === "number"
          ? ` no_growth_rounds=${event.noGrowthRounds}`
          : "";

      reportProgress(
        `discovery progress stage=${event.stage} discovered=${event.discovered}${stepText}${noGrowthText}${formatExtras(event.extras)}`,
      );
    },
    earlyStop(event: DiscoveryEarlyStop): void {
      const stepText =
        typeof event.step === "number" && typeof event.maxSteps === "number"
          ? ` step=${event.step}/${event.maxSteps}`
          : "";

      reportProgress(
        `discovery early_stop reason=${event.reason} discovered=${event.discovered}${stepText}${formatExtras(event.extras)}`,
      );
    },
    summary(event: DiscoverySummary): void {
      const sourceBreakdown = Object.entries(event.bySource ?? {})
        .map(([key, value]) => `${key}:${value}`)
        .join(",");

      reportProgress(
        `discovery summary selected=${event.selected} expected=${event.expected ?? "unknown"} by_source=${sourceBreakdown || "n/a"}${event.notes ? ` notes=${event.notes}` : ""}`,
      );
    },
  };
}
