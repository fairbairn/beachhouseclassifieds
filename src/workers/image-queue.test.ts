import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCAL_REDIS_URL,
  resolveRedisUrl,
} from "@/workers/image-queue";

describe("resolveRedisUrl", () => {
  it("falls back to local Redis when REDIS_URL is missing", () => {
    const original = process.env.REDIS_URL;
    try {
      delete process.env.REDIS_URL;
      expect(resolveRedisUrl()).toBe(DEFAULT_LOCAL_REDIS_URL);
    } finally {
      if (original === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = original;
      }
    }
  });

  it("falls back to local Redis when REDIS_URL is blank", () => {
    const original = process.env.REDIS_URL;
    try {
      process.env.REDIS_URL = "   ";
      expect(resolveRedisUrl()).toBe(DEFAULT_LOCAL_REDIS_URL);
    } finally {
      if (original === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = original;
      }
    }
  });

  it("uses REDIS_URL when provided", () => {
    const original = process.env.REDIS_URL;
    try {
      process.env.REDIS_URL = " redis://10.0.0.5:6380 ";
      expect(resolveRedisUrl()).toBe("redis://10.0.0.5:6380");
    } finally {
      if (original === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = original;
      }
    }
  });
});
