import { formatModeProgressLine } from "@/core/tooling/terminal/scrape-progress";
import type { QuoteProgress } from "@/lib/pricing/quotes/types";

type QuoteCaptureProgressTrackerInput = {
  progress?: QuoteProgress;
  totalListings: number;
  windowsPerListing?: number;
  heartbeatMs?: number;
  modeLabel?: string;
};

type ListingCompleteInput = {
  listingId: string;
  windows: number;
  available: number;
};

export type QuoteCaptureProgressTracker = {
  onWindowsPlanned: (windows: number) => void;
  onWindowResult: (quoteAvailable: boolean) => void;
  onListingComplete: (input: ListingCompleteInput) => void;
  finish: () => void;
};

export function createQuoteCaptureProgressTracker(
  input: QuoteCaptureProgressTrackerInput,
): QuoteCaptureProgressTracker {
  let plannedWindows =
    input.windowsPerListing && input.windowsPerListing > 0
      ? input.totalListings * input.windowsPerListing
      : 0;
  let completedListings = 0;
  let completedWindows = 0;
  let availableWindows = 0;
  let unavailableWindows = 0;
  const runStartedAt = Date.now();
  const heartbeatMs = Math.max(1000, input.heartbeatMs ?? 15000);
  const modeLabel = input.modeLabel?.trim() || "quote-capture";

  const totalForDisplay = (): number =>
    Math.max(1, Math.max(plannedWindows, completedWindows));

  const formatPrefix = (): string =>
    formatModeProgressLine({
      mode: modeLabel,
      completed: completedWindows,
      total: totalForDisplay(),
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
    const displayTotal = totalForDisplay();
    const prefix = formatPrefix();
    input.progress?.tick(
      `${prefix} ${label} windows=${completedWindows}/${displayTotal} available=${availableWindows} unavailable=${unavailableWindows} throughput_per_min=${throughputPerMinute}`,
    );
  };

  const heartbeat = setInterval(() => {
    if (completedListings >= input.totalListings) {
      return;
    }
    emitProgress("quote windows heartbeat");
  }, heartbeatMs);

  if (typeof (heartbeat as { unref?: () => void }).unref === "function") {
    (heartbeat as { unref: () => void }).unref();
  }

  input.progress?.phase(
    `${formatPrefix()} capturing windows listings=${input.totalListings} windows=${plannedWindows > 0 ? String(plannedWindows) : "planning"}`,
  );

  return {
    onWindowsPlanned: (windows: number) => {
      if (!Number.isFinite(windows) || windows <= 0) {
        return;
      }
      plannedWindows += Math.floor(windows);
    },
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
        completedListings >= input.totalListings
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
