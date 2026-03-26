import "@/core/tooling/env/load-env-profile";

import chalk from "chalk";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Pool } from "pg";
import sharp from "sharp";

const CTRL_C_EXIT_CODE = 130;
const FAILURE_EXIT_CODE = 1;
const supportsColor = process.stdout.isTTY;

type Args = {
  stage: "stage1" | "stage2" | "both";
  limit: number;
  listingConcurrency: number;
  imageConcurrency: number;
  maxImagesPerListing: number;
  maxRetries: number;
  listingId: string | null;
  sourceListingIds: string[];
  originalsNamespace: string;
  finalNamespace: string;
  statePath: string;
  reportPath: string;
  ledgerPath: string;
  manifestPath: string;
  forceReprocess: boolean;
};

type ListingCandidate = {
  listingId: string;
  sourceType: string;
  sourceId: string;
  referenceId: string;
  title: string;
  gallery: unknown;
};

type GalleryImage = {
  ordinal: number;
  sourceUrlRaw: string;
  sourceUrlCanonical: string;
  sourceUrlHash: string;
  sourceFilename: string;
  alt: string | null;
};

type ListingRunSummary = {
  listingId: string;
  sourceId: string;
  referenceId: string;
  title: string;
  status: "ok" | "failed";
  totalImages: number;
  processedImages: number;
  skippedImages: number;
  failedImages: number;
  primaryImageId: string | null;
  uploadedOriginalSourceUrlHashes: string[];
  uploadedFinalSourceUrlHashes: string[];
  elapsedMs: number;
  error?: string;
};

type PipelineState = {
  createdAt: string;
  runs: Record<
    string,
    {
      status: "ok" | "failed";
      attempts: number;
      lastRunAt: string;
      processedImages: number;
      failedImages: number;
      elapsedMs: number;
      uploadedOriginalSourceUrlHashes: string[];
      uploadedFinalSourceUrlHashes: string[];
      error: string | null;
    }
  >;
};

type B2AuthResponse = {
  apiUrl: string;
  authorizationToken: string;
  downloadUrl: string;
};

type B2UploadUrlResponse = {
  uploadUrl: string;
  authorizationToken: string;
};

type LedgerEntry = {
  run_id?: string;
  status?: string;
  uploaded_original?: boolean;
  uploaded_final?: boolean;
};

type RunReconciliation = {
  ledgerLinesForRun: number;
  ledgerUploadedRecords: number;
  ledgerFailedRecords: number;
  ledgerSkippedRecords: number;
  ledgerUploadedOriginalCount: number;
  ledgerUploadedFinalCount: number;
  expectedUploadedRecords: number;
  expectedFailedRecords: number;
  expectedSkippedRecords: number;
  expectedUploadedOriginalCount: number;
  expectedUploadedFinalCount: number;
  matches: {
    uploadedRecords: boolean;
    failedRecords: boolean;
    skippedRecords: boolean;
    uploadedOriginalCount: boolean;
    uploadedFinalCount: boolean;
    all: boolean;
  };
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function normalizePathPrefix(value: string): string {
  return String(value)
    .trim()
    .replace(/^\/+|\/+$/g, "");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    stage: "both",
    limit: 10,
    listingConcurrency: 1,
    imageConcurrency: 1,
    maxImagesPerListing: 0,
    maxRetries: 3,
    listingId: null,
    sourceListingIds: [],
    originalsNamespace: "listing-originals",
    finalNamespace: "images",
    statePath: ".tmp/reports/source-image-pull-state.json",
    reportPath: ".tmp/reports/source-image-pull-report.json",
    ledgerPath: ".tmp/reports/source-image-pull-ledger.jsonl",
    manifestPath: ".tmp/reports/source-image-pull-manifest.jsonl",
    forceReprocess: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === "--limit" && next) {
      args.limit = parsePositiveInt(next, args.limit);
      i += 1;
      continue;
    }
    if (token === "--stage" && next) {
      const value = next.trim().toLowerCase();
      if (value !== "stage1" && value !== "stage2" && value !== "both") {
        throw new Error("Invalid --stage value. Use stage1, stage2, or both.");
      }
      args.stage = value;
      i += 1;
      continue;
    }
    if (token === "--listing-concurrency" && next) {
      args.listingConcurrency = parsePositiveInt(next, args.listingConcurrency);
      i += 1;
      continue;
    }
    if (token === "--image-concurrency" && next) {
      args.imageConcurrency = parsePositiveInt(next, args.imageConcurrency);
      i += 1;
      continue;
    }
    if (token === "--max-images-per-listing" && next) {
      args.maxImagesPerListing = parsePositiveInt(
        next,
        args.maxImagesPerListing,
      );
      i += 1;
      continue;
    }
    if (token === "--max-retries" && next) {
      args.maxRetries = parsePositiveInt(next, args.maxRetries);
      i += 1;
      continue;
    }
    if (token === "--listing-id" && next) {
      args.listingId = next.trim();
      i += 1;
      continue;
    }
    if (token === "--source-listing-ids" && next) {
      args.sourceListingIds = next
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      i += 1;
      continue;
    }
    if (token === "--originals-namespace" && next) {
      args.originalsNamespace = next;
      i += 1;
      continue;
    }
    if (token === "--final-namespace" && next) {
      args.finalNamespace = next;
      i += 1;
      continue;
    }
    if (token === "--state-path" && next) {
      args.statePath = next;
      i += 1;
      continue;
    }
    if (token === "--report-path" && next) {
      args.reportPath = next;
      i += 1;
      continue;
    }
    if (token === "--ledger-path" && next) {
      args.ledgerPath = next;
      i += 1;
      continue;
    }
    if (token === "--manifest-path" && next) {
      args.manifestPath = next;
      i += 1;
      continue;
    }
    if (token === "--force-reprocess") {
      args.forceReprocess = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      console.log(
        "Usage: tsx src/lib/scripts/pull-source-images-to-b2.ts [--stage stage1|stage2|both] [--listing-id <canonical_or_source_id>] [--limit 10] [--listing-concurrency 2] [--image-concurrency 3] [--force-reprocess]",
      );
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  args.originalsNamespace = normalizePathPrefix(args.originalsNamespace);
  args.finalNamespace = normalizePathPrefix(args.finalNamespace);

  if (!args.originalsNamespace) {
    throw new Error("Invalid originals namespace.");
  }
  if (!args.finalNamespace) {
    throw new Error("Invalid final namespace.");
  }

  return args;
}

function colorize(value: string, painter: (text: string) => string): string {
  if (!supportsColor) {
    return value;
  }

  return painter(value);
}

function formatMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function toBasicAuth(keyId: string, applicationKey: string): string {
  return Buffer.from(`${keyId}:${applicationKey}`, "utf8").toString("base64");
}

function stripUrlQueryParams(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function normalizeAlt(value: unknown): string | null {
  const alt = String(value ?? "").trim();
  return alt.length > 0 ? alt : null;
}

function sourceFilenameFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const file = basename(parsed.pathname);
    if (file) {
      return file;
    }
  } catch {
    // ignore
  }

  return "image.jpg";
}

function normalizeGalleryImages(gallery: unknown): GalleryImage[] {
  if (!Array.isArray(gallery)) {
    return [];
  }

  const out: GalleryImage[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < gallery.length; index += 1) {
    const item = gallery[index];
    const record =
      item && typeof item === "object"
        ? (item as Record<string, unknown>)
        : null;
    const sourceUrlRaw = String(record?.url ?? "").trim();

    if (!sourceUrlRaw) {
      continue;
    }

    try {
      const sourceUrlCanonical = stripUrlQueryParams(sourceUrlRaw);
      if (seen.has(sourceUrlCanonical)) {
        continue;
      }
      seen.add(sourceUrlCanonical);

      const sourceUrlHash = createHash("sha1")
        .update(sourceUrlCanonical)
        .digest("hex")
        .slice(0, 20);

      out.push({
        ordinal: out.length + 1,
        sourceUrlRaw,
        sourceUrlCanonical,
        sourceUrlHash,
        sourceFilename: sourceFilenameFromUrl(sourceUrlCanonical),
        alt: normalizeAlt(
          record?.name ?? record?.caption ?? record?.description,
        ),
      });
    } catch {
      continue;
    }
  }

  return out;
}

function guessExtensionFromContentType(contentType: string): string {
  const lower = contentType.toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("avif")) return "avif";
  return "jpg";
}

async function postProcessForFinalImage(params: {
  bytes: Buffer;
  sourceContentType: string;
}): Promise<{
  bytes: Buffer;
  contentType: string;
  transform: {
    engine: "sharp";
    profile: "truthful-v1";
    normalized: boolean;
    brightness: number;
    saturation: number;
    gamma: number;
    sharpen: string;
    sourceContentType: string;
    outputContentType: string;
  };
}> {
  const processed = await sharp(params.bytes, { failOn: "none" })
    .normalize()
    .modulate({
      brightness: 1.02,
      saturation: 1.03,
    })
    .gamma(1.02)
    .sharpen({
      sigma: 0.6,
      m1: 0.8,
      m2: 2,
      x1: 2,
      y2: 10,
      y3: 20,
    })
    .jpeg({
      quality: 95,
      chromaSubsampling: "4:4:4",
      mozjpeg: true,
    })
    .toBuffer();

  return {
    bytes: processed,
    contentType: "image/jpeg",
    transform: {
      engine: "sharp",
      profile: "truthful-v1",
      normalized: true,
      brightness: 1.02,
      saturation: 1.03,
      gamma: 1.02,
      sharpen: "sigma=0.6,m1=0.8,m2=2,x1=2,y2=10,y3=20",
      sourceContentType: params.sourceContentType,
      outputContentType: "image/jpeg",
    },
  };
}

function buildOriginalKey(input: {
  originalsNamespace: string;
  sourceType: string;
  sourceId: string;
  sourceFilename: string;
}): string {
  const sourceTypePath =
    String(input.sourceType).trim().toLowerCase() || "unknown";
  return `${input.originalsNamespace}/${sourceTypePath}/${input.sourceId}/${input.sourceFilename}`;
}

function buildFinalKey(input: {
  finalNamespace: string;
  referenceId: string;
  contentHash: string;
  extension: string;
}): string {
  const ref = input.referenceId.trim();
  const shard2 = ref.slice(0, 2).padEnd(2, "0");
  const shard4 = ref.slice(0, 4).padEnd(4, "0");
  return `${input.finalNamespace}/${shard2}/${shard4}/${ref}/${input.contentHash}.${input.extension}`;
}

function loadState(path: string): PipelineState {
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text) as Partial<PipelineState>;

    if (!parsed || typeof parsed !== "object") {
      return { createdAt: new Date().toISOString(), runs: {} };
    }

    const runs = parsed.runs ?? {};
    for (const key of Object.keys(runs)) {
      const typedRuns = runs as Record<
        string,
        {
          uploadedOriginalSourceUrlHashes?: unknown;
          uploadedFinalSourceUrlHashes?: unknown;
        }
      >;
      if (!Array.isArray(typedRuns[key].uploadedOriginalSourceUrlHashes)) {
        typedRuns[key].uploadedOriginalSourceUrlHashes = [];
      }
      if (!Array.isArray(typedRuns[key].uploadedFinalSourceUrlHashes)) {
        typedRuns[key].uploadedFinalSourceUrlHashes = [];
      }
    }

    return {
      createdAt: String(parsed.createdAt ?? new Date().toISOString()),
      runs: runs as PipelineState["runs"],
    };
  } catch {
    return { createdAt: new Date().toISOString(), runs: {} };
  }
}

function saveState(path: string, state: PipelineState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

async function authorizeB2(
  keyId: string,
  applicationKey: string,
): Promise<B2AuthResponse> {
  const response = await fetch(
    "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
    {
      method: "GET",
      headers: {
        Authorization: `Basic ${toBasicAuth(keyId, applicationKey)}`,
      },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `b2_authorize_account failed (${response.status}): ${body}`,
    );
  }

  return (await response.json()) as B2AuthResponse;
}

async function getUploadUrl(
  apiUrl: string,
  authToken: string,
  bucketId: string,
): Promise<B2UploadUrlResponse> {
  const response = await fetch(`${apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: "POST",
    headers: {
      Authorization: authToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bucketId }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`b2_get_upload_url failed (${response.status}): ${body}`);
  }

  return (await response.json()) as B2UploadUrlResponse;
}

async function uploadToB2(params: {
  uploadInfo: B2UploadUrlResponse;
  b2Key: string;
  bytes: Buffer;
  contentType: string;
}): Promise<void> {
  const sha1 = createHash("sha1").update(params.bytes).digest("hex");
  const response = await fetch(params.uploadInfo.uploadUrl, {
    method: "POST",
    headers: {
      Authorization: params.uploadInfo.authorizationToken,
      "X-Bz-File-Name": encodeURIComponent(params.b2Key),
      "Content-Type": params.contentType,
      "Content-Length": String(params.bytes.byteLength),
      "X-Bz-Content-Sha1": sha1,
    },
    body: new Uint8Array(params.bytes),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`b2 upload failed (${response.status}): ${body}`);
  }
}

async function retry<T>(
  label: string,
  maxRetries: number,
  fn: () => Promise<T>,
): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries) {
        break;
      }

      console.warn(
        `${colorize("retry", chalk.bgYellow.black.bold)} ${label} attempt=${attempt}/${maxRetries}`,
      );
      await new Promise((resolveSleep) =>
        setTimeout(resolveSleep, 400 * attempt),
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function createConcurrencyGate(maxConcurrency: number): {
  run: <T>(fn: () => Promise<T>) => Promise<T>;
} {
  const limit = Math.max(1, maxConcurrency);
  let active = 0;
  const queue: Array<() => void> = [];

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }

    active += 1;
    try {
      return await fn();
    } finally {
      active = Math.max(0, active - 1);
      const next = queue.shift();
      if (next) {
        next();
      }
    }
  }

  return { run };
}

function reconcileRunAgainstLedger(params: {
  ledgerPath: string;
  runId: string;
  args: Args;
  totals: {
    imagesUploaded: number;
    imagesSkipped: number;
    imagesFailed: number;
  };
}): RunReconciliation {
  let text = "";
  try {
    text = readFileSync(params.ledgerPath, "utf8");
  } catch {
    text = "";
  }

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const runEntries: LedgerEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as LedgerEntry;
      if (parsed.run_id === params.runId) {
        runEntries.push(parsed);
      }
    } catch {
      continue;
    }
  }

  let ledgerUploadedRecords = 0;
  let ledgerFailedRecords = 0;
  let ledgerSkippedRecords = 0;
  let ledgerUploadedOriginalCount = 0;
  let ledgerUploadedFinalCount = 0;

  for (const entry of runEntries) {
    const status = String(entry.status ?? "");
    if (status === "uploaded") {
      ledgerUploadedRecords += 1;
      if (entry.uploaded_original) {
        ledgerUploadedOriginalCount += 1;
      }
      if (entry.uploaded_final) {
        ledgerUploadedFinalCount += 1;
      }
      continue;
    }

    if (status === "failed") {
      ledgerFailedRecords += 1;
      continue;
    }

    if (status.startsWith("skipped_")) {
      ledgerSkippedRecords += 1;
    }
  }

  const expectedUploadedRecords = params.totals.imagesUploaded;
  const expectedFailedRecords = params.totals.imagesFailed;
  const expectedSkippedRecords = params.totals.imagesSkipped;
  const expectedUploadedOriginalCount =
    params.args.stage === "stage2" ? 0 : params.totals.imagesUploaded;
  const expectedUploadedFinalCount =
    params.args.stage === "stage1" ? 0 : params.totals.imagesUploaded;

  const matchesUploadedRecords =
    ledgerUploadedRecords === expectedUploadedRecords;
  const matchesFailedRecords = ledgerFailedRecords === expectedFailedRecords;
  const matchesSkippedRecords = ledgerSkippedRecords === expectedSkippedRecords;
  const matchesUploadedOriginalCount =
    ledgerUploadedOriginalCount === expectedUploadedOriginalCount;
  const matchesUploadedFinalCount =
    ledgerUploadedFinalCount === expectedUploadedFinalCount;

  return {
    ledgerLinesForRun: runEntries.length,
    ledgerUploadedRecords,
    ledgerFailedRecords,
    ledgerSkippedRecords,
    ledgerUploadedOriginalCount,
    ledgerUploadedFinalCount,
    expectedUploadedRecords,
    expectedFailedRecords,
    expectedSkippedRecords,
    expectedUploadedOriginalCount,
    expectedUploadedFinalCount,
    matches: {
      uploadedRecords: matchesUploadedRecords,
      failedRecords: matchesFailedRecords,
      skippedRecords: matchesSkippedRecords,
      uploadedOriginalCount: matchesUploadedOriginalCount,
      uploadedFinalCount: matchesUploadedFinalCount,
      all:
        matchesUploadedRecords &&
        matchesFailedRecords &&
        matchesSkippedRecords &&
        matchesUploadedOriginalCount &&
        matchesUploadedFinalCount,
    },
  };
}

async function selectListings(
  db: Pool,
  args: Args,
): Promise<ListingCandidate[]> {
  if (args.listingId) {
    const { rows } = await db.query<ListingCandidate>(
      `
        with latest_source as (
          select distinct on (s.listing_id)
            s.listing_id,
            s.source_type,
            s.source_id,
            s.payload,
            s.updated_at
          from sources s
          order by s.listing_id, s.updated_at desc, s.created_at desc
        )
        select
          l.id as "listingId",
          ls.source_type as "sourceType",
          ls.source_id as "sourceId",
          l.id as "referenceId",
          l.title,
          ls.payload->'gallery' as gallery
        from latest_source ls
        join listing l on l.id = ls.listing_id
        where jsonb_typeof(ls.payload->'gallery') = 'array'
          and (l.id = $1 or ls.source_id = $1)
        limit 1
      `,
      [args.listingId],
    );

    return rows ?? [];
  }

  if (args.sourceListingIds.length > 0) {
    const { rows } = await db.query<ListingCandidate>(
      `
        with latest_source as (
          select distinct on (s.listing_id)
            s.listing_id,
            s.source_type,
            s.source_id,
            s.payload,
            s.updated_at
          from sources s
          where s.source_id = any($1::text[])
          order by s.listing_id, s.updated_at desc, s.created_at desc
        )
        select
          l.id as "listingId",
          ls.source_type as "sourceType",
          ls.source_id as "sourceId",
          l.id as "referenceId",
          l.title,
          ls.payload->'gallery' as gallery
        from latest_source ls
        join listing l on l.id = ls.listing_id
        where jsonb_typeof(ls.payload->'gallery') = 'array'
      `,
      [args.sourceListingIds],
    );

    return rows ?? [];
  }

  const { rows } = await db.query<ListingCandidate>(
    `
      with latest_source as (
        select distinct on (s.listing_id)
          s.listing_id,
          s.source_type,
          s.source_id,
          s.payload,
          s.updated_at
        from sources s
        order by s.listing_id, s.updated_at desc, s.created_at desc
      )
      select
        l.id as "listingId",
        ls.source_type as "sourceType",
        ls.source_id as "sourceId",
        l.id as "referenceId",
        l.title,
        ls.payload->'gallery' as gallery
      from latest_source ls
      join listing l on l.id = ls.listing_id
      where jsonb_typeof(ls.payload->'gallery') = 'array'
      order by ls.updated_at desc, l.id asc
      limit $1
    `,
    [args.limit],
  );

  return rows ?? [];
}

async function appendJsonLine(path: string, line: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(line)}\n`, "utf8");
}

async function runSingleListing(params: {
  listing: ListingCandidate;
  args: Args;
  runId: string;
  b2BucketName: string;
  b2AuthToken: string;
  b2DownloadUrl: string;
  uploadUrlState: { current: B2UploadUrlResponse };
  apiUrl: string;
  b2BucketId: string;
  ledgerPath: string;
  manifestPath: string;
  interruptedRef: { interrupted: boolean };
  state: PipelineState;
  uploadGate: { run: <T>(fn: () => Promise<T>) => Promise<T> };
}): Promise<ListingRunSummary> {
  const startedAt = Date.now();
  const { listing } = params;
  const galleryImages = normalizeGalleryImages(listing.gallery);
  const scopedImages =
    params.args.maxImagesPerListing > 0
      ? galleryImages.slice(0, params.args.maxImagesPerListing)
      : galleryImages;

  const existingRun = params.state.runs[listing.listingId];
  const uploadedOriginalHashes = new Set(
    existingRun?.uploadedOriginalSourceUrlHashes ?? [],
  );
  const uploadedFinalHashes = new Set(
    existingRun?.uploadedFinalSourceUrlHashes ?? [],
  );

  let processedImages = 0;
  let skippedImages = 0;
  let failedImages = 0;
  let primaryImageId: string | null = null;
  const isStage1 = params.args.stage === "stage1";
  const isStage2 = params.args.stage === "stage2";
  const isBoth = params.args.stage === "both";

  if (scopedImages.length === 0) {
    return {
      listingId: listing.listingId,
      sourceId: listing.sourceId,
      referenceId: listing.referenceId,
      title: listing.title,
      status: "failed",
      totalImages: 0,
      processedImages,
      skippedImages,
      failedImages: 1,
      primaryImageId,
      uploadedOriginalSourceUrlHashes: [...uploadedOriginalHashes],
      uploadedFinalSourceUrlHashes: [...uploadedFinalHashes],
      elapsedMs: Date.now() - startedAt,
      error: "No usable gallery image URLs",
    };
  }

  console.log(
    `${colorize("stage", chalk.bgCyan.black.bold)} listing=${colorize(listing.listingId, chalk.white.bold)} source=${colorize(listing.sourceId, chalk.white.bold)} images=${colorize(String(scopedImages.length), chalk.white.bold)}`,
  );

  let nextImageIndex = 0;

  async function processImage(image: GalleryImage): Promise<void> {
    if (params.interruptedRef.interrupted) {
      return;
    }

    const alreadyDoneForStage =
      (isStage1 && uploadedOriginalHashes.has(image.sourceUrlHash)) ||
      (isStage2 && uploadedFinalHashes.has(image.sourceUrlHash)) ||
      (isBoth &&
        uploadedOriginalHashes.has(image.sourceUrlHash) &&
        uploadedFinalHashes.has(image.sourceUrlHash));

    if (!params.args.forceReprocess && alreadyDoneForStage) {
      skippedImages += 1;
      await appendJsonLine(params.ledgerPath, {
        run_id: params.runId,
        created_at: new Date().toISOString(),
        listing_id: listing.listingId,
        source_id: listing.sourceId,
        reference_id: listing.referenceId,
        ordinal: image.ordinal,
        source_url_raw: image.sourceUrlRaw,
        source_url_canonical: image.sourceUrlCanonical,
        source_url_hash: image.sourceUrlHash,
        source_filename: image.sourceFilename,
        alt: image.alt,
        status: "skipped_already_uploaded",
      });
      return;
    }

    try {
      const originalKey = buildOriginalKey({
        originalsNamespace: params.args.originalsNamespace,
        sourceType: listing.sourceType,
        sourceId: listing.sourceId,
        sourceFilename: image.sourceFilename,
      });

      const response = await retry(
        `download listing=${listing.listingId} image=${image.ordinal}`,
        params.args.maxRetries,
        async () => {
          if (isStage2 && !isBoth) {
            return fetch(
              `${params.b2DownloadUrl}/file/${params.b2BucketName}/${encodeURIComponent(originalKey)}`,
              {
                method: "GET",
                headers: {
                  Authorization: params.b2AuthToken,
                },
              },
            );
          }

          return fetch(image.sourceUrlCanonical, {
            method: "GET",
            redirect: "follow",
          });
        },
      );

      if (!response.ok) {
        throw new Error(`download_http_${response.status}`);
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") ?? "image/jpeg";
      const originalContentHash = createHash("sha1")
        .update(bytes)
        .digest("hex");

      let finalBytes = bytes;
      let finalContentType = contentType;
      let finalTransform: {
        engine: "sharp";
        profile: "truthful-v1";
        normalized: boolean;
        brightness: number;
        saturation: number;
        gamma: number;
        sharpen: string;
        sourceContentType: string;
        outputContentType: string;
      } | null = null;

      if (isStage2 || isBoth) {
        const transformed = await postProcessForFinalImage({
          bytes,
          sourceContentType: contentType,
        });
        finalBytes = Buffer.from(transformed.bytes);
        finalContentType = transformed.contentType;
        finalTransform = transformed.transform;
      }

      const finalContentHash = createHash("sha1")
        .update(finalBytes)
        .digest("hex");
      const imageId = originalContentHash;
      const ext = guessExtensionFromContentType(finalContentType);

      const finalKey = buildFinalKey({
        finalNamespace: params.args.finalNamespace,
        referenceId: listing.referenceId,
        contentHash: imageId,
        extension: ext,
      });

      if (
        !params.args.forceReprocess &&
        isStage2 &&
        uploadedFinalHashes.has(image.sourceUrlHash)
      ) {
        skippedImages += 1;
        uploadedOriginalHashes.add(image.sourceUrlHash);
        if (!primaryImageId && image.ordinal === 1) {
          primaryImageId = imageId;
        }

        await appendJsonLine(params.ledgerPath, {
          run_id: params.runId,
          created_at: new Date().toISOString(),
          listing_id: listing.listingId,
          source_id: listing.sourceId,
          reference_id: listing.referenceId,
          ordinal: image.ordinal,
          source_url_raw: image.sourceUrlRaw,
          source_url_canonical: image.sourceUrlCanonical,
          source_url_hash: image.sourceUrlHash,
          source_filename: image.sourceFilename,
          image_id: imageId,
          alt: image.alt,
          original_b2_bucket_name: params.b2BucketName,
          original_b2_key: originalKey,
          original_b2_full_path: `${params.b2BucketName}/${originalKey}`,
          final_b2_bucket_name: params.b2BucketName,
          final_b2_key: finalKey,
          final_b2_full_path: `${params.b2BucketName}/${finalKey}`,
          content_type: contentType,
          original_content_hash: originalContentHash,
          final_content_hash: finalContentHash,
          size_bytes: bytes.byteLength,
          status: "skipped_final_present",
        });
        return;
      }

      if (isStage1 || isBoth) {
        await params.uploadGate.run(async () => {
          await retry(
            `upload-original listing=${listing.listingId} image=${image.ordinal}`,
            params.args.maxRetries,
            async () => {
              try {
                await uploadToB2({
                  uploadInfo: params.uploadUrlState.current,
                  b2Key: originalKey,
                  bytes,
                  contentType,
                });
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                if (
                  message.includes("401") ||
                  message.includes("503") ||
                  message.includes("500")
                ) {
                  params.uploadUrlState.current = await getUploadUrl(
                    params.apiUrl,
                    params.b2AuthToken,
                    params.b2BucketId,
                  );
                  await uploadToB2({
                    uploadInfo: params.uploadUrlState.current,
                    b2Key: originalKey,
                    bytes,
                    contentType,
                  });
                  return;
                }
                throw error;
              }
            },
          );
        });
      }

      if (isStage2 || isBoth) {
        await params.uploadGate.run(async () => {
          await retry(
            `upload-final listing=${listing.listingId} image=${image.ordinal}`,
            params.args.maxRetries,
            async () => {
              try {
                await uploadToB2({
                  uploadInfo: params.uploadUrlState.current,
                  b2Key: finalKey,
                  bytes: finalBytes,
                  contentType: finalContentType,
                });
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                if (
                  message.includes("401") ||
                  message.includes("503") ||
                  message.includes("500")
                ) {
                  params.uploadUrlState.current = await getUploadUrl(
                    params.apiUrl,
                    params.b2AuthToken,
                    params.b2BucketId,
                  );
                  await uploadToB2({
                    uploadInfo: params.uploadUrlState.current,
                    b2Key: finalKey,
                    bytes: finalBytes,
                    contentType: finalContentType,
                  });
                  return;
                }
                throw error;
              }
            },
          );
        });
      }

      if (!primaryImageId && image.ordinal === 1) {
        primaryImageId = imageId;
      }

      if (isStage1 || isBoth) {
        uploadedOriginalHashes.add(image.sourceUrlHash);
      }
      if (isStage2 || isBoth) {
        uploadedFinalHashes.add(image.sourceUrlHash);
      }
      processedImages += 1;

      const archiveRecord = {
        run_id: params.runId,
        created_at: new Date().toISOString(),
        listing_id: listing.listingId,
        source_id: listing.sourceId,
        reference_id: listing.referenceId,
        title: listing.title,
        ordinal: image.ordinal,
        source_url_raw: image.sourceUrlRaw,
        source_url_canonical: image.sourceUrlCanonical,
        source_url_hash: image.sourceUrlHash,
        source_filename: image.sourceFilename,
        image_id: imageId,
        alt: image.alt,
        original_content_hash: originalContentHash,
        final_content_hash: finalContentHash,
        original_b2_bucket_name: params.b2BucketName,
        original_b2_key: originalKey,
        original_b2_full_path: `${params.b2BucketName}/${originalKey}`,
        final_b2_bucket_name: params.b2BucketName,
        final_b2_key: finalKey,
        final_b2_full_path: `${params.b2BucketName}/${finalKey}`,
        content_type: finalContentType,
        size_bytes: finalBytes.byteLength,
        post_processing: finalTransform,
        uploaded_original: isStage1 || isBoth,
        uploaded_final: isStage2 || isBoth,
        primary_candidate: image.ordinal === 1,
        status: "uploaded",
        stage: params.args.stage,
      };

      await appendJsonLine(params.ledgerPath, archiveRecord);
      await appendJsonLine(params.manifestPath, archiveRecord);

      console.log(
        `${colorize("processed", chalk.bgGreen.black.bold)} listing=${listing.listingId} image=${image.ordinal}/${scopedImages.length} size=${bytes.byteLength}`,
      );
    } catch (error) {
      failedImages += 1;
      const message = error instanceof Error ? error.message : String(error);

      await appendJsonLine(params.ledgerPath, {
        run_id: params.runId,
        created_at: new Date().toISOString(),
        listing_id: listing.listingId,
        source_id: listing.sourceId,
        reference_id: listing.referenceId,
        ordinal: image.ordinal,
        source_url_raw: image.sourceUrlRaw,
        source_url_canonical: image.sourceUrlCanonical,
        source_url_hash: image.sourceUrlHash,
        source_filename: image.sourceFilename,
        alt: image.alt,
        status: "failed",
        error: message,
      });

      console.error(
        `${colorize("failed", chalk.bgRed.white.bold)} listing=${listing.listingId} image=${image.ordinal}/${scopedImages.length} reason=${message}`,
      );
    }
  }

  async function imageWorkerLoop(): Promise<void> {
    while (!params.interruptedRef.interrupted) {
      const index = nextImageIndex;
      nextImageIndex += 1;

      if (index >= scopedImages.length) {
        return;
      }

      await processImage(scopedImages[index]);
    }
  }

  const imageWorkerCount = Math.max(
    1,
    Math.min(params.args.imageConcurrency, scopedImages.length),
  );

  await Promise.all(
    Array.from({ length: imageWorkerCount }, () => imageWorkerLoop()),
  );

  return {
    listingId: listing.listingId,
    sourceId: listing.sourceId,
    referenceId: listing.referenceId,
    title: listing.title,
    status: failedImages > 0 ? "failed" : "ok",
    totalImages: scopedImages.length,
    processedImages,
    skippedImages,
    failedImages,
    primaryImageId,
    uploadedOriginalSourceUrlHashes: [...uploadedOriginalHashes],
    uploadedFinalSourceUrlHashes: [...uploadedFinalHashes],
    elapsedMs: Date.now() - startedAt,
    error: failedImages > 0 ? "One or more images failed" : undefined,
  };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `source-image-pull-${new Date().toISOString()}`;
  const startedAt = Date.now();

  const databaseUrl = required("DATABASE_URL");
  const b2KeyId = required("B2_KEY_ID");
  const b2ApplicationKey = required("B2_APPLICATION_KEY");
  const b2BucketId = required("B2_BUCKET_ID");
  const b2BucketName = required("B2_BUCKET_NAME");

  mkdirSync(resolve(".tmp/reports"), { recursive: true });

  const statePath = resolve(args.statePath);
  const reportPath = resolve(args.reportPath);
  const ledgerPath = resolve(args.ledgerPath);
  const manifestPath = resolve(args.manifestPath);

  const state = loadState(statePath);
  const interruptedRef = { interrupted: false };

  process.once("SIGINT", () => {
    interruptedRef.interrupted = true;
    console.error(
      "Cancellation requested. Finishing current listing and saving checkpoint...",
    );
  });

  const db = new Pool({
    connectionString: databaseUrl,
    max: 4,
  });

  try {
    const selected = await selectListings(db, args);
    if (selected.length === 0) {
      throw new Error("No matching listings found for image pull.");
    }

    const queue = selected.filter((item) => {
      if (args.forceReprocess) {
        return true;
      }
      return state.runs[item.listingId]?.status !== "ok";
    });

    if (queue.length === 0) {
      const summary = {
        generatedAt: new Date().toISOString(),
        runId,
        selectedListings: 0,
        message: "No pending listings to process after checkpoint filtering.",
      };
      await writeFile(
        reportPath,
        `${JSON.stringify(summary, null, 2)}\n`,
        "utf8",
      );
      console.log(summary.message);
      return;
    }

    const auth = await authorizeB2(b2KeyId, b2ApplicationKey);
    const uploadUrlState = {
      current: await getUploadUrl(
        auth.apiUrl,
        auth.authorizationToken,
        b2BucketId,
      ),
    };
    const uploadGate = createConcurrencyGate(1);

    console.log(
      `Starting source image pull: stage=${args.stage} listings=${queue.length} listing_concurrency=${args.listingConcurrency} image_concurrency=${args.imageConcurrency} originals=${args.originalsNamespace} final=${args.finalNamespace}`,
    );

    const results: ListingRunSummary[] = [];
    let nextIndex = 0;
    let completedListings = 0;

    async function workerLoop(workerId: number): Promise<void> {
      while (!interruptedRef.interrupted) {
        const index = nextIndex;
        nextIndex += 1;

        if (index >= queue.length) {
          return;
        }

        const listing = queue[index];
        const pct = Math.round(((index + 1) / queue.length) * 100);
        console.log(
          `${colorize(`[${index + 1}/${queue.length}]`, chalk.white.bold)} ${colorize(`w${workerId}`, chalk.bgBlue.white.bold)} listing=${listing.listingId} progress=${pct}%`,
        );

        const result = await runSingleListing({
          listing,
          args,
          runId,
          b2BucketName,
          b2AuthToken: auth.authorizationToken,
          b2DownloadUrl: auth.downloadUrl,
          uploadUrlState,
          apiUrl: auth.apiUrl,
          b2BucketId,
          ledgerPath,
          manifestPath,
          interruptedRef,
          state,
          uploadGate,
        });

        results.push(result);
        completedListings += 1;

        const existingOriginal =
          state.runs[result.listingId]?.uploadedOriginalSourceUrlHashes ?? [];
        const existingFinal =
          state.runs[result.listingId]?.uploadedFinalSourceUrlHashes ?? [];

        state.runs[result.listingId] = {
          status: result.status,
          attempts: Number(state.runs[result.listingId]?.attempts ?? 0) + 1,
          lastRunAt: new Date().toISOString(),
          processedImages: result.processedImages,
          failedImages: result.failedImages,
          elapsedMs: result.elapsedMs,
          uploadedOriginalSourceUrlHashes: [
            ...new Set([
              ...existingOriginal,
              ...result.uploadedOriginalSourceUrlHashes,
            ]),
          ],
          uploadedFinalSourceUrlHashes: [
            ...new Set([
              ...existingFinal,
              ...result.uploadedFinalSourceUrlHashes,
            ]),
          ],
          error: result.error ?? null,
        };

        saveState(statePath, state);

        console.log(
          `${colorize(result.status, result.status === "ok" ? chalk.bgGreen.black.bold : chalk.bgRed.white.bold)} listing=${result.listingId} images=${result.totalImages} uploaded=${result.processedImages} skipped=${result.skippedImages} failed=${result.failedImages} elapsed=${formatMs(result.elapsedMs)}`,
        );
        const completedPct = Math.round(
          (completedListings / queue.length) * 100,
        );
        const remaining = Math.max(0, queue.length - completedListings);
        console.log(
          `listing_progress completed=${completedListings}/${queue.length} (${completedPct}%) remaining=${remaining}`,
        );
      }
    }

    const workerCount = Math.max(
      1,
      Math.min(args.listingConcurrency, queue.length),
    );
    await Promise.all(
      Array.from({ length: workerCount }, (_, idx) => workerLoop(idx + 1)),
    );

    const totals = results.reduce(
      (acc, item) => {
        acc.imagesTotal += item.totalImages;
        acc.imagesUploaded += item.processedImages;
        acc.imagesSkipped += item.skippedImages;
        acc.imagesFailed += item.failedImages;
        if (item.status === "ok") {
          acc.listingsOk += 1;
        } else {
          acc.listingsFailed += 1;
        }
        return acc;
      },
      {
        imagesTotal: 0,
        imagesUploaded: 0,
        imagesSkipped: 0,
        imagesFailed: 0,
        listingsOk: 0,
        listingsFailed: 0,
      },
    );

    const summary = {
      generatedAt: new Date().toISOString(),
      runId,
      pipeline: "source-image-pull",
      policy: {
        stage1: "listing-originals/{source_type}/{source_id}/{source_filename}",
        stage2: "images/{id2}/{id4}/{listing_id}/{content_hash}.{ext}",
      },
      args,
      totals,
      interrupted: interruptedRef.interrupted,
      elapsedMs: Date.now() - startedAt,
      elapsedHuman: formatMs(Date.now() - startedAt),
      output: {
        statePath,
        reportPath,
        ledgerPath,
        manifestPath,
      },
      reconciliation: reconcileRunAgainstLedger({
        ledgerPath,
        runId,
        args,
        totals: {
          imagesUploaded: totals.imagesUploaded,
          imagesSkipped: totals.imagesSkipped,
          imagesFailed: totals.imagesFailed,
        },
      }),
      results,
    };

    await writeFile(
      reportPath,
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );

    console.log(
      `Pull complete: listings_ok=${totals.listingsOk} listings_failed=${totals.listingsFailed} images_total=${totals.imagesTotal} images_uploaded=${totals.imagesUploaded} images_skipped=${totals.imagesSkipped} images_failed=${totals.imagesFailed} elapsed=${summary.elapsedHuman}`,
    );
    console.log(
      `Reconcile: uploaded=${summary.reconciliation.ledgerUploadedRecords}/${summary.reconciliation.expectedUploadedRecords} failed=${summary.reconciliation.ledgerFailedRecords}/${summary.reconciliation.expectedFailedRecords} skipped=${summary.reconciliation.ledgerSkippedRecords}/${summary.reconciliation.expectedSkippedRecords} originals=${summary.reconciliation.ledgerUploadedOriginalCount}/${summary.reconciliation.expectedUploadedOriginalCount} finals=${summary.reconciliation.ledgerUploadedFinalCount}/${summary.reconciliation.expectedUploadedFinalCount} all_match=${summary.reconciliation.matches.all}`,
    );

    if (interruptedRef.interrupted) {
      process.exit(CTRL_C_EXIT_CODE);
    }

    if (totals.listingsFailed > 0 || totals.imagesFailed > 0) {
      process.exit(FAILURE_EXIT_CODE);
    }
  } finally {
    await db.end();
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Source image pull failed: ${message}`);
  process.exit(FAILURE_EXIT_CODE);
});
