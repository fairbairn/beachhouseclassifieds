import "@/core/tooling/env/load-env-profile";

import { executeStreamlinePlaywrightQuote } from "../shared/streamline-playwright";
import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

const ADAPTER_KEY = "30abeach" as const;
const ENV_PREFIX = "30ABEACH" as const;

export async function execute30ABeachSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  return executeStreamlinePlaywrightQuote({
    adapterKey: ADAPTER_KEY,
    envPrefix: ENV_PREFIX,
    request: input,
  });
}
