import { Worker } from "bullmq";
import chalk from "chalk";
import figlet from "figlet";
import {
  loadEnvironmentBundleIntoProcessEnv,
  parseEnvironmentToken,
} from "../core/tooling/env/environment-bundle.js";
import {
  envOverrideKeys,
  resolveProfileEnvironment,
} from "../core/tooling/env/profile-env.js";
import { processImageProcessingBatch } from "./image-processing-task.js";
import {
  IMAGE_QUEUE_NAME,
  createRedisConnection,
  formatRedisEndpointForLogs,
  type ImageProcessingQueueJob,
} from "./image-queue.js";

function loadEnvProfile(): void {
  const { resolvedEnv } = resolveProfileEnvironment();

  for (const key of envOverrideKeys) {
    const value = resolvedEnv[key];
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

function initializeEnvironment(): { loaded: boolean; appliedKeys: string[] } {
  const bundleResult = loadEnvironmentBundleIntoProcessEnv();
  if (!bundleResult.loaded) {
    loadEnvProfile();
    return { loaded: false, appliedKeys: [] };
  }

  return bundleResult;
}

function reportEnvironmentReadiness(
  progress: ReturnType<typeof createProgress>,
  bundleResult: { loaded: boolean; appliedKeys: string[] },
): { hasBunnySecret: boolean } {
  const tokenRaw = process.env.ENVIRONMENT?.trim() || "";
  const token = tokenRaw ? parseEnvironmentToken(tokenRaw) : null;
  const hasBunnySecret = Boolean(
    process.env.BUNNY_STORAGE_SECRET_ACCESS_KEY?.trim(),
  );
  const hasRedisUrl = Boolean(process.env.REDIS_URL?.trim());
  const fullReady = hasBunnySecret;
  const check = chalk.green("✓");
  const cross = chalk.red("x");
  const statusMark = (ok: boolean) => (ok ? check : cross);
  const tokenDetected = Boolean(tokenRaw);

  progress.info(
    `env_bootstrap source=${bundleResult.loaded ? "bundle" : "profile"} token=${token ? "hash16.share2.base58" : "none"}`,
  );
  if (token) {
    progress.info(
      `env_token hash16=${token.hash16} share2_len=${token.shareTwo.length} payload_len=${token.payloadBase58.length}`,
    );
  }
  if (bundleResult.loaded) {
    progress.info(
      `env_bundle_applied count=${bundleResult.appliedKeys.length}`,
    );
  }
  progress.info("readiness_checklist");
  progress.info(
    `  ${statusMark(tokenDetected)} secure_bundle_input ${tokenDetected ? "detected" : "not_detected"}`,
  );
  progress.info(
    `  ${statusMark(bundleResult.loaded)} secure_bundle_loaded ${bundleResult.loaded ? `applied=${bundleResult.appliedKeys.length}` : "inactive"}`,
  );
  progress.info(
    `  ${statusMark(hasRedisUrl)} queue_endpoint ${hasRedisUrl ? "custom" : "default_local"}`,
  );
  progress.info(
    `  ${statusMark(hasBunnySecret)} storage_credentials ${hasBunnySecret ? "present" : "missing"}`,
  );
  progress.info(
    `  ${statusMark(fullReady)} full_operational_ready ${fullReady ? "yes" : "no"}`,
  );

  if (!hasBunnySecret) {
    progress.warn(
      "storage credentials missing: full cloud upload path is unavailable",
    );
  }

  return { hasBunnySecret };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseArgs(argv: string[]): { concurrency: number } {
  let requested = 1;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if ((token === "--concurrency" || token === "-c") && next) {
      requested = parsePositiveInt(next, requested);
      i += 1;
    }
  }

  return {
    concurrency: Math.max(1, Math.min(20, requested)),
  };
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function createProgress(script: string) {
  const scriptLabel = chalk.bgBlue.white.bold(` ${script} `);

  function line(label: string, message: string): void {
    process.stdout.write(
      `${chalk.gray(stamp())} ${scriptLabel} ${label} ${message}\n`,
    );
  }

  return {
    phase(message: string) {
      line(chalk.bgCyan.black.bold(" phase "), chalk.cyan(message));
    },
    info(message: string) {
      line(chalk.bgWhite.black.bold(" info "), message);
    },
    progress(message: string) {
      line(chalk.bgBlueBright.white.bold(" prog  "), chalk.blueBright(message));
    },
    warn(message: string) {
      line(chalk.bgYellow.black.bold(" warn "), chalk.yellow(message));
    },
    done(message: string) {
      line(chalk.bgGreen.black.bold(" done "), chalk.green(message));
    },
    fail(message: string) {
      line(chalk.bgRed.white.bold(" fail "), chalk.red(message));
    },
  };
}

function printStartupHeader(params: {
  concurrency: number;
  bundleLoaded: boolean;
  bundleAppliedCount: number;
  redisEndpoint: string;
}): void {
  const tokenDetected = Boolean(process.env.ENVIRONMENT?.trim());
  const hasRedisUrl = Boolean(process.env.REDIS_URL?.trim());
  const hasStorageCredentials = Boolean(
    process.env.BUNNY_STORAGE_SECRET_ACCESS_KEY?.trim(),
  );
  const check = chalk.green("✓");
  const cross = chalk.red("x");
  const statusMark = (ok: boolean) => (ok ? check : cross);
  const bar = chalk.cyan("=".repeat(78));
  let banner = "Image Worker";
  try {
    banner = figlet.textSync("Image Worker", {
      font: "Standard",
      horizontalLayout: "default",
      verticalLayout: "default",
    });
  } catch {
    banner = "Image Worker";
  }

  process.stdout.write(`\n${bar}\n`);
  for (const line of banner.split("\n")) {
    if (line.trim()) {
      process.stdout.write(`${chalk.cyanBright(line)}\n`);
    }
  }
  process.stdout.write(
    `${chalk.bgCyan.black.bold(" BOOT ")} ${chalk.cyan("image-processing runtime startup")}\n`,
  );
  process.stdout.write(
    `${chalk.gray("started_at")}  ${new Date().toISOString()}\n`,
  );
  process.stdout.write(`${chalk.gray("queue")}       ${IMAGE_QUEUE_NAME}\n`);
  process.stdout.write(
    `${chalk.gray("mode")}        ${params.bundleLoaded ? "secure_bundle" : "profile_env"}\n`,
  );
  process.stdout.write(
    `${chalk.gray("concurrency")} ${params.concurrency}\n\n`,
  );

  const tableHeader = `${"CHECK".padEnd(7)} ${"ITEM".padEnd(24)} ${"STATUS".padEnd(16)} DETAILS`;
  process.stdout.write(`${chalk.whiteBright(tableHeader)}\n`);
  process.stdout.write(`${chalk.gray("-".repeat(78))}\n`);

  const printRow = (
    ok: boolean,
    item: string,
    status: string,
    details: string,
  ): void => {
    const mark = statusMark(ok);
    const itemCol = item.padEnd(24);
    const statusCol = status.padEnd(16);
    process.stdout.write(
      `${mark} ${itemCol} ${statusCol} ${chalk.gray(details)}\n`,
    );
  };

  printRow(
    tokenDetected,
    "bundle_input",
    tokenDetected ? "detected" : "not_detected",
    "secure token present at boot",
  );
  printRow(
    params.bundleLoaded,
    "bundle_loaded",
    params.bundleLoaded ? "active" : "inactive",
    params.bundleLoaded
      ? `applied_count=${params.bundleAppliedCount}`
      : "fallback profile mode",
  );
  printRow(
    hasRedisUrl,
    "queue_endpoint",
    hasRedisUrl ? "custom" : "default_local",
    `resolved=${params.redisEndpoint}`,
  );
  printRow(
    hasStorageCredentials,
    "storage_credentials",
    hasStorageCredentials ? "present" : "missing",
    hasStorageCredentials
      ? "upload path available"
      : "dryRun-only for upload jobs",
  );
  printRow(
    hasStorageCredentials,
    "full_operational_ready",
    hasStorageCredentials ? "yes" : "no",
    "runtime capability gate",
  );

  process.stdout.write(`${bar}\n\n`);
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const progress = createProgress("image-worker");
  const bundleResult = initializeEnvironment();
  printStartupHeader({
    concurrency: args.concurrency,
    bundleLoaded: bundleResult.loaded,
    bundleAppliedCount: bundleResult.appliedKeys.length,
    redisEndpoint: formatRedisEndpointForLogs(),
  });
  const readiness = reportEnvironmentReadiness(progress, bundleResult);
  const connection = createRedisConnection();
  const hasBunnySecret = readiness.hasBunnySecret;
  const startedAtMs = Date.now();
  const activeJobs = new Map<string, number>();
  let completedJobs = 0;
  let failedJobs = 0;
  let shuttingDown = false;

  function formatCounters(): string {
    const activeCount = activeJobs.size;
    const finalized = completedJobs + failedJobs;
    const elapsedSeconds = Math.max(
      1,
      Math.round((Date.now() - startedAtMs) / 1000),
    );
    const throughputPerMinute = ((completedJobs / elapsedSeconds) * 60).toFixed(
      1,
    );
    return `active=${activeCount} completed=${completedJobs} failed=${failedJobs} finalized=${finalized} throughput_ok_per_min=${throughputPerMinute}`;
  }

  if (!hasBunnySecret) {
    progress.warn(
      "worker can only process jobs with dryRun=true while storage credentials are missing",
    );
  }

  const worker = new Worker<ImageProcessingQueueJob>(
    IMAGE_QUEUE_NAME,
    async (job) => {
      if (job.data.dryRun === false && !hasBunnySecret) {
        throw new Error(
          "worker_misconfigured_missing_storage_credentials dryRun=false requires storage credentials",
        );
      }

      const result = await processImageProcessingBatch(
        {
          operationId: job.data.operationId,
          batchId: job.data.batchId,
          batchIndex: job.data.batchIndex,
          batchCount: job.data.batchCount,
          workerConcurrency: 1,
          fetchTimeoutMs: job.data.fetchTimeoutMs,
          fetchRetryCount: job.data.fetchRetryCount,
          sleepSecondsPerItem: job.data.sleepSecondsPerItem,
          dryRun: job.data.dryRun,
          uploadPrefix: job.data.uploadPrefix,
          verboseLogs: job.data.verboseLogs,
          items: [
            {
              workId: job.data.workId,
              sourceType: job.data.sourceType,
              sourceImageUrl: job.data.sourceImageUrl,
              sourceS3Key: job.data.sourceS3Key,
              sourceS3Bucket: job.data.sourceS3Bucket,
            },
          ],
        },
        {
          onProgress: (progress) => {
            void job.updateProgress(progress);
          },
        },
      );

      return {
        ...result,
        // Backward-compat fields for desktop-runner transition.
        workId: job.data.workId,
        processed: result.processed_count,
        failed: result.failed_count,
      };
    },
    {
      connection,
      concurrency: args.concurrency,
    },
  );

  worker.on("ready", () => {
    progress.phase(
      `ready queue=${IMAGE_QUEUE_NAME} redis=${process.env.REDIS_URL?.trim() ? "custom" : "default_local"} concurrency=${args.concurrency}`,
    );
  });

  worker.on("active", (job) => {
    const jobId = String(job?.id || "unknown");
    activeJobs.set(jobId, Date.now());
    progress.progress(
      `active job_id=${jobId} work_id=${job?.data?.workId || "unknown"} ${formatCounters()}`,
    );
  });

  worker.on("completed", (job, result) => {
    const jobId = String(job?.id || "unknown");
    const startedMs = activeJobs.get(jobId) ?? Date.now();
    activeJobs.delete(jobId);
    completedJobs += 1;
    const durationMs = Date.now() - startedMs;
    progress.done(
      `completed job_id=${jobId} work_id=${job?.data?.workId || "unknown"} duration_ms=${durationMs} processed=${result?.processed ?? 0} failed=${result?.failed ?? 0} ${formatCounters()}`,
    );
  });

  worker.on("failed", (job, error) => {
    const jobId = String(job?.id || "unknown");
    activeJobs.delete(jobId);
    failedJobs += 1;
    progress.fail(
      `failed job_id=${jobId} work_id=${job?.data?.workId || "unknown"} error=${error?.message || String(error)} ${formatCounters()}`,
    );
  });

  worker.on("error", (error) => {
    progress.fail(`worker_error ${error?.message || String(error)}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    progress.warn(`shutdown signal=${signal} ${formatCounters()}`);
    await worker.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
    process.exit(130);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${chalk.gray(stamp())} ${chalk.bgBlue.white.bold(" image-worker ")} ${chalk.bgRed.white.bold(" fail ")} ${chalk.red(`fatal_error=${message}`)}\n`,
  );
  process.exit(1);
});
