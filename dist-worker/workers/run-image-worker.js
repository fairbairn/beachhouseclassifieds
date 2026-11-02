import { Worker } from "bullmq";
import chalk from "chalk";
import { envOverrideKeys, resolveProfileEnvironment, } from "../core/tooling/env/profile-env";
import { processImageProcessingBatch } from "./image-processing-task";
import { IMAGE_QUEUE_NAME, createRedisConnection, } from "./image-queue";
function loadEnvProfile() {
    const { resolvedEnv } = resolveProfileEnvironment();
    for (const key of envOverrideKeys) {
        const value = resolvedEnv[key];
        if (value !== undefined) {
            process.env[key] = value;
        }
    }
}
loadEnvProfile();
function parsePositiveInt(raw, fallback) {
    const parsed = Number.parseInt(String(raw || "").trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}
function parseArgs(argv) {
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
function stamp() {
    return new Date().toISOString().slice(11, 19);
}
function createProgress(script) {
    const scriptLabel = chalk.bgBlue.white.bold(` ${script} `);
    function line(label, message) {
        process.stdout.write(`${chalk.gray(stamp())} ${scriptLabel} ${label} ${message}\n`);
    }
    return {
        phase(message) {
            line(chalk.bgCyan.black.bold(" phase "), chalk.cyan(message));
        },
        info(message) {
            line(chalk.bgWhite.black.bold(" info "), message);
        },
        progress(message) {
            line(chalk.bgBlueBright.white.bold(" prog  "), chalk.blueBright(message));
        },
        warn(message) {
            line(chalk.bgYellow.black.bold(" warn "), chalk.yellow(message));
        },
        done(message) {
            line(chalk.bgGreen.black.bold(" done "), chalk.green(message));
        },
        fail(message) {
            line(chalk.bgRed.white.bold(" fail "), chalk.red(message));
        },
    };
}
async function run() {
    const args = parseArgs(process.argv.slice(2));
    const progress = createProgress("image-worker");
    const connection = createRedisConnection();
    const hasBunnySecret = Boolean(process.env.BUNNY_STORAGE_SECRET_ACCESS_KEY?.trim());
    const startedAtMs = Date.now();
    const activeJobs = new Map();
    let completedJobs = 0;
    let failedJobs = 0;
    let shuttingDown = false;
    function formatCounters() {
        const activeCount = activeJobs.size;
        const finalized = completedJobs + failedJobs;
        const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAtMs) / 1000));
        const throughputPerMinute = ((completedJobs / elapsedSeconds) * 60).toFixed(1);
        return `active=${activeCount} completed=${completedJobs} failed=${failedJobs} finalized=${finalized} throughput_ok_per_min=${throughputPerMinute}`;
    }
    if (!hasBunnySecret) {
        progress.warn("BUNNY_STORAGE_SECRET_ACCESS_KEY is missing; worker can only process jobs with dryRun=true");
    }
    const worker = new Worker(IMAGE_QUEUE_NAME, async (job) => {
        if (job.data.dryRun === false && !hasBunnySecret) {
            throw new Error("worker_misconfigured_missing_bunny_secret dryRun=false requires BUNNY_STORAGE_SECRET_ACCESS_KEY");
        }
        const result = await processImageProcessingBatch({
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
        }, {
            onProgress: (progress) => {
                void job.updateProgress(progress);
            },
        });
        return {
            ...result,
            // Backward-compat fields for desktop-runner transition.
            workId: job.data.workId,
            processed: result.processed_count,
            failed: result.failed_count,
        };
    }, {
        connection,
        concurrency: args.concurrency,
    });
    worker.on("ready", () => {
        progress.phase(`ready queue=${IMAGE_QUEUE_NAME} redis=${process.env.REDIS_URL?.trim() || "redis://127.0.0.1:6379"} concurrency=${args.concurrency}`);
    });
    worker.on("active", (job) => {
        const jobId = String(job?.id || "unknown");
        activeJobs.set(jobId, Date.now());
        progress.progress(`active job_id=${jobId} work_id=${job?.data?.workId || "unknown"} ${formatCounters()}`);
    });
    worker.on("completed", (job, result) => {
        const jobId = String(job?.id || "unknown");
        const startedMs = activeJobs.get(jobId) ?? Date.now();
        activeJobs.delete(jobId);
        completedJobs += 1;
        const durationMs = Date.now() - startedMs;
        progress.done(`completed job_id=${jobId} work_id=${job?.data?.workId || "unknown"} duration_ms=${durationMs} processed=${result?.processed ?? 0} failed=${result?.failed ?? 0} ${formatCounters()}`);
    });
    worker.on("failed", (job, error) => {
        const jobId = String(job?.id || "unknown");
        activeJobs.delete(jobId);
        failedJobs += 1;
        progress.fail(`failed job_id=${jobId} work_id=${job?.data?.workId || "unknown"} error=${error?.message || String(error)} ${formatCounters()}`);
    });
    worker.on("error", (error) => {
        progress.fail(`worker_error ${error?.message || String(error)}`);
    });
    const shutdown = async (signal) => {
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
    process.stderr.write(`${chalk.gray(stamp())} ${chalk.bgBlue.white.bold(" image-worker ")} ${chalk.bgRed.white.bold(" fail ")} ${chalk.red(`fatal_error=${message}`)}\n`);
    process.exit(1);
});
