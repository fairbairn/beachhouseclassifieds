import type { DiscoverContext } from "../types";

type BrowserPage = DiscoverContext["page"];

async function waitForCookie(input: {
  page: BrowserPage;
  origin: string;
  cookieName: string;
  timeoutMs: number;
}): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < input.timeoutMs) {
    const cookies = await input.page.context().cookies(input.origin);
    if (cookies.some((cookie) => cookie.name === input.cookieName)) {
      return true;
    }
    await input.page.waitForTimeout(400);
  }
  return false;
}

export async function navigateDetailWithChallenge(input: {
  page: BrowserPage;
  detailUrl: string;
  origin: string;
  timeoutMs: number;
  challengeWaitMs?: number;
}): Promise<{ status: number | null; html: string; finalUrl: string }> {
  const response = await input.page.goto(input.detailUrl, {
    waitUntil: "domcontentloaded",
    timeout: input.timeoutMs,
  });

  let status = response?.status() ?? null;
  const cfMitigated = response?.headers()["cf-mitigated"]?.trim() ?? null;

  if (status === 403 && cfMitigated?.toLowerCase() === "challenge") {
    const gotClearance = await waitForCookie({
      page: input.page,
      origin: input.origin,
      cookieName: "cf_clearance",
      timeoutMs: input.challengeWaitMs ?? 8000,
    });

    if (gotClearance) {
      const retryResponse = await input.page.goto(input.detailUrl, {
        waitUntil: "domcontentloaded",
        timeout: input.timeoutMs,
      });
      status = retryResponse?.status() ?? null;
    }
  }

  const html = status === 200 ? await input.page.content() : "";
  const finalUrl = input.page.url();
  return { status, html, finalUrl };
}

export async function postStreamlineApiRequestWithPage<T = unknown>(input: {
  page: BrowserPage;
  origin: string;
  methodName: string;
  params: Record<string, unknown>;
}): Promise<T | null> {
  const response = (await input.page.evaluate(
    async (payload: {
      origin: string;
      methodName: string;
      params: Record<string, unknown>;
    }) => {
      try {
        const body = new URLSearchParams({
          action: "streamlinecore-api-request",
          params: JSON.stringify({
            methodName: payload.methodName,
            params: payload.params,
          }),
        }).toString();

        const request = await fetch(
          `${payload.origin}/wp-admin/admin-ajax.php`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              accept: "application/json,text/plain,*/*",
              "content-type":
                "application/x-www-form-urlencoded; charset=UTF-8",
              "x-requested-with": "XMLHttpRequest",
            },
            body,
          },
        );

        return {
          status: request.status,
          text: await request.text(),
        };
      } catch (error: unknown) {
        return {
          status: 0,
          text: error instanceof Error ? error.message : "request_failed",
        };
      }
    },
    {
      origin: input.origin,
      methodName: input.methodName,
      params: input.params,
    },
  )) as { status: number; text: string };

  if (response.status !== 200) {
    return null;
  }

  try {
    return JSON.parse(response.text) as T;
  } catch {
    return null;
  }
}
