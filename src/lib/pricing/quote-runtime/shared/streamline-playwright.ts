import type { BrowserContext } from "playwright";

export type StreamlineEnvelope<TData = unknown> = {
  data?: TData;
  status?: {
    code?: unknown;
    description?: unknown;
  };
};

export type StreamlinePostResult<TData = unknown> = {
  httpStatus: number;
  ok: boolean;
  payload: StreamlineEnvelope<TData> | null;
  bodyText: string;
  requestError: string | null;
  parseError: string | null;
};

export async function postStreamlineApiRequest<TData = unknown>(input: {
  context: BrowserContext;
  endpoint: string;
  detailUrl: string;
  origin: string;
  methodName: string;
  params: Record<string, unknown>;
  timeoutMs: number;
}): Promise<StreamlinePostResult<TData>> {
  try {
    const response = await input.context.request.post(input.endpoint, {
      headers: {
        accept: "application/json,text/plain,*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        referer: input.detailUrl,
        origin: input.origin,
        "x-requested-with": "XMLHttpRequest",
      },
      data: new URLSearchParams({
        action: "streamlinecore-api-request",
        params: JSON.stringify({
          methodName: input.methodName,
          params: input.params,
        }),
      }).toString(),
      timeout: input.timeoutMs,
    });

    const bodyText = await response.text();
    let payload: StreamlineEnvelope<TData> | null = null;
    let parseError: string | null = null;

    try {
      payload = JSON.parse(bodyText) as StreamlineEnvelope<TData>;
    } catch (error: unknown) {
      parseError = error instanceof Error ? error.message : "Invalid JSON";
    }

    return {
      httpStatus: response.status(),
      ok: response.ok(),
      payload,
      bodyText,
      requestError: null,
      parseError,
    };
  } catch (error: unknown) {
    return {
      httpStatus: 0,
      ok: false,
      payload: null,
      bodyText: "",
      requestError:
        error instanceof Error
          ? error.message
          : "Unknown browser request error",
      parseError: null,
    };
  }
}
