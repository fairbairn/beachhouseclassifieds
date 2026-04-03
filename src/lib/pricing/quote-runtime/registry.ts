import { execute360BlueSingleQuote } from "./adapters/360blue";
import { executeKeyco30aSingleQuote } from "./adapters/keyco30a";
import { executePanhandle30aSingleQuote } from "./adapters/panhandle30a";
import type { QuoteExecutionRequest, QuoteExecutionResult } from "./types";

export type QuoteRuntimeExecutor = (
  input: QuoteExecutionRequest,
) => Promise<QuoteExecutionResult>;

const RUNTIME_EXECUTORS: Record<string, QuoteRuntimeExecutor> = {
  "360blue": execute360BlueSingleQuote,
  keyco30a: executeKeyco30aSingleQuote,
  panhandle30a: executePanhandle30aSingleQuote,
};

export function getKnownQuoteRuntimeAdapterKeys(): string[] {
  return Object.keys(RUNTIME_EXECUTORS).sort();
}

export function getQuoteRuntimeExecutor(
  adapterKey: string,
): QuoteRuntimeExecutor | null {
  return RUNTIME_EXECUTORS[adapterKey] ?? null;
}
