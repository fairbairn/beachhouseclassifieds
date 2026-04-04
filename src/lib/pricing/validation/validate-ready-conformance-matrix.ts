import { promises as fs } from "node:fs";
import path from "node:path";

export type MatrixRow = {
  adapter: string;
  files: number;
  core: number;
  profile: number;
  availability: number;
  descriptionPlus: number;
  amenitiesPlus: number;
  locationPlus: number;
  mediaPlus: number;
  rates: number;
  pricingRecords: number;
  imageUrls: number;
  avgImgList: number;
  apiAvail: string;
  apiRates: string;
  apiQuote: string;
  quoteRuntime: string;
  ready: string;
};

type Mismatch = {
  column: string;
  expected: number | string;
  actual: number | string;
};

type AdapterValidationResult = {
  adapter: string;
  docReady: string;
  suggestedReady: string;
  docQuoteRuntime: string;
  suggestedQuoteRuntime: string;
  mismatchCount: number;
  mismatches: Mismatch[];
};

export type ReadyConformanceValidationSummary = {
  adaptersChecked: number;
  readyAdaptersInDoc: number;
  readyAdaptersSuggested: number;
  adaptersWithMismatches: number;
  docTotals: {
    files: number;
    core: number;
    profile: number;
    availability: number;
    descriptionPlus: number;
    amenitiesPlus: number;
    locationPlus: number;
    mediaPlus: number;
    rates: number;
    pricingRecords: number;
    imageUrls: number;
    avgImgList: number;
  };
  actualTotals: {
    files: number;
    core: number;
    profile: number;
    availability: number;
    descriptionPlus: number;
    amenitiesPlus: number;
    locationPlus: number;
    mediaPlus: number;
    rates: number;
    pricingRecords: number;
    imageUrls: number;
    avgImgList: number;
  };
  mismatches: AdapterValidationResult[];
};

type AdapterMetrics = {
  files: number;
  core: number;
  profile: number;
  availability: number;
  descriptionPlus: number;
  amenitiesPlus: number;
  locationPlus: number;
  mediaPlus: number;
  rates: number;
  pricingRecords: number;
  imageUrls: number;
  avgImgList: number;
  hasRuntime: boolean;
};

function parseMatrixRow(line: string): MatrixRow | null {
  const cells = line
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);

  if (cells.length < 18) {
    return null;
  }

  if (
    cells[0] === "Adapter" ||
    cells[0] === "**TOTAL**" ||
    /^-+$/.test(cells[0])
  ) {
    return null;
  }

  const files = Number(cells[1]);
  if (!Number.isFinite(files)) {
    return null;
  }

  return {
    adapter: cells[0],
    files: Number(cells[1]),
    core: Number(cells[2]),
    profile: Number(cells[3]),
    availability: Number(cells[4]),
    descriptionPlus: Number(cells[5]),
    amenitiesPlus: Number(cells[6]),
    locationPlus: Number(cells[7]),
    mediaPlus: Number(cells[8]),
    rates: Number(cells[9]),
    pricingRecords: Number(cells[10]),
    imageUrls: Number(cells[11]),
    avgImgList: Number(cells[12]),
    apiAvail: cells[13],
    apiRates: cells[14],
    apiQuote: cells[15],
    quoteRuntime: cells[16],
    ready: cells[17],
  };
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function computeAdapterMetrics(
  adapter: string,
  dataRoot: string,
  runtimeRoot: string,
): Promise<AdapterMetrics> {
  const jsonDir = path.join(dataRoot, adapter, "details", "json");
  const pricingDir = path.join(dataRoot, adapter, "details", "pricing");

  const jsonFiles = await listJsonFiles(jsonDir);
  const pricingFiles = (await listJsonFiles(pricingDir)).filter(
    (name) => name.toLowerCase() !== "index.json",
  );

  let core = 0;
  let profile = 0;
  let availability = 0;
  let descriptionPlus = 0;
  let amenitiesPlus = 0;
  let locationPlus = 0;
  let mediaPlus = 0;
  let rates = 0;
  let imageUrls = 0;

  for (const fileName of jsonFiles) {
    const filePath = path.join(jsonDir, fileName);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }

    if (
      hasText(parsed.external_listing_id) &&
      hasText(parsed.detail_url) &&
      hasText(parsed.fetched_at) &&
      hasText(parsed.html_path)
    ) {
      core += 1;
    }

    if (
      parsed.property_profile &&
      typeof parsed.property_profile === "object"
    ) {
      profile += 1;
    }

    if (
      parsed.normalized_availability &&
      typeof parsed.normalized_availability === "object" &&
      Array.isArray(
        (parsed.normalized_availability as { days?: unknown }).days,
      ) &&
      ((parsed.normalized_availability as { days?: unknown[] }).days?.length ??
        0) > 0
    ) {
      availability += 1;
    }

    if (hasText(parsed.description_expanded)) {
      descriptionPlus += 1;
    }

    if (parsed.amenities && typeof parsed.amenities === "object") {
      if (Object.keys(parsed.amenities).length > 0) {
        amenitiesPlus += 1;
      }
    }

    if (parsed.location && typeof parsed.location === "object") {
      if (Object.keys(parsed.location).length > 0) {
        locationPlus += 1;
      }
    }

    let imageCount = 0;
    if (parsed.media_gallery && typeof parsed.media_gallery === "object") {
      const imageUrlsValue = (parsed.media_gallery as { image_urls?: unknown })
        .image_urls;
      if (Array.isArray(imageUrlsValue)) {
        imageCount = imageUrlsValue.length;
      }
    }

    if (imageCount > 0) {
      mediaPlus += 1;
      imageUrls += imageCount;
    }

    if (
      parsed.normalized_rates &&
      typeof parsed.normalized_rates === "object" &&
      Array.isArray((parsed.normalized_rates as { days?: unknown }).days) &&
      ((parsed.normalized_rates as { days?: unknown[] }).days?.length ?? 0) > 0
    ) {
      rates += 1;
    }
  }

  const files = jsonFiles.length;
  const avgImgList = files > 0 ? Number((imageUrls / files).toFixed(2)) : 0;
  const runtimePath = path.join(runtimeRoot, `${adapter}.ts`);
  const hasRuntime = await fs
    .access(runtimePath)
    .then(() => true)
    .catch(() => false);

  return {
    files,
    core,
    profile,
    availability,
    descriptionPlus,
    amenitiesPlus,
    locationPlus,
    mediaPlus,
    rates,
    pricingRecords: pricingFiles.length,
    imageUrls,
    avgImgList,
    hasRuntime,
  };
}

export async function validateReadyConformanceMatrix(
  rootDir = process.cwd(),
): Promise<ReadyConformanceValidationSummary> {
  const docPath = path.join(rootDir, "docs", "adapter-conformance-status.md");
  const dataRoot = path.join(rootDir, "src", "lib", "data", "external-sources");
  const runtimeRoot = path.join(
    rootDir,
    "src",
    "lib",
    "pricing",
    "quote-runtime",
    "adapters",
  );

  const doc = await fs.readFile(docPath, "utf8");
  const allRows = doc
    .split(/\r?\n/)
    .map(parseMatrixRow)
    .filter((row): row is MatrixRow => row !== null);

  const results: AdapterValidationResult[] = [];
  const docTotals = {
    files: 0,
    core: 0,
    profile: 0,
    availability: 0,
    descriptionPlus: 0,
    amenitiesPlus: 0,
    locationPlus: 0,
    mediaPlus: 0,
    rates: 0,
    pricingRecords: 0,
    imageUrls: 0,
    avgImgList: 0,
  };
  const actualTotals = {
    files: 0,
    core: 0,
    profile: 0,
    availability: 0,
    descriptionPlus: 0,
    amenitiesPlus: 0,
    locationPlus: 0,
    mediaPlus: 0,
    rates: 0,
    pricingRecords: 0,
    imageUrls: 0,
    avgImgList: 0,
  };
  let readyAdaptersInDoc = 0;
  let readyAdaptersSuggested = 0;

  for (const row of allRows) {
    if (row.ready === "✅") {
      readyAdaptersInDoc += 1;
    }

    docTotals.files += row.files;
    docTotals.core += row.core;
    docTotals.profile += row.profile;
    docTotals.availability += row.availability;
    docTotals.descriptionPlus += row.descriptionPlus;
    docTotals.amenitiesPlus += row.amenitiesPlus;
    docTotals.locationPlus += row.locationPlus;
    docTotals.mediaPlus += row.mediaPlus;
    docTotals.rates += row.rates;
    docTotals.pricingRecords += row.pricingRecords;
    docTotals.imageUrls += row.imageUrls;

    const actual = await computeAdapterMetrics(
      row.adapter,
      dataRoot,
      runtimeRoot,
    );

    actualTotals.files += actual.files;
    actualTotals.core += actual.core;
    actualTotals.profile += actual.profile;
    actualTotals.availability += actual.availability;
    actualTotals.descriptionPlus += actual.descriptionPlus;
    actualTotals.amenitiesPlus += actual.amenitiesPlus;
    actualTotals.locationPlus += actual.locationPlus;
    actualTotals.mediaPlus += actual.mediaPlus;
    actualTotals.rates += actual.rates;
    actualTotals.pricingRecords += actual.pricingRecords;
    actualTotals.imageUrls += actual.imageUrls;

    const mismatches: Mismatch[] = [];

    const pairs: Array<[string, number, number]> = [
      ["files", row.files, actual.files],
      ["core", row.core, actual.core],
      ["profile", row.profile, actual.profile],
      ["availability", row.availability, actual.availability],
      ["descriptionPlus", row.descriptionPlus, actual.descriptionPlus],
      ["amenitiesPlus", row.amenitiesPlus, actual.amenitiesPlus],
      ["locationPlus", row.locationPlus, actual.locationPlus],
      ["mediaPlus", row.mediaPlus, actual.mediaPlus],
      ["rates", row.rates, actual.rates],
      ["pricingRecords", row.pricingRecords, actual.pricingRecords],
      ["imageUrls", row.imageUrls, actual.imageUrls],
      ["avgImgList", Number(row.avgImgList.toFixed(2)), actual.avgImgList],
    ];

    for (const [name, expected, got] of pairs) {
      if (expected !== got) {
        mismatches.push({ column: name, expected, actual: got });
      }
    }

    if (row.apiAvail !== "✅" && row.apiAvail !== "-") {
      mismatches.push({
        column: "apiAvail",
        expected: "✅ or -",
        actual: row.apiAvail,
      });
    }

    if (row.apiRates !== "✅" && row.apiRates !== "-") {
      mismatches.push({
        column: "apiRates",
        expected: "✅ or -",
        actual: row.apiRates,
      });
    }

    if (row.apiQuote !== "✅" && row.apiQuote !== "❌") {
      mismatches.push({
        column: "apiQuote",
        expected: "✅ or ❌",
        actual: row.apiQuote,
      });
    }

    if (row.quoteRuntime !== "✅" && row.quoteRuntime !== "❌") {
      mismatches.push({
        column: "quoteRuntime",
        expected: "✅ or ❌",
        actual: row.quoteRuntime,
      });
    }

    const expectedRuntimeSymbol = actual.hasRuntime ? "✅" : "❌";
    if (row.quoteRuntime !== expectedRuntimeSymbol) {
      mismatches.push({
        column: "quoteRuntime(runtime-file)",
        expected: expectedRuntimeSymbol,
        actual: row.quoteRuntime,
      });
    }

    // Derived, table-based readiness using currently visible matrix signals.
    const hasCoverageParity =
      row.files === actual.files &&
      actual.files === actual.core &&
      actual.files === actual.profile &&
      actual.files === actual.availability &&
      actual.files === actual.descriptionPlus &&
      actual.files === actual.amenitiesPlus &&
      actual.files === actual.locationPlus &&
      actual.files === actual.mediaPlus;
    const hasPricingParity = actual.pricingRecords === actual.files;
    const hasQuoteApi = row.apiQuote === "✅";
    const hasQuoteRuntime = expectedRuntimeSymbol === "✅";
    const suggestedReady =
      hasCoverageParity && hasPricingParity && hasQuoteApi && hasQuoteRuntime
        ? "✅"
        : "❌";

    if (suggestedReady === "✅") {
      readyAdaptersSuggested += 1;
    }

    if (row.ready !== suggestedReady) {
      mismatches.push({
        column: "ready(derived-table-state)",
        expected: suggestedReady,
        actual: row.ready,
      });
    }

    results.push({
      adapter: row.adapter,
      docReady: row.ready,
      suggestedReady,
      docQuoteRuntime: row.quoteRuntime,
      suggestedQuoteRuntime: expectedRuntimeSymbol,
      mismatchCount: mismatches.length,
      mismatches,
    });
  }

  docTotals.avgImgList =
    docTotals.files > 0
      ? Number((docTotals.imageUrls / docTotals.files).toFixed(2))
      : 0;
  actualTotals.avgImgList =
    actualTotals.files > 0
      ? Number((actualTotals.imageUrls / actualTotals.files).toFixed(2))
      : 0;

  return {
    adaptersChecked: results.length,
    readyAdaptersInDoc,
    readyAdaptersSuggested,
    adaptersWithMismatches: results.filter((result) => result.mismatchCount > 0)
      .length,
    docTotals,
    actualTotals,
    mismatches: results.filter((result) => result.mismatchCount > 0),
  };
}

export async function runValidateReadyConformanceMatrixCli(
  args: string[],
): Promise<number> {
  const rootDirArg = args.find((arg) => arg.startsWith("--root-dir="));
  const strict = args.includes("--strict");
  const rootDir = rootDirArg
    ? rootDirArg.slice("--root-dir=".length)
    : process.cwd();

  const summary = await validateReadyConformanceMatrix(rootDir);
  console.log(JSON.stringify(summary, null, 2));
  return strict && summary.adaptersWithMismatches > 0 ? 1 : 0;
}
