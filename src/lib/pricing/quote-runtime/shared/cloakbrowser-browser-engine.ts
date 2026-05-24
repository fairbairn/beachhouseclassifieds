import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  launch as launchCloakBrowser,
  launchPersistentContext as launchPersistentCloakContext,
} from "cloakbrowser";

type BrowserProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

type RequestResponseLike = {
  text(): Promise<string>;
  status(): number;
  ok(): boolean;
};

type RequestClientLike = {
  post(
    endpoint: string,
    options: {
      headers: Record<string, string>;
      data: string;
      timeout: number;
    },
  ): Promise<RequestResponseLike>;
};

type BrowserPageLike = {
  goto(
    url: string,
    options: { waitUntil: "commit" | "domcontentloaded"; timeout: number },
  ): Promise<unknown>;
  close(): Promise<void>;
};

type BrowserContextLike = {
  request: RequestClientLike;
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
};

type BrowserLike = {
  newContext(options: {
    userAgent: string;
    ignoreHTTPSErrors: boolean;
  }): Promise<BrowserContextLike>;
  close(): Promise<void>;
};

const persistentProfileLocks = new Map<string, Promise<void>>();

export type BrowserEnginePostResult = {
  httpStatus: number;
  ok: boolean;
  bodyText: string;
  requestError: string | null;
};

function normalizeEnvPrefix(adapterKey: string): string {
  return adapterKey
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
}

function readToggle(name: string): boolean | null {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  return null;
}

function shouldUsePersistentProfile(input: {
  adapterKey: string;
  requested: boolean;
}): boolean {
  const envPrefix = normalizeEnvPrefix(input.adapterKey);
  const adapterOverride = readToggle(`${envPrefix}_PERSISTENT_PROFILE`);
  if (adapterOverride !== null) {
    return adapterOverride;
  }

  const globalOverride = readToggle("STREAMLINE_PERSISTENT_PROFILE");
  if (globalOverride !== null) {
    return globalOverride;
  }

  return input.requested;
}

function resolvePersistentProfileDir(input: {
  adapterKey: string;
  listingId: string;
}): string {
  const envPrefix = normalizeEnvPrefix(input.adapterKey);
  const configuredRoot =
    process.env[`${envPrefix}_PERSISTENT_PROFILE_DIR`]?.trim() ||
    process.env.STREAMLINE_PERSISTENT_PROFILE_DIR?.trim() ||
    ".tmp/cloak-profiles";

  const listingSegment = input.listingId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");

  return resolve(
    process.cwd(),
    configuredRoot,
    input.adapterKey.toLowerCase(),
    listingSegment,
  );
}

function resolveWarmupMarkerPath(profileDir: string): string {
  return resolve(profileDir, ".warmup-http2-complete");
}

async function shouldWarmupWithHttp2Disabled(input: {
  adapterKey: string;
  profileDir: string;
}): Promise<boolean> {
  const envPrefix = normalizeEnvPrefix(input.adapterKey);
  const adapterSetting = readToggle(
    `${envPrefix}_PERSISTENT_PROFILE_WARMUP_ONCE`,
  );
  const globalSetting = readToggle("STREAMLINE_PERSISTENT_PROFILE_WARMUP_ONCE");
  const warmupOnceEnabled = adapterSetting ?? globalSetting ?? true;

  if (!warmupOnceEnabled) {
    return false;
  }

  try {
    await access(resolveWarmupMarkerPath(input.profileDir));
    return false;
  } catch {
    return true;
  }
}

async function acquirePersistentProfileLock(
  profileKey: string,
): Promise<() => void> {
  const previous = persistentProfileLocks.get(profileKey) ?? Promise.resolve();
  let releaseLock: (() => void) | null = null;
  const gate = new Promise<void>((resolveGate) => {
    releaseLock = resolveGate;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  persistentProfileLocks.set(profileKey, tail);
  await previous.catch(() => undefined);

  return () => {
    releaseLock?.();
    if (persistentProfileLocks.get(profileKey) === tail) {
      persistentProfileLocks.delete(profileKey);
    }
  };
}

function resolveProxy(useProxy: boolean): BrowserProxyConfig | null {
  if (!useProxy) {
    return null;
  }

  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    process.env.https_proxy ??
    process.env.http_proxy;
  const normalized = proxy?.trim();
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

export async function postJsonViaCloakBrowserEngine(input: {
  adapterKey: string;
  listingId: string;
  detailUrl: string;
  endpoint: string;
  timeoutMs: number;
  userAgent: string;
  headers: Record<string, string>;
  body: unknown;
  useProxy: boolean;
  enablePersistentProfile?: boolean;
}): Promise<BrowserEnginePostResult> {
  const proxy = resolveProxy(input.useProxy);
  const usePersistentProfile = shouldUsePersistentProfile({
    adapterKey: input.adapterKey,
    requested: input.enablePersistentProfile === true,
  });

  let browser: BrowserLike | null = null;
  let context: BrowserContextLike | null = null;
  let releaseProfileLock: (() => void) | null = null;
  let shouldWriteWarmupMarker = false;
  let warmupMarkerPath: string | null = null;

  try {
    if (usePersistentProfile) {
      const userDataDir = resolvePersistentProfileDir({
        adapterKey: input.adapterKey,
        listingId: input.listingId,
      });
      const profileKey = `${input.adapterKey.toLowerCase()}::${input.listingId.toLowerCase()}`;
      releaseProfileLock = await acquirePersistentProfileLock(profileKey);
      await mkdir(userDataDir, { recursive: true });

      shouldWriteWarmupMarker = await shouldWarmupWithHttp2Disabled({
        adapterKey: input.adapterKey,
        profileDir: userDataDir,
      });
      warmupMarkerPath = shouldWriteWarmupMarker
        ? resolveWarmupMarkerPath(userDataDir)
        : null;

      const args = shouldWriteWarmupMarker ? ["--disable-http2"] : [];
      context = (await launchPersistentCloakContext({
        userDataDir,
        headless: true,
        userAgent: input.userAgent,
        ...(args.length > 0 ? { args } : {}),
        ...(proxy ? { proxy } : {}),
      })) as BrowserContextLike;
    } else {
      browser = (await launchCloakBrowser({
        headless: true,
        ...(proxy ? { proxy } : {}),
      })) as BrowserLike;

      context = await browser.newContext({
        userAgent: input.userAgent,
        ignoreHTTPSErrors: false,
      });
    }

    try {
      const page = await context.newPage();
      try {
        await page.goto(input.detailUrl, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(120000, Math.max(15000, input.timeoutMs * 2)),
        });
        if (shouldWriteWarmupMarker && warmupMarkerPath) {
          await writeFile(
            warmupMarkerPath,
            `${new Date().toISOString()}\n`,
            "utf8",
          );
          shouldWriteWarmupMarker = false;
        }
      } finally {
        await page.close();
      }

      const response = await context.request.post(input.endpoint, {
        headers: input.headers,
        data: JSON.stringify(input.body),
        timeout: input.timeoutMs,
      });

      return {
        httpStatus: response.status(),
        ok: response.ok(),
        bodyText: await response.text(),
        requestError: null,
      };
    } finally {
      await context.close();
    }
  } catch (error: unknown) {
    return {
      httpStatus: 0,
      ok: false,
      bodyText: "",
      requestError:
        error instanceof Error
          ? error.message
          : "Unknown browser request error",
    };
  } finally {
    if (releaseProfileLock) {
      releaseProfileLock();
    }
    if (browser) {
      await browser.close();
    }
  }
}
