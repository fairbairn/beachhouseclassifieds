import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createConsola } from "consola";
import { createHash } from "node:crypto";
import sharp from "sharp";

type ImageProcessingItem = {
  workId: string;
  sourceType?: "url" | "s3";
  sourceImageUrl?: string;
  sourceS3Key?: string;
  sourceS3Bucket?: string;
};

type ImageProcessingTaskPayload = {
  items: ImageProcessingItem[];
  operationId?: string;
  batchId?: string;
  batchIndex?: number;
  batchCount?: number;
  workerConcurrency?: number;
  fetchTimeoutMs?: number;
  fetchRetryCount?: number;
  sleepSecondsPerItem?: number;
  dryRun?: boolean;
  uploadPrefix?: string;
  verboseLogs?: boolean;
};

type ImageProcessingItemResult = {
  work_id: string;
  source_image_url: string;
  source_fetch_mode: "url" | "s3";
  source_host: string;
  source_http_status: number;
  source_bytes: number;
  source_width: number;
  source_height: number;
  transformed_bytes: number;
  transformed_width: number;
  transformed_height: number;
  target_width: number;
  target_height: number;
  below_target_hd: boolean;
  calculated_hash: string;
  transformed_hash: string;
  final_name: string;
  stored_status_on_s3: "dry_run" | "uploaded";
  upload_skipped_existing: boolean;
  fetch_elapsed_ms: number;
  transform_elapsed_ms: number;
  upload_elapsed_ms: number;
};

type ImageProcessingTaskError = {
  work_id: string;
  source_image_url: string | null;
  code: string;
  message: string;
};

type ImageProcessingTaskResult = {
  operation_id: string;
  batch_id: string;
  batch_index: number;
  batch_count: number;
  item_count: number;
  processed_count: number;
  failed_count: number;
  worker_concurrency: number;
  sleep_seconds_per_item: number;
  dry_run: boolean;
  upload_prefix: string;
  items: ImageProcessingItemResult[];
  errors: ImageProcessingTaskError[];
  started_at: string;
  completed_at: string;
  elapsed_ms: number;
};

type ProcessingContext = {
  workerId: number;
  itemIndex: number;
  totalCount: number;
};

type ProgressEvent = "started" | "completed";

type ImageProcessingProgress = {
  operation_id: string;
  batch_id: string;
  batch_index: number;
  batch_count: number;
  current: number;
  total: number;
  percentage: number;
  queued: number;
  active: number;
  succeeded: number;
  failed: number;
  event: ProgressEvent;
  last_work_id: string | null;
  last_source_host: string | null;
  last_error_code: string | null;
  updated_at: string;
};

type ImageProcessingHooks = {
  onProgress?: (progress: ImageProcessingProgress) => void;
};

type SourceDescriptor = {
  mode: "url" | "s3";
  sourceImageUrl: string;
  sourceHost: string;
  sourceS3Key: string | null;
  sourceS3Bucket: string | null;
};

type BunnyConfig = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  forcePathStyle: boolean;
};

const BUNNY_CONFIG_NON_SECRET = {
  endpoint: "https://ny-s3.storage.bunnycdn.com",
  bucket: "beach",
  accessKeyId: "beach",
  region: "ny",
  forcePathStyle: true,
} as const;

const DEFAULT_UPLOAD_PREFIX = "v1";
const FINAL_IMAGE_MAX_WIDTH = 1920;
const FINAL_IMAGE_MAX_HEIGHT = 1080;

const FINAL_TRANSFORM_PROFILE = {
  name: "truthful-v3-1920x1080",
  maxWidth: FINAL_IMAGE_MAX_WIDTH,
  maxHeight: FINAL_IMAGE_MAX_HEIGHT,
  brightness: 1.02,
  saturation: 1.03,
  gamma: 1.02,
  sharpen: {
    sigma: 0.6,
    m1: 0.8,
    m2: 2,
    x1: 2,
    y2: 10,
    y3: 20,
  },
  jpeg: {
    quality: 95,
    chromaSubsampling: "4:4:4",
    mozjpeg: true,
    progressive: true,
  },
} as const;

const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_FETCH_RETRY_COUNT = 2;

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolveProxyUrlFromEnv(): string | null {
  const httpsProxy =
    process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim();
  const httpProxy =
    process.env.HTTP_PROXY?.trim() || process.env.http_proxy?.trim();
  return httpsProxy || httpProxy || null;
}

function formatNetworkError(error: unknown): string {
  const err = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: { code?: unknown; message?: unknown };
  };

  const name = typeof err?.name === "string" ? err.name : "Error";
  const code = typeof err?.code === "string" ? err.code : "";
  const message =
    typeof err?.message === "string" ? err.message : String(error);
  const causeCode = typeof err?.cause?.code === "string" ? err.cause.code : "";
  const causeMessage =
    typeof err?.cause?.message === "string" ? err.cause.message : "";

  return [name, code, message, causeCode, causeMessage]
    .filter(Boolean)
    .join(" ");
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Math.floor(ms)));
  });
}

async function createProxyDispatcher(proxyUrl: string): Promise<{
  close?: () => Promise<void>;
}> {
  const loaderErrors: string[] = [];

  try {
    const undiciModule = (await import("undici")) as {
      ProxyAgent?: new (url: string) => { close?: () => Promise<void> };
      default?: {
        ProxyAgent?: new (url: string) => { close?: () => Promise<void> };
      };
    };
    const ProxyAgent =
      undiciModule.ProxyAgent ?? undiciModule.default?.ProxyAgent;
    if (typeof ProxyAgent === "function") {
      return new ProxyAgent(proxyUrl);
    }
    loaderErrors.push("undici.ProxyAgent missing");
  } catch (error) {
    loaderErrors.push(formatNetworkError(error));
  }

  throw new Error(`proxy_agent_unavailable ${loaderErrors.join(" | ")}`);
}

async function fetchImageBytesViaProxyOnly(params: {
  sourceUrl: string;
  timeoutMs: number;
  proxyUrl: string;
  retryCount: number;
}): Promise<{
  bytes: Buffer;
  status: number;
  fetchMode: "proxy";
}> {
  if (!params.proxyUrl || !params.proxyUrl.trim()) {
    throw new Error(
      "source fetch failed network mode=proxy kind=network error=proxy_url_missing",
    );
  }

  const parsedUrl = new URL(params.sourceUrl);
  const origin = `${parsedUrl.protocol}//${parsedUrl.host}`;
  const retryCount = Math.max(0, Math.min(5, Math.floor(params.retryCount)));
  const maxAttempts = retryCount + 1;
  let lastErrorMessage = "unknown";
  let lastErrorKind: "timeout" | "network" = "network";
  const proxyAgent = await createProxyDispatcher(params.proxyUrl);

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const requestInit: RequestInit & { dispatcher?: unknown } = {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(params.timeoutMs),
          headers: {
            accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
            "cache-control": "no-cache",
            pragma: "no-cache",
            origin,
            referer: `${origin}/`,
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
          },
          dispatcher: proxyAgent,
        };

        const response = await fetch(params.sourceUrl, requestInit);
        if (!response.ok) {
          const status = response.status;
          const retryableStatus =
            status === 408 || status === 425 || status === 429 || status >= 500;
          if (retryableStatus && attempt < maxAttempts) {
            await sleepMs(Math.min(2000, Math.floor(250 * attempt)));
            continue;
          }
          throw new Error(`source fetch failed status=${status}`);
        }

        return {
          bytes: Buffer.from(await response.arrayBuffer()),
          status: response.status,
          fetchMode: "proxy",
        };
      } catch (error) {
        const detail = formatNetworkError(error);
        lastErrorMessage = detail;
        const timeoutLike =
          /AbortError|UND_ERR_ABORTED|timed out|timeout/i.test(detail);
        const retryableNetwork =
          /UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up/i.test(
            detail,
          ) || timeoutLike;
        lastErrorKind = timeoutLike ? "timeout" : "network";
        if (retryableNetwork && attempt < maxAttempts) {
          await sleepMs(Math.min(2000, Math.floor(350 * attempt)));
          continue;
        }
        break;
      }
    }
  } finally {
    if (typeof proxyAgent?.close === "function") {
      await proxyAgent.close().catch(() => undefined);
    }
  }

  throw new Error(
    `source fetch failed network mode=proxy kind=${lastErrorKind} timeout_ms=${params.timeoutMs} attempts=${maxAttempts} error=${lastErrorMessage}`,
  );
}

function deriveConstrained16x9Size(input: {
  sourceWidth: number;
  sourceHeight: number;
  maxWidth: number;
  maxHeight: number;
}): { width: number; height: number } {
  const sourceWidth = Math.max(1, Math.floor(input.sourceWidth));
  const sourceHeight = Math.max(1, Math.floor(input.sourceHeight));
  const maxWidth = Math.max(1, Math.floor(input.maxWidth));
  const maxHeight = Math.max(1, Math.floor(input.maxHeight));

  const cappedWidth = Math.min(sourceWidth, maxWidth);
  const cappedHeight = Math.min(sourceHeight, maxHeight);

  const widthFromHeight = Math.min(
    cappedWidth,
    Math.floor((cappedHeight * 16) / 9),
  );
  const heightFromWidth = Math.floor((widthFromHeight * 9) / 16);

  const altHeight = Math.min(cappedHeight, Math.floor((cappedWidth * 9) / 16));
  const altWidth = Math.floor((altHeight * 16) / 9);

  const primaryArea = widthFromHeight * heightFromWidth;
  const altArea = altWidth * altHeight;

  const width = Math.max(1, altArea > primaryArea ? altWidth : widthFromHeight);
  const height = Math.max(
    1,
    altArea > primaryArea ? altHeight : heightFromWidth,
  );

  return { width, height };
}

function normalizeUploadPrefix(value: string | undefined): string {
  const raw = (value ?? DEFAULT_UPLOAD_PREFIX).trim();
  const normalized = raw.replace(/^\/+|\/+$/g, "");
  return normalized.length > 0 ? normalized : DEFAULT_UPLOAD_PREFIX;
}

function buildFinalName(uploadPrefix: string, hash: string): string {
  const shard2 = hash.slice(0, 2);
  const shard4 = hash.slice(0, 4);
  return `${uploadPrefix}/${shard2}/${shard4}/${hash}.jpg`;
}

async function postProcessForFinalImage(bytes: Buffer): Promise<{
  bytes: Buffer;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
}> {
  const image = sharp(bytes, { failOn: "none" }).rotate();
  const sourceMetadata = await image.metadata();
  const sourceWidth = Math.max(1, Number(sourceMetadata.width || 0));
  const sourceHeight = Math.max(1, Number(sourceMetadata.height || 0));

  const targetSize = deriveConstrained16x9Size({
    sourceWidth,
    sourceHeight,
    maxWidth: FINAL_TRANSFORM_PROFILE.maxWidth,
    maxHeight: FINAL_TRANSFORM_PROFILE.maxHeight,
  });

  const processed = await image
    .resize({
      width: targetSize.width,
      height: targetSize.height,
      fit: "cover",
      position: "attention",
      withoutEnlargement: true,
      kernel: "lanczos3",
    })
    .normalize()
    .modulate({
      brightness: FINAL_TRANSFORM_PROFILE.brightness,
      saturation: FINAL_TRANSFORM_PROFILE.saturation,
    })
    .gamma(FINAL_TRANSFORM_PROFILE.gamma)
    .sharpen(FINAL_TRANSFORM_PROFILE.sharpen)
    .jpeg(FINAL_TRANSFORM_PROFILE.jpeg)
    .toBuffer();

  return {
    bytes: processed,
    sourceWidth,
    sourceHeight,
    targetWidth: targetSize.width,
    targetHeight: targetSize.height,
  };
}

function classifyError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (/kind=timeout/.test(message)) {
    return { code: "source_timeout", message };
  }
  if (/kind=network/.test(message)) {
    return { code: "source_network", message };
  }
  if (/status=403/.test(message)) {
    return { code: "source_403", message };
  }
  if (/status=404/.test(message)) {
    return { code: "source_404", message };
  }
  if (/status=429/.test(message)) {
    return { code: "source_429", message };
  }
  if (/status=5\d\d/.test(message)) {
    return { code: "source_5xx", message };
  }
  if (/timed out|timeout/i.test(message)) {
    return { code: "source_timeout", message };
  }
  if (/Missing BUNNY_STORAGE_SECRET_ACCESS_KEY/.test(message)) {
    return { code: "missing_storage_secret", message };
  }
  if (/upload failed/.test(message)) {
    return { code: "upload_failed", message };
  }
  return { code: "worker_error", message };
}

function resolveBunnyConfig(): BunnyConfig {
  const secretAccessKey =
    process.env.BUNNY_STORAGE_SECRET_ACCESS_KEY?.trim() ?? "";
  if (!secretAccessKey) {
    throw new Error("Missing BUNNY_STORAGE_SECRET_ACCESS_KEY in environment.");
  }

  return {
    endpoint: BUNNY_CONFIG_NON_SECRET.endpoint,
    bucket: BUNNY_CONFIG_NON_SECRET.bucket,
    accessKeyId: BUNNY_CONFIG_NON_SECRET.accessKeyId,
    secretAccessKey,
    region: BUNNY_CONFIG_NON_SECRET.region,
    forcePathStyle: BUNNY_CONFIG_NON_SECRET.forcePathStyle,
  };
}

function createBunnyClient(config: BunnyConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function isNotFoundS3Error(error: unknown): boolean {
  const err = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };

  const name = typeof err?.name === "string" ? err.name : "";
  const statusCode = Number(err?.$metadata?.httpStatusCode ?? 0);

  return name === "NotFound" || statusCode === 404;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function resolveSourceDescriptor(item: ImageProcessingItem): SourceDescriptor {
  const sourceType = item.sourceType === "s3" ? "s3" : "url";
  if (sourceType === "s3") {
    const sourceS3Key = item.sourceS3Key?.trim() ?? "";
    if (!sourceS3Key) {
      throw new Error("sourceS3Key is required when sourceType is s3");
    }
    const sourceS3Bucket =
      item.sourceS3Bucket?.trim() || BUNNY_CONFIG_NON_SECRET.bucket;
    return {
      mode: "s3",
      sourceImageUrl: `s3://${sourceS3Bucket}/${sourceS3Key}`,
      sourceHost: "bunny-s3",
      sourceS3Key,
      sourceS3Bucket,
    };
  }

  const sourceImageUrl = item.sourceImageUrl?.trim() ?? "";
  if (!sourceImageUrl) {
    throw new Error("sourceImageUrl is required when sourceType is url");
  }

  return {
    mode: "url",
    sourceImageUrl,
    sourceHost: new URL(sourceImageUrl).host,
    sourceS3Key: null,
    sourceS3Bucket: null,
  };
}

function shuffleArray<T>(values: T[]): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = out[i];
    out[i] = out[j];
    out[j] = temp;
  }
  return out;
}

function resolveItemHostForScheduling(item: ImageProcessingItem): string {
  if (item.sourceType === "s3") {
    return "bunny-s3";
  }

  const sourceImageUrl = item.sourceImageUrl?.trim() ?? "";
  if (!sourceImageUrl) {
    return "unknown-host";
  }

  try {
    return new URL(sourceImageUrl).host || "unknown-host";
  } catch {
    return "unknown-host";
  }
}

function orderItemsForWorkerHostSpread(
  items: ImageProcessingItem[],
  workerConcurrency: number,
): { orderedItems: ImageProcessingItem[]; distinctHosts: number } {
  const hostBuckets = new Map<string, ImageProcessingItem[]>();

  for (const item of items) {
    const host = resolveItemHostForScheduling(item);
    if (!hostBuckets.has(host)) {
      hostBuckets.set(host, []);
    }
    hostBuckets.get(host)?.push(item);
  }

  for (const [host, bucket] of hostBuckets.entries()) {
    hostBuckets.set(host, shuffleArray(bucket));
  }

  const orderedItems: ImageProcessingItem[] = [];
  const hostKeys = [...hostBuckets.keys()];

  while (orderedItems.length < items.length) {
    const availableHosts = shuffleArray(
      hostKeys.filter((host) => (hostBuckets.get(host)?.length || 0) > 0),
    ).sort((left, right) => {
      const leftCount = hostBuckets.get(left)?.length || 0;
      const rightCount = hostBuckets.get(right)?.length || 0;
      return rightCount - leftCount;
    });

    if (availableHosts.length === 0) {
      break;
    }

    const roundLimit = Math.max(1, workerConcurrency);
    const roundUsedHosts = new Set<string>();
    for (let slot = 0; slot < roundLimit; slot += 1) {
      const pickedHost =
        availableHosts.find((host) => !roundUsedHosts.has(host)) ||
        availableHosts[0];
      if (!pickedHost) {
        break;
      }

      const bucket = hostBuckets.get(pickedHost);
      if (!bucket || bucket.length === 0) {
        continue;
      }

      const item = bucket.shift();
      if (item) {
        orderedItems.push(item);
      }
      roundUsedHosts.add(pickedHost);

      if (orderedItems.length >= items.length) {
        break;
      }
    }
  }

  return {
    orderedItems,
    distinctHosts: hostBuckets.size,
  };
}

function createInfoLogger(
  enabled: boolean,
): (message: string, data?: Record<string, unknown>) => void {
  const liveLogger = createConsola({
    formatOptions: {
      colors: true,
      date: true,
    },
  }).withTag("image-processing-task");

  return (message: string, data?: Record<string, unknown>) => {
    if (!enabled) {
      return;
    }

    const suffix = data ? ` ${JSON.stringify(data)}` : "";
    const line = `${message}${suffix}`;

    liveLogger.info(line);

    // Force immediate terminal streaming for local dev sessions.
    process.stdout.write(`[image-processing-task] ${line}\n`);
  };
}

export async function processImageProcessingBatch(
  payload: ImageProcessingTaskPayload,
  hooks: ImageProcessingHooks = {},
): Promise<ImageProcessingTaskResult> {
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const operationId =
    typeof payload.operationId === "string" && payload.operationId.trim()
      ? payload.operationId.trim()
      : "op-unknown";
  const batchId =
    typeof payload.batchId === "string" && payload.batchId.trim()
      ? payload.batchId.trim()
      : "batch-unknown";
  const batchIndex = Number.isFinite(payload.batchIndex)
    ? Math.max(0, Math.floor(payload.batchIndex as number))
    : 0;
  const batchCount = Number.isFinite(payload.batchCount)
    ? Math.max(1, Math.floor(payload.batchCount as number))
    : 1;

  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) {
    throw new Error("payload.items must contain at least one item");
  }

  const requestedConcurrency = Number.isFinite(payload.workerConcurrency)
    ? Math.floor(payload.workerConcurrency as number)
    : 5;
  const workerConcurrency = Math.max(1, Math.min(20, requestedConcurrency));

  const requestedSleep = Number.isFinite(payload.sleepSecondsPerItem)
    ? Math.floor(payload.sleepSecondsPerItem as number)
    : 0;
  const sleepSecondsPerItem = Math.max(0, Math.min(30, requestedSleep));

  const scheduled = orderItemsForWorkerHostSpread(items, workerConcurrency);
  const scheduledItems = scheduled.orderedItems;
  const totalItemCount = scheduledItems.length;

  const dryRun = payload.dryRun !== false;
  const uploadPrefix = normalizeUploadPrefix(payload.uploadPrefix);
  const verboseLogs = payload.verboseLogs === true;
  const infoLog = createInfoLogger(verboseLogs);
  const payloadFetchTimeout = Number.isFinite(payload.fetchTimeoutMs)
    ? Math.floor(payload.fetchTimeoutMs as number)
    : 0;
  const fetchTimeoutMs =
    payloadFetchTimeout > 0
      ? payloadFetchTimeout
      : parsePositiveIntEnv("IMAGE_FETCH_TIMEOUT_MS", DEFAULT_FETCH_TIMEOUT_MS);
  const payloadFetchRetryCount = Number.isFinite(payload.fetchRetryCount)
    ? Math.floor(payload.fetchRetryCount as number)
    : Number.NaN;
  const fetchRetryCount = Number.isFinite(payloadFetchRetryCount)
    ? Math.max(0, Math.min(5, payloadFetchRetryCount))
    : Math.max(
        0,
        Math.min(
          5,
          parsePositiveIntEnv(
            "IMAGE_FETCH_RETRY_COUNT",
            DEFAULT_FETCH_RETRY_COUNT,
          ),
        ),
      );
  const proxyUrl = resolveProxyUrlFromEnv();

  const hasUrlSourceItems = scheduledItems.some(
    (item) => (item.sourceType || "url") === "url",
  );
  if (hasUrlSourceItems && !proxyUrl) {
    throw new Error(
      "Missing HTTPS_PROXY/HTTP_PROXY: proxy is required for URL source image fetches",
    );
  }

  const bunnyConfig = dryRun ? null : resolveBunnyConfig();
  const bunnyClient = bunnyConfig ? createBunnyClient(bunnyConfig) : null;

  infoLog("image-processing-task started", {
    operation_id: operationId,
    batch_id: batchId,
    batch_index: batchIndex,
    batch_count: batchCount,
    item_count: totalItemCount,
    worker_concurrency: workerConcurrency,
    scheduling_distinct_hosts: scheduled.distinctHosts,
    sleep_seconds_per_item: sleepSecondsPerItem,
    dry_run: dryRun,
    upload_prefix: uploadPrefix,
  });

  infoLog("image-processing-task runtime config", {
    dry_run: dryRun,
    bunny_endpoint: BUNNY_CONFIG_NON_SECRET.endpoint,
    bunny_bucket: BUNNY_CONFIG_NON_SECRET.bucket,
    bunny_region: BUNNY_CONFIG_NON_SECRET.region,
    force_path_style: BUNNY_CONFIG_NON_SECRET.forcePathStyle,
    fetch_timeout_ms: fetchTimeoutMs,
    fetch_timeout_source: payloadFetchTimeout > 0 ? "payload" : "env",
    fetch_retry_count: fetchRetryCount,
    fetch_retry_source: Number.isFinite(payloadFetchRetryCount)
      ? "payload"
      : "env",
    fetch_proxy_configured: Boolean(proxyUrl),
    fetch_proxy_mode: "required",
  });

  const results: ImageProcessingItemResult[] = [];
  const errors: ImageProcessingTaskError[] = [];

  let cursor = 0;
  let startedCount = 0;
  let completedCount = 0;
  let successCount = 0;
  let failedCount = 0;
  const progressEvery = Math.max(
    1,
    Math.min(10, Math.floor(totalItemCount / 10) || 1),
  );

  function publishProgress(
    event: ProgressEvent,
    extras?: {
      workId?: string | null;
      sourceHost?: string | null;
      errorCode?: string | null;
    },
  ): void {
    const queuedCount = Math.max(0, totalItemCount - startedCount);
    const activeCount = Math.max(0, startedCount - completedCount);
    const percentage =
      totalItemCount > 0
        ? Math.round((completedCount / totalItemCount) * 100)
        : 0;

    const progress: ImageProcessingProgress = {
      operation_id: operationId,
      batch_id: batchId,
      batch_index: batchIndex,
      batch_count: batchCount,
      current: completedCount,
      total: totalItemCount,
      percentage,
      queued: queuedCount,
      active: activeCount,
      succeeded: successCount,
      failed: failedCount,
      event,
      last_work_id: extras?.workId ?? null,
      last_source_host: extras?.sourceHost ?? null,
      last_error_code: extras?.errorCode ?? null,
      updated_at: new Date().toISOString(),
    };

    hooks.onProgress?.(progress);
  }

  publishProgress("started");

  async function processOne(
    item: ImageProcessingItem,
    context: ProcessingContext,
  ): Promise<void> {
    const workId = item.workId?.trim();
    const sourceImageUrl = item.sourceImageUrl?.trim();
    const itemStartedAtMs = Date.now();

    let sourceDescriptor: SourceDescriptor;
    try {
      sourceDescriptor = resolveSourceDescriptor(item);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({
        work_id: workId || "missing_work_id",
        source_image_url: sourceImageUrl || null,
        code: "invalid_payload",
        message,
      });
      failedCount += 1;
      completedCount += 1;
      publishProgress("completed", {
        workId: workId || null,
        sourceHost: null,
        errorCode: "invalid_payload",
      });
      infoLog("item rejected invalid source descriptor", {
        worker_id: context.workerId,
        item_index: context.itemIndex + 1,
        total_count: context.totalCount,
        work_id: workId || null,
        source_image_url: sourceImageUrl || null,
        error: message,
      });
      return;
    }

    if (!workId) {
      errors.push({
        work_id: workId || "missing_work_id",
        source_image_url: sourceDescriptor.sourceImageUrl,
        code: "invalid_payload",
        message: "workId is required",
      });
      failedCount += 1;
      completedCount += 1;
      publishProgress("completed", {
        workId: workId || null,
        sourceHost: sourceDescriptor.sourceHost,
        errorCode: "invalid_payload",
      });
      infoLog("item rejected invalid payload", {
        worker_id: context.workerId,
        item_index: context.itemIndex + 1,
        total_count: context.totalCount,
        work_id: workId || null,
        source_image_url: sourceDescriptor.sourceImageUrl,
      });
      return;
    }

    infoLog("item processing started", {
      worker_id: context.workerId,
      item_index: context.itemIndex + 1,
      total_count: context.totalCount,
      work_id: workId,
      source_image_url: sourceDescriptor.sourceImageUrl,
      source_fetch_mode: sourceDescriptor.mode,
    });

    startedCount += 1;
    publishProgress("started", {
      workId,
      sourceHost: sourceDescriptor.sourceHost,
      errorCode: null,
    });

    try {
      if (sleepSecondsPerItem > 0) {
        await sleepMs(sleepSecondsPerItem * 1000);
      }

      const sourceHost = sourceDescriptor.sourceHost;
      infoLog("item fetch starting", {
        worker_id: context.workerId,
        item_index: context.itemIndex + 1,
        work_id: workId,
        source_image_url: sourceDescriptor.sourceImageUrl,
        source_fetch_mode: sourceDescriptor.mode,
      });
      const fetchStartedAtMs = Date.now();
      let sourceStatus = 200;
      let sourceBytes: Buffer;
      let sourceFetchPath: "s3" | "proxy" =
        sourceDescriptor.mode === "s3" ? "s3" : "proxy";
      if (sourceDescriptor.mode === "s3") {
        if (!bunnyClient) {
          throw new Error(
            "S3 source fetch requires Bunny S3 client configuration",
          );
        }
        const bucket =
          sourceDescriptor.sourceS3Bucket || BUNNY_CONFIG_NON_SECRET.bucket;
        const key = sourceDescriptor.sourceS3Key || "";
        const object = await bunnyClient.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );
        if (!object.Body) {
          throw new Error("source fetch failed status=500 empty s3 body");
        }
        sourceBytes = await streamToBuffer(
          object.Body as NodeJS.ReadableStream,
        );
        sourceStatus = 200;
      } else {
        const fetched = await fetchImageBytesViaProxyOnly({
          sourceUrl: sourceDescriptor.sourceImageUrl,
          timeoutMs: fetchTimeoutMs,
          proxyUrl: proxyUrl || "",
          retryCount: fetchRetryCount,
        });
        sourceStatus = fetched.status;
        sourceBytes = fetched.bytes;
        sourceFetchPath = fetched.fetchMode;
      }
      const fetchElapsedMs = Date.now() - fetchStartedAtMs;

      infoLog("item fetch completed", {
        worker_id: context.workerId,
        item_index: context.itemIndex + 1,
        work_id: workId,
        source_http_status: sourceStatus,
        source_fetch_path: sourceFetchPath,
        fetch_elapsed_ms: fetchElapsedMs,
      });

      const sourceReadElapsedMs = 0;

      infoLog("item source bytes loaded", {
        worker_id: context.workerId,
        item_index: context.itemIndex + 1,
        work_id: workId,
        source_bytes: sourceBytes.byteLength,
        source_read_elapsed_ms: sourceReadElapsedMs,
      });

      const transformStartedAtMs = Date.now();
      const transformed = await postProcessForFinalImage(sourceBytes);
      const transformedBytes = transformed.bytes;
      const transformElapsedMs = Date.now() - transformStartedAtMs;

      const sourceContentHash = createHash("sha256")
        .update(sourceBytes)
        .digest("hex");
      const transformedContentHash = createHash("sha256")
        .update(transformedBytes)
        .digest("hex");

      infoLog("item transform completed", {
        worker_id: context.workerId,
        item_index: context.itemIndex + 1,
        work_id: workId,
        transformed_bytes: transformedBytes.byteLength,
        transform_profile: FINAL_TRANSFORM_PROFILE.name,
        transform_max_width: FINAL_TRANSFORM_PROFILE.maxWidth,
        transform_max_height: FINAL_TRANSFORM_PROFILE.maxHeight,
        transform_output_width: transformed.targetWidth,
        transform_output_height: transformed.targetHeight,
        transform_elapsed_ms: transformElapsedMs,
      });

      const calculatedHash = sourceContentHash;
      const finalName = buildFinalName(uploadPrefix, calculatedHash);

      let storedStatus: "dry_run" | "uploaded" = "dry_run";
      let uploadSkippedExisting = false;
      let uploadElapsedMs = 0;
      if (!dryRun && bunnyClient && bunnyConfig) {
        const uploadStartedAtMs = Date.now();
        infoLog("item upload starting", {
          worker_id: context.workerId,
          item_index: context.itemIndex + 1,
          work_id: workId,
          final_name: finalName,
        });
        try {
          await bunnyClient.send(
            new HeadObjectCommand({
              Bucket: bunnyConfig.bucket,
              Key: finalName,
            }),
          );
          uploadSkippedExisting = true;
          storedStatus = "uploaded";
          uploadElapsedMs = Date.now() - uploadStartedAtMs;
          infoLog("item upload skipped existing object", {
            worker_id: context.workerId,
            item_index: context.itemIndex + 1,
            work_id: workId,
            final_name: finalName,
            upload_elapsed_ms: uploadElapsedMs,
          });
        } catch (error: unknown) {
          if (!isNotFoundS3Error(error)) {
            const message =
              error instanceof Error ? error.message : String(error);
            throw new Error(`upload failed: ${message}`);
          }

          try {
            await bunnyClient.send(
              new PutObjectCommand({
                Bucket: bunnyConfig.bucket,
                Key: finalName,
                Body: transformedBytes,
                ContentType: "image/jpeg",
              }),
            );
            storedStatus = "uploaded";
            uploadElapsedMs = Date.now() - uploadStartedAtMs;
            infoLog("item upload completed", {
              worker_id: context.workerId,
              item_index: context.itemIndex + 1,
              work_id: workId,
              final_name: finalName,
              upload_elapsed_ms: uploadElapsedMs,
            });
          } catch (putError: unknown) {
            const message =
              putError instanceof Error ? putError.message : String(putError);
            throw new Error(`upload failed: ${message}`);
          }
        }
      }

      results.push({
        work_id: workId,
        source_image_url: sourceDescriptor.sourceImageUrl,
        source_fetch_mode: sourceDescriptor.mode,
        source_host: sourceHost,
        source_http_status: sourceStatus,
        source_bytes: sourceBytes.byteLength,
        source_width: transformed.sourceWidth,
        source_height: transformed.sourceHeight,
        transformed_bytes: transformedBytes.byteLength,
        transformed_width: transformed.targetWidth,
        transformed_height: transformed.targetHeight,
        target_width: FINAL_TRANSFORM_PROFILE.maxWidth,
        target_height: FINAL_TRANSFORM_PROFILE.maxHeight,
        below_target_hd:
          transformed.targetWidth < FINAL_TRANSFORM_PROFILE.maxWidth ||
          transformed.targetHeight < FINAL_TRANSFORM_PROFILE.maxHeight,
        calculated_hash: calculatedHash,
        transformed_hash: transformedContentHash,
        final_name: finalName,
        stored_status_on_s3: storedStatus,
        upload_skipped_existing: uploadSkippedExisting,
        fetch_elapsed_ms: fetchElapsedMs,
        transform_elapsed_ms: transformElapsedMs,
        upload_elapsed_ms: uploadElapsedMs,
      });

      successCount += 1;
      infoLog("item processing completed", {
        worker_id: context.workerId,
        item_index: context.itemIndex + 1,
        total_count: context.totalCount,
        work_id: workId,
        source_fetch_mode: sourceDescriptor.mode,
        source_host: sourceHost,
        source_http_status: sourceStatus,
        source_bytes: sourceBytes.byteLength,
        transformed_bytes: transformedBytes.byteLength,
        source_width: transformed.sourceWidth,
        source_height: transformed.sourceHeight,
        transformed_width: transformed.targetWidth,
        transformed_height: transformed.targetHeight,
        target_width: FINAL_TRANSFORM_PROFILE.maxWidth,
        target_height: FINAL_TRANSFORM_PROFILE.maxHeight,
        below_target_hd:
          transformed.targetWidth < FINAL_TRANSFORM_PROFILE.maxWidth ||
          transformed.targetHeight < FINAL_TRANSFORM_PROFILE.maxHeight,
        source_content_hash: sourceContentHash,
        transformed_content_hash: transformedContentHash,
        stored_status_on_s3: storedStatus,
        item_elapsed_ms: Date.now() - itemStartedAtMs,
      });
    } catch (error: unknown) {
      const classified = classifyError(error);
      errors.push({
        work_id: workId,
        source_image_url: sourceDescriptor.sourceImageUrl,
        code: classified.code,
        message: classified.message,
      });

      failedCount += 1;
      infoLog("item processing failed", {
        worker_id: context.workerId,
        item_index: context.itemIndex + 1,
        total_count: context.totalCount,
        work_id: workId,
        source_image_url: sourceDescriptor.sourceImageUrl,
        code: classified.code,
        error: classified.message,
        item_elapsed_ms: Date.now() - itemStartedAtMs,
      });
    } finally {
      completedCount += 1;
      publishProgress("completed", {
        workId: workId || null,
        sourceHost: sourceDescriptor.sourceHost,
        errorCode:
          errors.length > 0 && errors[errors.length - 1]?.work_id === workId
            ? errors[errors.length - 1]?.code || null
            : null,
      });
      if (
        completedCount % progressEvery === 0 ||
        completedCount === totalItemCount
      ) {
        infoLog("batch progress", {
          completed_count: completedCount,
          total_count: totalItemCount,
          success_count: successCount,
          failed_count: failedCount,
        });
      }
    }
  }

  async function workerLoop(workerId: number): Promise<void> {
    infoLog("worker loop started", {
      worker_id: workerId,
    });
    while (cursor < totalItemCount) {
      const index = cursor;
      cursor += 1;
      const item = scheduledItems[index];
      await processOne(item, {
        workerId,
        itemIndex: index,
        totalCount: totalItemCount,
      });
    }
    infoLog("worker loop completed", {
      worker_id: workerId,
    });
  }

  const workers = Array.from(
    { length: Math.min(workerConcurrency, totalItemCount) },
    (_, index) => workerLoop(index + 1),
  );
  await Promise.all(workers);

  const completedAt = new Date().toISOString();
  const elapsedMs = Date.now() - startedAtDate.getTime();

  infoLog("image-processing-task completed", {
    item_count: totalItemCount,
    processed_count: results.length,
    failed_count: errors.length,
    dry_run: dryRun,
    elapsed_ms: elapsedMs,
  });

  return {
    operation_id: operationId,
    batch_id: batchId,
    batch_index: batchIndex,
    batch_count: batchCount,
    item_count: totalItemCount,
    processed_count: results.length,
    failed_count: errors.length,
    worker_concurrency: workerConcurrency,
    sleep_seconds_per_item: sleepSecondsPerItem,
    dry_run: dryRun,
    upload_prefix: uploadPrefix,
    items: results,
    errors,
    started_at: startedAt,
    completed_at: completedAt,
    elapsed_ms: elapsedMs,
  };
}
