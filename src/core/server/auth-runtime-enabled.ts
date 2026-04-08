function toBoolean(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return null;
}

export function isAuthRuntimeEnabled() {
  const explicit = toBoolean(process.env.AUTH_RUNTIME_ENABLED);

  if (explicit !== null) {
    return explicit;
  }

  // Keep auth opt-in for production deploys unless explicitly enabled.
  if (process.env.NODE_ENV === "production") {
    return false;
  }

  const provider = process.env.DATABASE_PROVIDER?.trim().toLowerCase();
  const hasDatabaseUrl = Boolean(process.env.DATABASE_URL?.trim());

  // For Postgres deployments, require a connection string unless explicitly overridden.
  if (provider === "postgres") {
    return hasDatabaseUrl;
  }

  // In local/dev, keep auth available by default.
  return true;
}
