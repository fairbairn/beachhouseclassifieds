export type RetryConfig = {
  retryDelaysMs: number[];
  onRetry?: (message: string) => void;
  label: string;
};

export type PacingConfig = {
  concurrency: number;
  minGapMs: number;
};

export type PerfSnapshot = {
  completed: number;
  elapsedSeconds: number;
  throughputPerMinute: number;
};

export function parseRetryDelaysMs(raw: string, defaults: number[]): number[] {
  const parsed = raw
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.floor(value));
  return parsed.length >= 2 ? parsed : defaults;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createPacedGate(config: PacingConfig): {
  run<T>(task: () => Promise<T>): Promise<T>;
} {
  let active = 0;
  let lastStartMs = 0;
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    while (true) {
      if (active < Math.max(1, config.concurrency)) {
        active += 1;
        break;
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }

    const waitMs = lastStartMs + Math.max(0, config.minGapMs) - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastStartMs = Date.now();
  }

  function release(): void {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    next?.();
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

export async function withRetries<T>(
  task: () => Promise<T>,
  config: RetryConfig,
): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < config.retryDelaysMs.length; attempt += 1) {
    const delayMs = config.retryDelaysMs[attempt] ?? 0;
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      return await task();
    } catch (error: unknown) {
      lastError = error;
      if (attempt < config.retryDelaysMs.length - 1) {
        const nextDelay = config.retryDelaysMs[attempt + 1] ?? 0;
        const message = error instanceof Error ? error.message : String(error);
        config.onRetry?.(
          `${config.label} retry ${attempt + 1}/${config.retryDelaysMs.length} error=${message} next_delay_ms=${nextDelay}`,
        );
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${config.label} failed after retries`);
}

export function createPerfTracker(): {
  markDone(): PerfSnapshot;
} {
  const startedAt = Date.now();
  let completed = 0;

  return {
    markDone(): PerfSnapshot {
      completed += 1;
      const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
      const throughputPerMinute = completed / (elapsedSeconds / 60);
      return {
        completed,
        elapsedSeconds,
        throughputPerMinute,
      };
    },
  };
}
