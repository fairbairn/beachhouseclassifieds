import "@/core/tooling/env/load-env-profile";

import { executeStreamlineCloakBrowserQuote } from "../shared/streamline-cloakbrowser";
import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

const ADAPTER_KEY = "30abeach" as const;
const ENV_PREFIX = "30ABEACH" as const;

export async function execute30ABeachSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  return executeStreamlineCloakBrowserQuote({
    adapterKey: ADAPTER_KEY,
    envPrefix: ENV_PREFIX,
    request: input,
  });
}
