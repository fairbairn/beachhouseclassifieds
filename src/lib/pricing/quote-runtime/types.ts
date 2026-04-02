export type QuoteExecutionOptions = {
  timeoutMs?: number;
};

export type QuoteExecutionRequest = {
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  quoteContext: Record<string, unknown> | null;
  options?: QuoteExecutionOptions;
};

export type QuoteExecutionObservation = {
  startDate: string;
  endDate: string;
  quoteAvailable: boolean;
  currency: string | null;
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotalExclTaxes: number | null;
  grandTotal: number | null;
  quotedTotal: number | null;
  handoffUrl: string | null;
};

export type QuoteExecutionError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type QuoteExecutionSuccessResult = {
  success: true;
  elapsedMs: number;
  observation: QuoteExecutionObservation;
};

export type QuoteExecutionFailureResult = {
  success: false;
  elapsedMs: number;
  error: QuoteExecutionError;
};

export type QuoteExecutionResult =
  | QuoteExecutionSuccessResult
  | QuoteExecutionFailureResult;
