import { describe, expect, it } from "vitest";

import { resolveBullmqPollingConfig } from "./bullmq-polling-config";

describe("bullmq polling config", () => {
  it("uses defaults", () => {
    const config = resolveBullmqPollingConfig({});

    expect(config.eventsEnabled).toBe(false);
    expect(config.pollingEnabled).toBe(true);
    expect(config.eventMinIntervalMs).toBe(100);
    expect(config.pollBatchLimit).toBe(1200);
    expect(config.collectorIntervalMs).toBe(1000);
    expect(config.pollLookbackMs).toBe(60 * 1000);
  });

  it("parses boolean and numeric overrides", () => {
    const config = resolveBullmqPollingConfig({
      IMAGE_OPS_BULLMQ_EVENTS_ENABLED: "false",
      IMAGE_OPS_BULLMQ_POLLING_ENABLED: "1",
      IMAGE_OPS_BULLMQ_EVENT_MIN_INTERVAL_MS: "180",
      IMAGE_OPS_BULLMQ_POLL_BATCH_LIMIT: "2200",
      IMAGE_OPS_BULLMQ_COLLECTOR_INTERVAL_MS: "300",
      IMAGE_OPS_BULLMQ_POLL_LOOKBACK_MS: "45000",
    });

    expect(config.eventsEnabled).toBe(false);
    expect(config.pollingEnabled).toBe(true);
    expect(config.eventMinIntervalMs).toBe(180);
    expect(config.pollBatchLimit).toBe(2200);
    expect(config.collectorIntervalMs).toBe(300);
    expect(config.pollLookbackMs).toBe(45000);
  });

  it("clamps invalid values", () => {
    const config = resolveBullmqPollingConfig({
      IMAGE_OPS_BULLMQ_EVENT_MIN_INTERVAL_MS: "0",
      IMAGE_OPS_BULLMQ_POLL_BATCH_LIMIT: "999999",
      IMAGE_OPS_BULLMQ_COLLECTOR_INTERVAL_MS: "-1",
      IMAGE_OPS_BULLMQ_POLL_LOOKBACK_MS: "1000",
    });

    expect(config.eventMinIntervalMs).toBe(50);
    expect(config.pollBatchLimit).toBe(10000);
    expect(config.collectorIntervalMs).toBe(100);
    expect(config.pollLookbackMs).toBe(15_000);
  });
});
