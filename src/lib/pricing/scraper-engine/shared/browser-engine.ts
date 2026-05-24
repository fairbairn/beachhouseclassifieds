type LaunchInput = {
  adapterKey: string;
  envPrefix: string;
  headless?: boolean;
  useProxy?: boolean;
};

type BrowserProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

type PageGotoResponseLike = {
  status(): number;
};

export type ScraperBrowserPageLike = {
  goto(
    url: string,
    options?: { waitUntil?: "commit" | "domcontentloaded"; timeout?: number },
  ): Promise<PageGotoResponseLike | null>;
  content(): Promise<string>;
  url(): string;
  close(): Promise<void>;
};

export type ScraperBrowserLike = {
  newPage(): Promise<ScraperBrowserPageLike>;
  close(): Promise<void>;
};

function resolveProxyConfig(
  rawProxy: string | undefined,
): BrowserProxyConfig | null {
  const normalized = rawProxy?.trim();
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    const server = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    const username = parsed.username
      ? decodeURIComponent(parsed.username)
      : undefined;
    const password = parsed.password
      ? decodeURIComponent(parsed.password)
      : undefined;

    return {
      server,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };
  } catch {
    return { server: normalized };
  }
}

export async function launchScraperBrowser(
  input: LaunchInput,
): Promise<ScraperBrowserLike> {
  const cloakBrowserModule = (await import("cloakbrowser")) as {
    launch: (options?: Record<string, unknown>) => Promise<ScraperBrowserLike>;
  };

  const proxy = input.useProxy
    ? (process.env.HTTPS_PROXY ??
      process.env.HTTP_PROXY ??
      process.env.https_proxy ??
      process.env.http_proxy)
    : undefined;
  const resolvedProxy = resolveProxyConfig(proxy);

  return cloakBrowserModule.launch({
    headless: input.headless ?? true,
    ...(resolvedProxy ? { proxy: resolvedProxy } : {}),
  });
}
