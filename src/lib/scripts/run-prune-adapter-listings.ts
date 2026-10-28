import "@/core/tooling/env/load-env-profile";

import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type CliOptions = {
  adapterKey: string;
  listingIds: string[];
  dryRun: boolean;
};

type CanonicalIndexEntry = {
  external_listing_id?: unknown;
  [key: string]: unknown;
};

function parseListingIdsCsv(value: string): string[] {
  return value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

async function loadListingIdsFromFile(filePath: string): Promise<string[]> {
  const raw = await readFile(resolve(process.cwd(), filePath), "utf8");
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function parseArgs(argv: string[]): Promise<CliOptions> {
  let adapterKey = "";
  let dryRun = false;
  const collectedListingIds: string[] = [];
  const listingIdFiles: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--help" || arg === "-h") {
      console.log("Usage:");
      console.log(
        "  tsx src/lib/scripts/run-prune-adapter-listings.ts --adapter-key <adapterKey> [--listing-id <id>] [--listing-ids <id1,id2,...>] [--listing-ids-file <path>] [--dry-run]",
      );
      process.exit(0);
    }

    if (arg === "--adapter-key" && value) {
      adapterKey = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg.startsWith("--adapter-key=")) {
      adapterKey = arg.slice("--adapter-key=".length).trim().toLowerCase();
      continue;
    }

    if (arg === "--listing-id" && value) {
      collectedListingIds.push(value.trim());
      index += 1;
      continue;
    }

    if (arg.startsWith("--listing-id=")) {
      collectedListingIds.push(arg.slice("--listing-id=".length).trim());
      continue;
    }

    if (arg === "--listing-ids" && value) {
      collectedListingIds.push(...parseListingIdsCsv(value));
      index += 1;
      continue;
    }

    if (arg.startsWith("--listing-ids=")) {
      collectedListingIds.push(
        ...parseListingIdsCsv(arg.slice("--listing-ids=".length)),
      );
      continue;
    }

    if (arg === "--listing-ids-file" && value) {
      listingIdFiles.push(value.trim());
      index += 1;
      continue;
    }

    if (arg.startsWith("--listing-ids-file=")) {
      listingIdFiles.push(arg.slice("--listing-ids-file=".length).trim());
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!adapterKey) {
    throw new Error("Missing required --adapter-key value.");
  }

  return Promise.all(
    listingIdFiles.map((filePath) => loadListingIdsFromFile(filePath)),
  ).then((fileListingIdSets) => {
    const merged = [
      ...collectedListingIds,
      ...fileListingIdSets.flatMap((ids) => ids),
    ]
      .map((id) => id.trim())
      .filter(Boolean);

    const deduped = [...new Set(merged)];
    if (deduped.length === 0) {
      throw new Error(
        "No listing IDs provided. Use --listing-id, --listing-ids, or --listing-ids-file.",
      );
    }

    return {
      adapterKey,
      listingIds: deduped,
      dryRun,
    };
  });
}

async function removeIfExists(
  filePath: string,
  dryRun: boolean,
): Promise<boolean> {
  try {
    if (dryRun) {
      await readFile(filePath, "utf8");
      return true;
    }

    await rm(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const options = await parseArgs(process.argv.slice(2));
  const detailsRoot = resolve(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    options.adapterKey,
    "details",
  );

  const indexPath = resolve(detailsRoot, "index.json");
  const indexRaw = await readFile(indexPath, "utf8");
  const indexParsed = JSON.parse(indexRaw) as CanonicalIndexEntry[];

  if (!Array.isArray(indexParsed)) {
    throw new Error(`Canonical index is not an array: ${indexPath}`);
  }

  const pruneSet = new Set(options.listingIds);
  const nextIndex = indexParsed.filter((entry) => {
    const externalId =
      typeof entry.external_listing_id === "string"
        ? entry.external_listing_id.trim()
        : "";
    return !pruneSet.has(externalId);
  });

  const removedFromIndex = indexParsed.length - nextIndex.length;

  if (!options.dryRun) {
    await writeFile(
      indexPath,
      `${JSON.stringify(nextIndex, null, 2)}\n`,
      "utf8",
    );
  }

  const artifactDirs = ["json", "html", "quotes", "pricing"];
  let removedArtifacts = 0;

  for (const listingId of options.listingIds) {
    for (const dir of artifactDirs) {
      const jsonPath = resolve(detailsRoot, dir, `${listingId}.json`);
      const htmlPath = resolve(detailsRoot, dir, `${listingId}.html`);
      if (await removeIfExists(jsonPath, options.dryRun)) {
        removedArtifacts += 1;
      }
      if (await removeIfExists(htmlPath, options.dryRun)) {
        removedArtifacts += 1;
      }
    }
  }

  console.log(`adapter_key=${options.adapterKey}`);
  console.log(`listing_ids_requested=${options.listingIds.length}`);
  console.log(`index_before=${indexParsed.length}`);
  console.log(`index_after=${nextIndex.length}`);
  console.log(`index_entries_removed=${removedFromIndex}`);
  console.log(`artifacts_removed=${removedArtifacts}`);
  console.log(`dry_run=${options.dryRun}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`prune adapter listings failed: ${message}`);
  process.exit(1);
});
