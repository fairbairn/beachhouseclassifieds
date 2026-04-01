import type { QuoteProgress } from "@/lib/pricing/quotes/types";
import type { Browser, Page } from "playwright";

export type ScraperRefreshMode = "full" | "dynamic" | "static";
export type ScraperLogLevel = "default" | "debug";
export type ScraperRunMode =
  | "detail"
  | "avail"
  | "quote"
  | "detail,avail"
  | "detail,quote"
  | "avail,quote"
  | "detail,avail,quote";

export type ScrapedLink = {
  link: string;
  source_url: string;
  anchor_text: string;
};

export type RunOptions = {
  anchorUrl: string;
  maxListings: number | null;
  startIndex: number;
  discoverOnly: boolean;
  detailUrl: string | null;
  detailUrlsFile: string | null;
  refreshKnown: boolean;
  maxScrollSteps: number;
  scrollPauseMs: number;
  networkIdleWaitMs: number;
  detailFetchConcurrency: number | null;
  detailFetchDelayMs: number | null;
  detailTimeoutMs: number;
  detailRetryAttempts: number;
  detailRetryDelayMs: number;
  skipExistingDetails: boolean;
  skipFreshDetails: boolean;
  freshHours: number;
  refreshMode: ScraperRefreshMode;
  mode: ScraperRunMode;
  availHorizonDays: number | null;
  availMaxCalendarMonths: number | null;
  quoteWindowDays: number | null;
  quoteSampleStepDays: number | null;
  quoteNights: number | null;
  quoteMaxQueries: number | null;
  quoteAnchorDate: string | null;
  quoteObservationRetryDelaysMs: string | null;
  logLevel: ScraperLogLevel;
};

export type DetailRecordBase = {
  external_listing_id: string;
  detail_url: string;
  fetched_at: string;
  html_path: string;
};

export type DiscoverContext = {
  page: Page;
  anchorUrl: string;
  maxScrollSteps: number;
  scrollPauseMs: number;
  networkIdleWaitMs: number;
  reportProgress: (message: string) => void;
};

export type FetchDetailContext = {
  browser: Browser;
  detailUrl: string;
  availabilityHorizonDays: number;
  maxCalendarAdvanceMonths: number;
  refreshMode: ScraperRefreshMode;
  mode: ScraperRunMode;
  existingDetailJsonPath?: string | null;
  reportDetailProgress?: (message: string) => void;
};

export type ScraperAdapter<TDetail extends DetailRecordBase> = {
  managerKey: string;
  scriptLabel: string;
  defaultAnchorUrl: string;
  detailFetchDelayMs: number;
  detailFetchConcurrency: number;
  availabilityHorizonDays: number;
  maxCalendarAdvanceMonths: number;
  isValidDetailUrl(value: string): string | null;
  discoverListings(context: DiscoverContext): Promise<ScrapedLink[]>;
  fetchDetail(context: FetchDetailContext): Promise<TDetail | null>;
  runQuoteCapture?(argv: string[], progress: QuoteProgress): Promise<void>;
};
