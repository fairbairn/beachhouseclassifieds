const legacySslModes = new Set(["prefer", "require", "verify-ca"]);

export function normalizePostgresConnectionString(connectionString: string) {
  const trimmedConnectionString = connectionString.trim();

  try {
    const parsed = new URL(trimmedConnectionString);
    const sslMode = parsed.searchParams.get("sslmode")?.trim().toLowerCase();

    if (!sslMode || !legacySslModes.has(sslMode)) {
      return trimmedConnectionString;
    }

    parsed.searchParams.set("sslmode", "verify-full");
    return parsed.toString();
  } catch {
    return trimmedConnectionString;
  }
}

export function resolvePostgresTlsMode(connectionString: string) {
  const normalized = normalizePostgresConnectionString(connectionString);

  try {
    const parsed = new URL(normalized);
    return (
      parsed.searchParams.get("sslmode")?.trim().toLowerCase() ?? "default"
    );
  } catch {
    return "unknown";
  }
}
