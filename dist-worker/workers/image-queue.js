import { Queue } from "bullmq";
import IORedis from "ioredis";
export const IMAGE_QUEUE_NAME = "image-processing";
function resolveRedisUrl() {
    return process.env.REDIS_URL?.trim() || "redis://127.0.0.1:6379";
}
export function createRedisConnection() {
    return new IORedis(resolveRedisUrl(), {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
    });
}
export function createImageQueue(connection) {
    const redis = connection ?? createRedisConnection();
    return new Queue(IMAGE_QUEUE_NAME, {
        connection: redis,
        defaultJobOptions: {
            removeOnComplete: 200,
            removeOnFail: 500,
            attempts: 1,
        },
    });
}
