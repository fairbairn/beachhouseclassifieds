import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
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

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const adapterRoots = [
  join(projectRoot, "src/lib/pricing/scraper-engine/adapters"),
  join(projectRoot, "src/lib/pricing/scraper-engine/adapters/quotes"),
];
const quoteRuntimeRoot = join(projectRoot, "src/lib/pricing/quote-runtime");

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

async function run(): Promise<number> {
  const allFiles = (
    await Promise.all(adapterRoots.map((root) => listTsFiles(root)))
  ).flat();
  const runtimeFiles = await listTsFiles(quoteRuntimeRoot);

  const uniqueFiles = Array.from(new Set(allFiles));
  const records: AuditRecord[] = [];
  const runtimeRecords: RuntimeAuditRecord[] = [];

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
  console.log(
    `Summary: total_handlers=${records.length} handler_violations=${violating.length} runtime_files=${runtimeRecords.length} runtime_violations=${runtimeViolating.length}`,
  );

  if (violating.length > 0 || runtimeViolating.length > 0) {
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
