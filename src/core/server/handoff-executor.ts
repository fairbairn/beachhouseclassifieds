import {
  resolveHandoffRequest,
  type HandoffRequest,
} from "@/lib/pricing/contracts/handoff-request-contract";

export type ExecutedHandoffResult = {
  request: HandoffRequest;
  ok: boolean;
  status: number;
  finalUrl: string;
  bodyJson: unknown | null;
  bodyText: string;
};

export async function executeHandoffRequest(
  handoffUrl: string,
): Promise<ExecutedHandoffResult> {
  const request = resolveHandoffRequest(handoffUrl);
  if (!request) {
    throw new Error("Invalid handoff URL.");
  }

  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.method === "POST" ? JSON.stringify(request.jsonBody) : null,
    redirect: "follow",
  });

  const bodyText = await response.text();
  let bodyJson: unknown | null = null;
  try {
    bodyJson = bodyText ? (JSON.parse(bodyText) as unknown) : null;
  } catch {
    bodyJson = null;
  }

  return {
    request,
    ok: response.ok,
    status: response.status,
    finalUrl: response.url,
    bodyJson,
    bodyText,
  };
}
