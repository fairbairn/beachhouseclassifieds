import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type AdapterProxyPolicy = {
  USE_PROXY?: string[];
};

let cachedPolicy: AdapterProxyPolicy | null = null;

function normalizeAdapterKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizeAdapterKey(entry))
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(normalized));
}

function resolvePolicyPath(): string {
  return resolve(
    process.cwd(),
    "src",
    "lib",
    "pricing",
    "proxy",
    "adapter-proxy-policy.json",
  );
}

function readPolicyFromDisk(): AdapterProxyPolicy {
  try {
    const raw = readFileSync(resolvePolicyPath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      USE_PROXY: normalizeStringList(parsed.USE_PROXY),
    };
  } catch {
    return {
      USE_PROXY: [],
    };
  }
}

function getPolicy(): AdapterProxyPolicy {
  if (!cachedPolicy) {
    cachedPolicy = readPolicyFromDisk();
  }
  return cachedPolicy;
}

export function shouldAdapterUseProxy(adapterKeyInput: string): boolean {
  const adapterKey = normalizeAdapterKey(adapterKeyInput);
  if (!adapterKey) {
    return false;
  }

  const policy = getPolicy();
  return (policy.USE_PROXY ?? []).includes(adapterKey);
}
