import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

type AuditRecord = {
  filePath: string;
  hasSingleObservation: boolean;
  hasFsImport: boolean;
  referencesDetailUrl: boolean;
  referencesEndpointPath: boolean;
  referencesHandoffUrl: boolean;
};

type RuntimeAuditRecord = {
  filePath: string;
  hasFsImport: boolean;
  hasDiskApiUsage: boolean;
};

type RunnerAuditRecord = {
  filePath: string;
  referencesIndexJson: boolean;
  referencesDetailsJson: boolean;
  referencesBackfillFlags: boolean;
};

type QuoteContextCoverageRecord = {
  adapterKey: string;
  indexMissing: boolean;
  malformedIndex: boolean;
  total: number;
  withQuoteContext: number;
  missing: number;
};

type RuntimeLegacyCoexistenceRecord = {
  adapterKey: string;
  hasRuntimeAdapter: boolean;
  hasLegacyQuoteAdapter: boolean;
};

type QuoteContextExternalIdEchoRecord = {
  adapterKey: string;
  totalWithQuoteContext: number;
  echoed: number;
  examples: Array<{ externalListingId: string; fieldPath: string }>;
};

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const adapterRoots = [
  join(projectRoot, "src/lib/pricing/scraper-engine/adapters"),
  join(projectRoot, "src/lib/pricing/scraper-engine/adapters/quotes"),
];
const quoteRuntimeRoot = join(projectRoot, "src/lib/pricing/quote-runtime");
const quoteRuntimeAdaptersRoot = join(
  projectRoot,
  "src/lib/pricing/quote-runtime/adapters",
);
const legacyQuoteAdaptersRoot = join(
  projectRoot,
  "src/lib/pricing/scraper-engine/adapters/quotes",
);
const runnerFiles = [
  join(projectRoot, "src/lib/scripts/run-ad-hoc-quote-latency.ts"),
  join(
    projectRoot,
    "src/lib/pricing/quotes/shared/runtime-adapter-quote-runner.ts",
  ),
];
const externalSourcesRoot = join(projectRoot, "src/lib/data/external-sources");

const singleObservationPattern =
  /runSingleQuoteObservation\s*\(|run[A-Za-z0-9_]*SingleQuoteObservation\s*\(/;
const fsImportPattern =
  /from\s+["']node:fs(?:\/promises)?["']|from\s+["']fs["']|from\s+["']fs\/promises["']/;
const runtimeDiskApiPattern =
  /\breadFile\s*\(|\bwriteFile\s*\(|\breaddir\s*\(|\bstat\s*\(|\bmkdir\s*\(|\baccess\s*\(|\bopen\s*\(|\bcreateReadStream\s*\(|\bcreateWriteStream\s*\(|\bexistsSync\s*\(|\bappendFile\s*\(|\bmkdtemp\s*\(|\brm\s*\(|\bunlink\s*\(|\brename\s*\(|\bcopyFile\s*\(|\bprocess\.cwd\s*\(/;

async function listTsFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTsFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".ts")) {
      out.push(fullPath);
    }
  }
  return out;
}

function toFlag(value: boolean): string {
  return value ? "YES" : "no";
}

function auditFile(filePath: string, source: string): AuditRecord {
  return {
    filePath,
    hasSingleObservation: singleObservationPattern.test(source),
    hasFsImport: fsImportPattern.test(source),
    referencesDetailUrl: /\binput\.detailUrl\b/.test(source),
    referencesEndpointPath: /\binput\.endpointPath\b/.test(source),
    referencesHandoffUrl: /\binput\.handoffUrl\b/.test(source),
  };
}

function auditRuntimeFile(
  filePath: string,
  source: string,
): RuntimeAuditRecord {
  return {
    filePath,
    hasFsImport: fsImportPattern.test(source),
    hasDiskApiUsage: runtimeDiskApiPattern.test(source),
  };
}

function auditRunnerFile(filePath: string, source: string): RunnerAuditRecord {
  return {
    filePath,
    referencesIndexJson:
      source.includes("details/index.json") ||
      source.includes('"index.json"') ||
      source.includes("selectCanonicalListings("),
    referencesDetailsJson:
      source.includes("details/json") ||
      /["']json["']\s*,\s*`\$\{/.test(source),
    referencesBackfillFlags:
      source.includes("QUOTE_CAPTURE_ALLOW_DETAIL_BACKFILL") ||
      source.includes("--backfill-quote-context-from-details") ||
      source.includes("backfill"),
  };
}

async function auditQuoteContextCoverage(
  adapterKey: string,
): Promise<QuoteContextCoverageRecord> {
  const indexPath = join(
    projectRoot,
    "src/lib/data/external-sources",
    adapterKey,
    "details",
    "index.json",
  );

  let raw = "";
  try {
    raw = await readFile(indexPath, "utf8");
  } catch {
    return {
      adapterKey,
      indexMissing: true,
      malformedIndex: false,
      total: 0,
      withQuoteContext: 0,
      missing: 0,
    };
  }

  const parsed = JSON.parse(raw) as Array<{ quote_context?: unknown }>;
  if (!Array.isArray(parsed)) {
    return {
      adapterKey,
      indexMissing: false,
      malformedIndex: true,
      total: 0,
      withQuoteContext: 0,
      missing: 0,
    };
  }

  const withQuoteContext = parsed.filter((entry) => {
    return (
      !!entry.quote_context &&
      typeof entry.quote_context === "object" &&
      !Array.isArray(entry.quote_context)
    );
  }).length;

  return {
    adapterKey,
    indexMissing: false,
    malformedIndex: false,
    total: parsed.length,
    withQuoteContext,
    missing: parsed.length - withQuoteContext,
  };
}

async function listAdapterKeysFromTsFiles(dirPath: string): Promise<string[]> {
  const files = await listTsFiles(dirPath);
  const keys = files
    .filter((filePath) => extname(filePath) === ".ts")
    .map((filePath) => basename(filePath, ".ts"))
    .filter((key) => key.length > 0)
    .sort((left, right) => left.localeCompare(right));
  return Array.from(new Set(keys));
}

function auditRuntimeLegacyCoexistence(input: {
  runtimeAdapterKeys: string[];
  legacyQuoteAdapterKeys: string[];
}): RuntimeLegacyCoexistenceRecord[] {
  const allKeys = Array.from(
    new Set([...input.runtimeAdapterKeys, ...input.legacyQuoteAdapterKeys]),
  ).sort((left, right) => left.localeCompare(right));

  return allKeys.map((adapterKey) => ({
    adapterKey,
    hasRuntimeAdapter: input.runtimeAdapterKeys.includes(adapterKey),
    hasLegacyQuoteAdapter: input.legacyQuoteAdapterKeys.includes(adapterKey),
  }));
}

function collectScalarPaths(
  value: unknown,
  currentPath: string,
): Array<{ path: string; value: string }> {
  if (typeof value === "string") {
    return [{ path: currentPath, value: value.trim() }];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [{ path: currentPath, value: String(value) }];
  }

  if (Array.isArray(value)) {
    const out: Array<{ path: string; value: string }> = [];
    for (let index = 0; index < value.length; index += 1) {
      out.push(...collectScalarPaths(value[index], `${currentPath}[${index}]`));
    }
    return out;
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const out: Array<{ path: string; value: string }> = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = currentPath ? `${currentPath}.${key}` : key;
    out.push(...collectScalarPaths(child, nextPath));
  }
  return out;
}

async function listAdapterKeysWithCanonicalIndex(): Promise<string[]> {
  const entries = await readdir(externalSourcesRoot, { withFileTypes: true });
  const out: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const adapterKey = entry.name;
    const indexPath = join(
      externalSourcesRoot,
      adapterKey,
      "details",
      "index.json",
    );

    try {
      await readFile(indexPath, "utf8");
      out.push(adapterKey);
    } catch {
      // Skip adapters without canonical index.
    }
  }

  return out.sort((left, right) => left.localeCompare(right));
}

async function auditQuoteContextExternalIdEcho(
  adapterKey: string,
): Promise<QuoteContextExternalIdEchoRecord> {
  const indexPath = join(
    externalSourcesRoot,
    adapterKey,
    "details",
    "index.json",
  );

  const raw = await readFile(indexPath, "utf8");
  const parsed = JSON.parse(raw) as Array<{
    external_listing_id?: unknown;
    quote_context?: unknown;
  }>;

  if (!Array.isArray(parsed)) {
    throw new Error(`Malformed canonical index for ${adapterKey}`);
  }

  let totalWithQuoteContext = 0;
  let echoed = 0;
  const examples: Array<{ externalListingId: string; fieldPath: string }> = [];

  for (const entry of parsed) {
    const externalListingId =
      typeof entry.external_listing_id === "string"
        ? entry.external_listing_id.trim()
        : "";

    const quoteContext =
      entry.quote_context &&
      typeof entry.quote_context === "object" &&
      !Array.isArray(entry.quote_context)
        ? entry.quote_context
        : null;

    if (!externalListingId || !quoteContext) {
      continue;
    }

    totalWithQuoteContext += 1;
    const scalarPaths = collectScalarPaths(quoteContext, "quote_context");
    const echoedField = scalarPaths.find(
      (item) => item.value === externalListingId,
    );

    if (!echoedField) {
      continue;
    }

    echoed += 1;
    if (examples.length < 5) {
      examples.push({
        externalListingId,
        fieldPath: echoedField.path,
      });
    }
  }

  return {
    adapterKey,
    totalWithQuoteContext,
    echoed,
    examples,
  };
}

async function run(): Promise<number> {
  const allFiles = (
    await Promise.all(adapterRoots.map((root) => listTsFiles(root)))
  ).flat();
  const runtimeFiles = await listTsFiles(quoteRuntimeRoot);

  const uniqueFiles = Array.from(new Set(allFiles));
  const records: AuditRecord[] = [];
  const runtimeRecords: RuntimeAuditRecord[] = [];
  const runnerRecords: RunnerAuditRecord[] = [];
  const coverageRecords: QuoteContextCoverageRecord[] = [];
  const quoteContextEchoRecords: QuoteContextExternalIdEchoRecord[] = [];
  const coexistenceRecords: RuntimeLegacyCoexistenceRecord[] = [];

  for (const filePath of uniqueFiles) {
    const source = await readFile(filePath, "utf8");
    const record = auditFile(filePath, source);
    if (record.hasSingleObservation) {
      records.push(record);
    }
  }

  for (const filePath of runtimeFiles) {
    const source = await readFile(filePath, "utf8");
    runtimeRecords.push(auditRuntimeFile(filePath, source));
  }

  for (const filePath of runnerFiles) {
    const source = await readFile(filePath, "utf8");
    runnerRecords.push(auditRunnerFile(filePath, source));
  }

  const runtimeAdapterKeys = await listAdapterKeysFromTsFiles(
    quoteRuntimeAdaptersRoot,
  );
  const legacyQuoteAdapterKeys = await listAdapterKeysFromTsFiles(
    legacyQuoteAdaptersRoot,
  );

  for (const adapterKey of runtimeAdapterKeys) {
    coverageRecords.push(await auditQuoteContextCoverage(adapterKey));
  }

  coexistenceRecords.push(
    ...auditRuntimeLegacyCoexistence({
      runtimeAdapterKeys,
      legacyQuoteAdapterKeys,
    }),
  );

  const adapterKeysWithCanonicalIndex =
    await listAdapterKeysWithCanonicalIndex();
  for (const adapterKey of adapterKeysWithCanonicalIndex) {
    quoteContextEchoRecords.push(
      await auditQuoteContextExternalIdEcho(adapterKey),
    );
  }

  const violating = records.filter(
    (record) =>
      record.hasFsImport ||
      record.referencesDetailUrl ||
      record.referencesEndpointPath ||
      record.referencesHandoffUrl,
  );
  const runtimeViolating = runtimeRecords.filter(
    (record) => record.hasFsImport || record.hasDiskApiUsage,
  );
  const runnerViolating = runnerRecords.filter(
    (record) =>
      !record.referencesIndexJson ||
      record.referencesDetailsJson ||
      record.referencesBackfillFlags,
  );
  const coverageViolating = coverageRecords.filter(
    (record) =>
      record.indexMissing || record.malformedIndex || record.missing > 0,
  );
  const coverageWarningZeroContext = coverageRecords.filter(
    (record) =>
      !record.indexMissing &&
      !record.malformedIndex &&
      record.total > 0 &&
      record.withQuoteContext === 0,
  );
  const quoteContextEchoViolating = quoteContextEchoRecords.filter(
    (record) => record.echoed > 0,
  );
  const coexistenceViolating = coexistenceRecords.filter(
    (record) => record.hasRuntimeAdapter && record.hasLegacyQuoteAdapter,
  );

  console.log("Quote module isolation audit (single-observation handlers)");
  console.log(
    "Rules: no fs imports; no input.detailUrl/input.endpointPath/input.handoffUrl usage in handler files.",
  );
  console.log("");

  for (const record of records) {
    console.log(`- ${relative(projectRoot, record.filePath)}`);
    console.log(`  fs_import: ${toFlag(record.hasFsImport)}`);
    console.log(`  input.detailUrl: ${toFlag(record.referencesDetailUrl)}`);
    console.log(
      `  input.endpointPath: ${toFlag(record.referencesEndpointPath)}`,
    );
    console.log(`  input.handoffUrl: ${toFlag(record.referencesHandoffUrl)}`);
  }

  console.log("");
  console.log("Quote-runtime disk isolation audit");
  console.log(
    "Rules: quote-runtime cannot import fs modules or reference disk/path-based APIs.",
  );
  console.log("");

  for (const record of runtimeRecords) {
    console.log(`- ${relative(projectRoot, record.filePath)}`);
    console.log(`  fs_import: ${toFlag(record.hasFsImport)}`);
    console.log(`  disk_api_usage: ${toFlag(record.hasDiskApiUsage)}`);
  }

  console.log("");
  console.log("Quote runner source-of-truth audit");
  console.log(
    "Rules: runners must source canonical quote context from index.json only; no details/json lookup or backfill flags.",
  );
  console.log("");

  for (const record of runnerRecords) {
    console.log(`- ${relative(projectRoot, record.filePath)}`);
    console.log(
      `  references_index_json: ${toFlag(record.referencesIndexJson)}`,
    );
    console.log(
      `  references_details_json: ${toFlag(record.referencesDetailsJson)}`,
    );
    console.log(
      `  references_backfill_flags: ${toFlag(record.referencesBackfillFlags)}`,
    );
  }

  console.log("");
  console.log("Runtime Adapter Quote Context Coverage");
  console.log(
    "Rules: every adapter with a quote-runtime adapter file must have canonical index.json with quote_context on every entry.",
  );
  console.log("");

  for (const record of coverageRecords) {
    if (record.indexMissing) {
      console.log(`- ${record.adapterKey} index=missing`);
      continue;
    }

    if (record.malformedIndex) {
      console.log(`- ${record.adapterKey} index=malformed`);
      continue;
    }

    console.log(
      `- ${record.adapterKey} total=${record.total} with_quote_context=${record.withQuoteContext} missing=${record.missing}`,
    );
  }

  if (coverageWarningZeroContext.length > 0) {
    console.log("");
    console.log("Quote Context Zero-Coverage Warnings");
    console.log(
      "Rules: adapters with runtime quote support should not have 0% quote_context coverage.",
    );
    console.log("");
    for (const record of coverageWarningZeroContext) {
      console.log(
        `- ${record.adapterKey} with_quote_context=${record.withQuoteContext}/${record.total}`,
      );
    }
  }

  console.log("");
  console.log("Runtime Migration Legacy Coexistence");
  console.log(
    "Rules: adapters with quote-runtime/adapters/<adapter>.ts must not also keep scraper-engine/adapters/quotes/<adapter>.ts.",
  );
  console.log("");

  for (const record of coexistenceRecords) {
    if (!record.hasRuntimeAdapter && !record.hasLegacyQuoteAdapter) {
      continue;
    }
    console.log(`- ${record.adapterKey}`);
    console.log(`  runtime_adapter: ${toFlag(record.hasRuntimeAdapter)}`);
    console.log(
      `  legacy_quote_adapter: ${toFlag(record.hasLegacyQuoteAdapter)}`,
    );
  }

  console.log("");
  console.log("Quote Context External ID Echo Red Flags");
  console.log(
    "Rules: quote_context values matching external_listing_id are red flags and should be corrected.",
  );
  console.log("");

  for (const record of quoteContextEchoRecords) {
    console.log(
      `- ${record.adapterKey} with_quote_context=${record.totalWithQuoteContext} echoed_external_listing_id=${record.echoed}`,
    );
    for (const example of record.examples) {
      console.log(
        `  example external_listing_id=${example.externalListingId} field=${example.fieldPath}`,
      );
    }
  }

  console.log("");
  console.log(
    `Summary: total_handlers=${records.length} handler_violations=${violating.length} runtime_files=${runtimeRecords.length} runtime_violations=${runtimeViolating.length} runner_files=${runnerRecords.length} runner_violations=${runnerViolating.length} runtime_quote_context_adapters=${coverageRecords.length} quote_context_violations=${coverageViolating.length} quote_context_zero_coverage_warnings=${coverageWarningZeroContext.length} legacy_coexistence_adapters=${coexistenceRecords.length} legacy_coexistence_violations=${coexistenceViolating.length} red_flag_adapters=${quoteContextEchoRecords.length} red_flag_violations=${quoteContextEchoViolating.length}`,
  );

  if (
    violating.length > 0 ||
    runtimeViolating.length > 0 ||
    runnerViolating.length > 0 ||
    coverageViolating.length > 0 ||
    coexistenceViolating.length > 0 ||
    quoteContextEchoViolating.length > 0
  ) {
    console.error(
      "Isolation audit failed. Resolve violations before proceeding.",
    );
    return 1;
  }

  console.log("Isolation audit passed.");
  return 0;
}

run()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Isolation audit crashed: ${message}`);
    process.exitCode = 1;
  });
