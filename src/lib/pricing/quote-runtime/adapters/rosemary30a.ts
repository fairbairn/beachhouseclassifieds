import "@/core/tooling/env/load-env-profile";

import { executeStreamlinePlaywrightQuote } from "../shared/streamline-playwright";
import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

const ADAPTER_KEY = "rosemary30a" as const;
const ENV_PREFIX = "ROSEMARY30A" as const;

export async function executeRosemary30ASingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  return executeStreamlinePlaywrightQuote({
    adapterKey: ADAPTER_KEY,
    envPrefix: ENV_PREFIX,
    request: input,
  });
}
