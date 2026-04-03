import { formatModeProgressLine } from "@/core/tooling/terminal/scrape-progress";
import type { QuoteProgress } from "@/lib/pricing/quotes/types";

type QuoteCaptureProgressTrackerInput = {
  progress?: QuoteProgress;
  totalListings: number;
  windowsPerListing: number;
  heartbeatMs?: number;
  modeLabel?: string;
};

type ListingCompleteInput = {
  listingId: string;
  windows: number;
  available: number;
};

export type QuoteCaptureProgressTracker = {
  onWindowResult: (quoteAvailable: boolean) => void;
  onListingComplete: (input: ListingCompleteInput) => void;
  finish: () => void;
};

export function createQuoteCaptureProgressTracker(
  input: QuoteCaptureProgressTrackerInput,
): QuoteCaptureProgressTracker {
  const totalWindows = input.totalListings * input.windowsPerListing;
  let completedListings = 0;
  let completedWindows = 0;
  let availableWindows = 0;
  let unavailableWindows = 0;
  const runStartedAt = Date.now();
  const heartbeatMs = Math.max(1000, input.heartbeatMs ?? 15000);
  const modeLabel = input.modeLabel?.trim() || "quote-capture";

  const formatPrefix = (): string =>
    formatModeProgressLine({
      mode: modeLabel,
      completed: completedWindows,
      total: totalWindows,
      startedAtMs: runStartedAt,
      text: "",
    }).replace(/ - $/, "");

  const emitProgress = (label: string): void => {
    const elapsedSeconds = Math.max(
      1,
      Math.round((Date.now() - runStartedAt) / 1000),
    );
    const throughputPerMinute = Math.round(
      (completedWindows / elapsedSeconds) * 60,
    );
    const prefix = formatPrefix();
    input.progress?.tick(
      `${prefix} ${label} windows=${completedWindows}/${totalWindows} available=${availableWindows} unavailable=${unavailableWindows} throughput_per_min=${throughputPerMinute}`,
    );
  };

  const heartbeat = setInterval(() => {
    if (completedWindows >= totalWindows) {
      return;
    }
    emitProgress("quote windows heartbeat");
  }, heartbeatMs);

  if (typeof (heartbeat as { unref?: () => void }).unref === "function") {
    (heartbeat as { unref: () => void }).unref();
  }

  input.progress?.phase(
    `${formatPrefix()} capturing windows listings=${input.totalListings} windows=${totalWindows}`,
  );

  return {
    onWindowResult: (quoteAvailable: boolean) => {
      completedWindows += 1;
      if (quoteAvailable) {
        availableWindows += 1;
      } else {
        unavailableWindows += 1;
      }

      if (
        completedWindows <= 20 ||
        completedWindows % 200 === 0 ||
        completedWindows === totalWindows
      ) {
        emitProgress("quote windows progress");
      }
    },
    onListingComplete: (listingInput: ListingCompleteInput) => {
      completedListings += 1;
      const prefix = formatPrefix();
      input.progress?.tick(
        `${prefix} listing complete ${completedListings}/${input.totalListings} listing=${listingInput.listingId} windows=${listingInput.windows} available=${listingInput.available}`,
      );
    },
    finish: () => {
      clearInterval(heartbeat);
    },
  };
}
