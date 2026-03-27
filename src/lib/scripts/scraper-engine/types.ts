import type { Browser, Page } from "playwright";

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
};
