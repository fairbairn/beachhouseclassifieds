import { execute30ABeachSingleQuote } from "./adapters/30abeach";
import { executeThirtyACottagesSingleQuote } from "./adapters/30acottages";
import { execute30AEscapesSingleQuote } from "./adapters/30aescapes";
import { execute30ALuxurySingleQuote } from "./adapters/30aluxury";
import { execute30AvacaySingleQuote } from "./adapters/30avacay";
import { execute360BlueSingleQuote } from "./adapters/360blue";
import { executeBenchmark30aSingleQuote } from "./adapters/benchmark30a";
import { executeCoastproperties30aSingleQuote } from "./adapters/coastproperties30a";
import { executeDunevr30aSingleQuote } from "./adapters/dunevr30a";
import { executeElp30aSingleQuote } from "./adapters/elp30a";
import { executeExclusive30aSingleQuote } from "./adapters/exclusive30a";
import { executeFivestar30aSingleQuote } from "./adapters/fivestar30a";
import { executeFunvacay30aSingleQuote } from "./adapters/funvacay30a";
import { executeGrayt30aSingleQuote } from "./adapters/grayt30a";
import { executeHomeownerscollection30aSingleQuote } from "./adapters/homeownerscollection30a";
import { executeKeyco30aSingleQuote } from "./adapters/keyco30a";
import { executeLocalvr30aSingleQuote } from "./adapters/localvr30a";
import { executeLuxe30aSingleQuote } from "./adapters/luxe30a";
import { executeOceanreef30aSingleQuote } from "./adapters/oceanreef30a";
import { executeOversee30aSingleQuote } from "./adapters/oversee30a";
import { executePanhandle30aSingleQuote } from "./adapters/panhandle30a";
import { executeProminence30SingleQuote } from "./adapters/prominence30a";
import { executeRealjoy30aSingleQuote } from "./adapters/realjoy30a";
import { executeRosemary30ASingleQuote } from "./adapters/rosemary30a";
import { executeRoyaldestinationsSingleQuote } from "./adapters/royaldestinations";
import { executeSandersbeach30aSingleQuote } from "./adapters/sandersbeach30a";
import { executeSandpiper30aSingleQuote } from "./adapters/sandpiper30a";
import { executeScenicstays30aSingleQuote } from "./adapters/scenicstays30a";
import { executeStayat30aSingleQuote } from "./adapters/stayat30a";
import { executeStayon30aSingleQuote } from "./adapters/stayon30a";
import type { QuoteExecutionRequest, QuoteExecutionResult } from "./types";

export type QuoteRuntimeExecutor = (
  input: QuoteExecutionRequest,
) => Promise<QuoteExecutionResult>;

const RUNTIME_EXECUTORS: Record<string, QuoteRuntimeExecutor> = {
  "30abeach": execute30ABeachSingleQuote,
  "30acottages": executeThirtyACottagesSingleQuote,
  "30avacay": execute30AvacaySingleQuote,
  "30aescapes": execute30AEscapesSingleQuote,
  "30aluxury": execute30ALuxurySingleQuote,
  "360blue": execute360BlueSingleQuote,
  benchmark30a: executeBenchmark30aSingleQuote,
  coastproperties30a: executeCoastproperties30aSingleQuote,
  dunevr30a: executeDunevr30aSingleQuote,
  elp30a: executeElp30aSingleQuote,
  exclusive30a: executeExclusive30aSingleQuote,
  fivestar30a: executeFivestar30aSingleQuote,
  funvacay30a: executeFunvacay30aSingleQuote,
  grayt30a: executeGrayt30aSingleQuote,
  homeownerscollection30a: executeHomeownerscollection30aSingleQuote,
  keyco30a: executeKeyco30aSingleQuote,
  luxe30a: executeLuxe30aSingleQuote,
  localvr30a: executeLocalvr30aSingleQuote,
  oceanreef30a: executeOceanreef30aSingleQuote,
  oversee30a: executeOversee30aSingleQuote,
  panhandle30a: executePanhandle30aSingleQuote,
  prominence30a: executeProminence30SingleQuote,
  realjoy30a: executeRealjoy30aSingleQuote,
  rosemary30a: executeRosemary30ASingleQuote,
  royaldestinations: executeRoyaldestinationsSingleQuote,
  sandersbeach30a: executeSandersbeach30aSingleQuote,
  sandpiper30a: executeSandpiper30aSingleQuote,
  scenicstays30a: executeScenicstays30aSingleQuote,
  stayat30a: executeStayat30aSingleQuote,
  stayon30a: executeStayon30aSingleQuote,
};

export function getKnownQuoteRuntimeAdapterKeys(): string[] {
  return Object.keys(RUNTIME_EXECUTORS).sort();
}

export function getQuoteRuntimeExecutor(
  adapterKey: string,
): QuoteRuntimeExecutor | null {
  return RUNTIME_EXECUTORS[adapterKey] ?? null;
}
