import { execute30AEscapesSingleQuote } from "./adapters/30aescapes";
import { execute30ALuxurySingleQuote } from "./adapters/30aluxury";
import { execute30AvacaySingleQuote } from "./adapters/30avacay";
import { execute360BlueSingleQuote } from "./adapters/360blue";
import { executeBenchmark30aSingleQuote } from "./adapters/benchmark30a";
import { executeDunevr30aSingleQuote } from "./adapters/dunevr30a";
import { executeExclusive30aSingleQuote } from "./adapters/exclusive30a";
import { executeHomeownerscollection30aSingleQuote } from "./adapters/homeownerscollection30a";
import { executeKeyco30aSingleQuote } from "./adapters/keyco30a";
import { executeOceanreef30aSingleQuote } from "./adapters/oceanreef30a";
import { executeOversee30aSingleQuote } from "./adapters/oversee30a";
import { executePanhandle30aSingleQuote } from "./adapters/panhandle30a";
import { executeRealjoy30aSingleQuote } from "./adapters/realjoy30a";
import { executeRoyaldestinationsSingleQuote } from "./adapters/royaldestinations";
import { executeSandpiper30aSingleQuote } from "./adapters/sandpiper30a";
import type { QuoteExecutionRequest, QuoteExecutionResult } from "./types";

export type QuoteRuntimeExecutor = (
  input: QuoteExecutionRequest,
) => Promise<QuoteExecutionResult>;

const RUNTIME_EXECUTORS: Record<string, QuoteRuntimeExecutor> = {
  "30avacay": execute30AvacaySingleQuote,
  "30aescapes": execute30AEscapesSingleQuote,
  "30aluxury": execute30ALuxurySingleQuote,
  "360blue": execute360BlueSingleQuote,
  benchmark30a: executeBenchmark30aSingleQuote,
  dunevr30a: executeDunevr30aSingleQuote,
  exclusive30a: executeExclusive30aSingleQuote,
  homeownerscollection30a: executeHomeownerscollection30aSingleQuote,
  keyco30a: executeKeyco30aSingleQuote,
  oceanreef30a: executeOceanreef30aSingleQuote,
  oversee30a: executeOversee30aSingleQuote,
  panhandle30a: executePanhandle30aSingleQuote,
  realjoy30a: executeRealjoy30aSingleQuote,
  royaldestinations: executeRoyaldestinationsSingleQuote,
  sandpiper30a: executeSandpiper30aSingleQuote,
};

export function getKnownQuoteRuntimeAdapterKeys(): string[] {
  return Object.keys(RUNTIME_EXECUTORS).sort();
}

export function getQuoteRuntimeExecutor(
  adapterKey: string,
): QuoteRuntimeExecutor | null {
  return RUNTIME_EXECUTORS[adapterKey] ?? null;
}
