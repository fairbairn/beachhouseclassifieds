import "@/core/tooling/env/load-env-profile";

import { executeStreamlineBrowserQuote } from "../shared/streamline-browser-engine";
import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

const ADAPTER_KEY = "rosemary30a" as const;
const ENV_PREFIX = "ROSEMARY30A" as const;

export async function executeRosemary30ASingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  return executeStreamlineBrowserQuote({
    adapterKey: ADAPTER_KEY,
    envPrefix: ENV_PREFIX,
    request: input,
  });
}
