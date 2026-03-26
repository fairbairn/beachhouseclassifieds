import { type AppErrorCode } from "@/core/errors/app-errors";
import { normalizeToAppError } from "@/core/server/guard/server-guard-normalization";

// serverGuard is for server-side handler boundaries only.
// Use it in server functions/API handlers to normalize unexpected throws into
// structured app errors before they cross server/client boundaries.
export function serverGuard<TArgs extends unknown[], TResult>(
  handler: (...args: TArgs) => TResult | Promise<TResult>,
  options?: {
    fallbackCode?: AppErrorCode;
  },
) {
  return async (...args: TArgs): Promise<TResult> => {
    try {
      return await handler(...args);
    } catch (error) {
      throw normalizeToAppError(error, {
        fallbackCode: options?.fallbackCode,
      });
    }
  };
}
