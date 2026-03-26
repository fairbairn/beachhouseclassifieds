import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse as parseDotenv } from "dotenv";

const defaultActorId = "jupri/vrbo-property";
const defaultLocations = ["Santa Rosa Beach, FL"];
const defaultLimit = 20;
const defaultMinBeds = 3;
const defaultPropertyTypes = ["house"];
const defaultLanguage = "en_US";
const maxLimitValue = 10000;

const usage = [
  "Usage: node src/core/scripts/scrape-vrbo-jupri.mjs [options]",
  "",
  "Options:",
  "  --location <value>           Search location (repeatable)",
  "  --locations <a|b|c>          Search locations with pipe-delimited values",
  "  --limit <number>             Number of listings to request (default: 20)",
  `  --max                        Request max listings (sets limit=${maxLimitValue})`,
  "  --min-beds <number>          Minimum beds filter (default: 3)",
  "  --property-type <value>      Property type filter (repeatable)",
  "  --property-types <a|b|c>     Property types with pipe-delimited values",
  "  --includes-all <true|false>  Request all enrichment fields (default: true)",
  "  --language <value>           Locale (default: en_US)",
  "  --actor-id <value>           Apify actor id (default: jupri/vrbo-property)",
  "  --help                       Show help",
].join("\n");

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function toBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseArgs(argv) {
  const options = {
    actorId: defaultActorId,
    locations: [...defaultLocations],
    limit: defaultLimit,
    maxMode: false,
    minBeds: defaultMinBeds,
    propertyTypes: [...defaultPropertyTypes],
    includesAll: true,
    language: defaultLanguage,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") {
      console.log(usage);
      process.exit(0);
    }

    if (arg === "--location") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --location");
      }

      options.locations.push(value);
      index += 1;
      continue;
    }

    if (arg === "--locations") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --locations");
      }

      const values = value
        .split("|")
        .map((entry) => entry.trim())
        .filter(Boolean);

      if (values.length === 0) {
        throw new Error("--locations must contain at least one value");
      }

      options.locations.push(...values);
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --limit");
      }

      options.limit = toPositiveInteger(value, defaultLimit);
      index += 1;
      continue;
    }

    if (arg === "--max") {
      options.maxMode = true;
      continue;
    }

    if (arg === "--min-beds") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --min-beds");
      }

      options.minBeds = toPositiveInteger(value, defaultMinBeds);
      index += 1;
      continue;
    }

    if (arg === "--property-type") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --property-type");
      }

      options.propertyTypes.push(value);
      index += 1;
      continue;
    }

    if (arg === "--property-types") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --property-types");
      }

      const values = value
        .split("|")
        .map((entry) => entry.trim())
        .filter(Boolean);

      if (values.length === 0) {
        throw new Error("--property-types must contain at least one value");
      }

      options.propertyTypes.push(...values);
      index += 1;
      continue;
    }

    if (arg === "--includes-all") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --includes-all");
      }

      options.includesAll = toBoolean(value, true);
      index += 1;
      continue;
    }

    if (arg === "--language") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --language");
      }

      options.language = value;
      index += 1;
      continue;
    }

    if (arg === "--actor-id") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --actor-id");
      }

      options.actorId = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  const normalizedLocations = Array.from(
    new Set(options.locations.map((entry) => entry.trim()).filter(Boolean)),
  );
  const normalizedPropertyTypes = Array.from(
    new Set(options.propertyTypes.map((entry) => entry.trim()).filter(Boolean)),
  );

  return {
    ...options,
    locations:
      normalizedLocations.length > 0
        ? normalizedLocations
        : [...defaultLocations],
    propertyTypes:
      normalizedPropertyTypes.length > 0
        ? normalizedPropertyTypes
        : [...defaultPropertyTypes],
    limit: options.maxMode ? maxLimitValue : options.limit,
  };
}

function resolveProfile(value) {
  if (!value) {
    return "local";
  }

  const normalized = String(value).trim().toLowerCase();

  if (normalized === "dev" || normalized === "development") {
    return "dev";
  }

  if (normalized === "prod" || normalized === "production") {
    return "prod";
  }

  return "local";
}

function profileEnvFilename(profile) {
  if (profile === "dev") {
    return ".env.dev";
  }

  if (profile === "prod") {
    return ".env.prod";
  }

  return ".env.local";
}

function readEnvFileIfPresent(path) {
  if (!existsSync(path)) {
    return {};
  }

  return parseDotenv(readFileSync(path, "utf8"));
}

function loadResolvedEnv() {
  const cwd = process.cwd();
  const processProfile = resolveProfile(process.env.APP_ENV_PROFILE);
  const baseEnv = readEnvFileIfPresent(resolve(cwd, ".env"));
  const profileEnv = readEnvFileIfPresent(
    resolve(cwd, profileEnvFilename(processProfile)),
  );

  return {
    ...baseEnv,
    ...profileEnv,
    ...process.env,
    APP_ENV_PROFILE: processProfile,
  };
}

function nowStamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

function flattenKeys(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const keys = [];

  for (const [key, nested] of Object.entries(value)) {
    const current = prefix ? `${prefix}.${key}` : key;
    keys.push(current);

    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      keys.push(...flattenKeys(nested, current));
    }
  }

  return keys;
}

function safeName(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = loadResolvedEnv();
  const token = env.APIFY_API_TOKEN?.trim();

  if (!token) {
    throw new Error(
      "APIFY_API_TOKEN is missing. Set it in .env.local or process env.",
    );
  }

  const inputPayload = {
    location: options.locations,
    limit: options.limit,
    "includes:all": options.includesAll,
    min_beds: options.minBeds,
    "filters:property_type": options.propertyTypes,
    language: options.language,
  };

  const runDir = resolve(
    process.cwd(),
    ".tmp",
    "vrbo",
    "jupri-test",
    nowStamp(),
  );
  await mkdir(runDir, { recursive: true });

  const actorPath = options.actorId
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("~");
  const endpoint = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  await writeFile(
    resolve(runDir, "input.json"),
    JSON.stringify(inputPayload, null, 2),
    "utf8",
  );

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(inputPayload),
  });

  const rawText = await response.text();
  await writeFile(resolve(runDir, "response-raw.json"), rawText, "utf8");

  let parsed;

  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = null;
  }

  const items = Array.isArray(parsed)
    ? parsed.filter(
        (entry) =>
          entry && typeof entry === "object" && entry["#error"] !== true,
      )
    : [];
  const errorItems = Array.isArray(parsed)
    ? parsed.filter(
        (entry) =>
          entry && typeof entry === "object" && entry["#error"] === true,
      )
    : [];

  const firstItem = items[0] ?? null;
  const topLevelKeys =
    firstItem && typeof firstItem === "object"
      ? Object.keys(firstItem).sort((a, b) => a.localeCompare(b))
      : [];
  const flattenedKeys = firstItem
    ? flattenKeys(firstItem).sort((a, b) => a.localeCompare(b))
    : [];

  await writeFile(
    resolve(runDir, "items.json"),
    JSON.stringify(items, null, 2),
    "utf8",
  );
  await writeFile(
    resolve(runDir, "errors.json"),
    JSON.stringify(errorItems, null, 2),
    "utf8",
  );

  const listingRecordsDir = resolve(runDir, "listing-records");
  await mkdir(listingRecordsDir, { recursive: true });

  const listingRecordFiles = [];
  const usedFileNames = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const id =
      item && typeof item === "object" && typeof item.id === "string"
        ? item.id
        : `item-${String(index + 1).padStart(4, "0")}`;
    const baseName = safeName(id) || "listing";
    let fileName = `${baseName}.json`;
    let suffix = 2;

    while (usedFileNames.has(fileName)) {
      fileName = `${baseName}-${suffix}.json`;
      suffix += 1;
    }

    usedFileNames.add(fileName);
    const filePath = resolve(listingRecordsDir, fileName);

    await writeFile(filePath, JSON.stringify(item, null, 2), "utf8");
    listingRecordFiles.push(fileName);
  }

  const ndjson = items.map((item) => JSON.stringify(item)).join("\n");
  await writeFile(resolve(runDir, "listings.ndjson"), ndjson, "utf8");
  await writeFile(
    resolve(runDir, "listing-record-files.json"),
    JSON.stringify(listingRecordFiles, null, 2),
    "utf8",
  );

  const summary = {
    actorId: options.actorId,
    httpStatus: response.status,
    ok: response.ok,
    runDir,
    requested: {
      locations: options.locations,
      limit: options.limit,
      maxMode: options.maxMode,
      includesAll: options.includesAll,
      minBeds: options.minBeds,
      propertyTypes: options.propertyTypes,
      language: options.language,
    },
    counts: {
      totalArrayEntries: Array.isArray(parsed) ? parsed.length : 0,
      itemCount: items.length,
      errorCount: errorItems.length,
    },
    fieldDepth: {
      topLevelKeyCount: topLevelKeys.length,
      flattenedKeyCount: flattenedKeys.length,
      topLevelKeys,
      flattenedKeySample: flattenedKeys.slice(0, 120),
    },
    actorError:
      parsed &&
      !Array.isArray(parsed) &&
      typeof parsed === "object" &&
      parsed.error
        ? parsed.error
        : null,
    exports: {
      arrayJson: "items.json",
      ndjson: "listings.ndjson",
      listingRecordsDirectory: "listing-records",
      listingRecordCount: listingRecordFiles.length,
    },
  };

  await writeFile(
    resolve(runDir, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  );

  await writeFile(
    resolve(process.cwd(), ".tmp", "vrbo", "jupri-test", "last-run.json"),
    JSON.stringify(
      {
        runDir,
        actorId: options.actorId,
        httpStatus: response.status,
        itemCount: items.length,
        errorCount: errorItems.length,
        requested: summary.requested,
        exports: summary.exports,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`Run directory: ${runDir}`);
  console.log(`HTTP status: ${response.status}`);
  console.log(`Items returned: ${items.length}`);
  console.log(`Error entries: ${errorItems.length}`);
  console.log(`Top-level fields (first item): ${topLevelKeys.length}`);

  if (summary.actorError) {
    console.log(
      "Actor error payload detected. See summary.json and response-raw.json.",
    );
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`jupri vrbo run failed: ${message}`);
  process.exit(1);
});
