import { execute30AEscapesSingleQuote } from "./adapters/30aescapes";
import { execute360BlueSingleQuote } from "./adapters/360blue";
import { executeHomeownerscollection30aSingleQuote } from "./adapters/homeownerscollection30a";
import { executeKeyco30aSingleQuote } from "./adapters/keyco30a";
import { executePanhandle30aSingleQuote } from "./adapters/panhandle30a";
import { executeRoyaldestinationsSingleQuote } from "./adapters/royaldestinations";
import type { QuoteExecutionRequest, QuoteExecutionResult } from "./types";

export type QuoteRuntimeExecutor = (
  input: QuoteExecutionRequest,
) => Promise<QuoteExecutionResult>;

const RUNTIME_EXECUTORS: Record<string, QuoteRuntimeExecutor> = {
  "30aescapes": execute30AEscapesSingleQuote,
  "360blue": execute360BlueSingleQuote,
  homeownerscollection30a: executeHomeownerscollection30aSingleQuote,
  keyco30a: executeKeyco30aSingleQuote,
  panhandle30a: executePanhandle30aSingleQuote,
  royaldestinations: executeRoyaldestinationsSingleQuote,
};

export function getKnownQuoteRuntimeAdapterKeys(): string[] {
  return Object.keys(RUNTIME_EXECUTORS).sort();
}

export function getQuoteRuntimeExecutor(
  adapterKey: string,
): QuoteRuntimeExecutor | null {
  return RUNTIME_EXECUTORS[adapterKey] ?? null;
}
