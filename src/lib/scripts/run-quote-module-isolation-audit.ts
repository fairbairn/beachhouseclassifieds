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

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const adapterRoots = [
  join(projectRoot, "src/lib/pricing/scraper-engine/adapters"),
  join(projectRoot, "src/lib/pricing/scraper-engine/adapters/quotes"),
];

const singleObservationPattern =
  /runSingleQuoteObservation\s*\(|run[A-Za-z0-9_]*SingleQuoteObservation\s*\(/;
const fsImportPattern =
  /from\s+["']node:fs(?:\/promises)?["']|from\s+["']fs["']|from\s+["']fs\/promises["']/;

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

async function run(): Promise<number> {
  const allFiles = (
    await Promise.all(adapterRoots.map((root) => listTsFiles(root)))
  ).flat();

  const uniqueFiles = Array.from(new Set(allFiles));
  const records: AuditRecord[] = [];

  for (const filePath of uniqueFiles) {
    const source = await readFile(filePath, "utf8");
    const record = auditFile(filePath, source);
    if (record.hasSingleObservation) {
      records.push(record);
    }
  }

  const violating = records.filter(
    (record) =>
      record.hasFsImport ||
      record.referencesDetailUrl ||
      record.referencesEndpointPath ||
      record.referencesHandoffUrl,
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
  console.log(
    `Summary: total_handlers=${records.length} violations=${violating.length}`,
  );

  if (violating.length > 0) {
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
