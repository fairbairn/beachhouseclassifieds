import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type ExclusionStatus = "active" | "probation" | "retired";

type ExclusionEntry = {
  id: string;
  status?: ExclusionStatus;
};

type ExclusionRegistry = {
  entries?: ExclusionEntry[];
};

function shouldBypassExclusions(): boolean {
  return process.env.SCRAPER_INCLUDE_EXCLUDED === "1";
}

function loadRegistry(adapterKey: string): ExclusionRegistry | null {
  const registryPath = resolve(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    adapterKey,
    "exclusions.lifecycle.json",
  );

  if (!existsSync(registryPath)) {
    return null;
  }

  try {
    const raw = readFileSync(registryPath, "utf8");
    return JSON.parse(raw) as ExclusionRegistry;
  } catch {
    return null;
  }
}

export function loadActiveExclusions(
  adapterKey: string,
  fallbackIds: string[] = [],
): Set<string> {
  if (shouldBypassExclusions()) {
    return new Set<string>();
  }

  const registry = loadRegistry(adapterKey);
  const entries = Array.isArray(registry?.entries) ? registry.entries : [];
  if (entries.length === 0) {
    return new Set(fallbackIds);
  }

  const activeIds = entries
    .filter((entry) => (entry.status ?? "active") === "active")
    .map((entry) => String(entry.id ?? "").trim())
    .filter((value) => value.length > 0);

  return new Set(activeIds);
}
