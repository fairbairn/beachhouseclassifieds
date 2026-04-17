const MODAL_INTENT_TTL_MS = 60_000;

type DiscoverModalIntent = {
  slug: string;
  expiresAt: number;
};

let discoverModalIntent: DiscoverModalIntent | null = null;

export function markDiscoverModalIntent(slug: string) {
  const normalizedSlug = slug.trim();
  if (!normalizedSlug) {
    return;
  }

  discoverModalIntent = {
    slug: normalizedSlug,
    expiresAt: Date.now() + MODAL_INTENT_TTL_MS,
  };
}

export function hasDiscoverModalIntentForSlug(slug: string) {
  const normalizedSlug = slug.trim();
  if (!normalizedSlug) {
    return false;
  }

  if (!discoverModalIntent) {
    return false;
  }

  if (discoverModalIntent.expiresAt <= Date.now()) {
    discoverModalIntent = null;
    return false;
  }

  return discoverModalIntent.slug === normalizedSlug;
}

export function hasDiscoverModalIntentForPath(pathname: string) {
  const match = pathname.match(/^\/discover\/listing\/(.+)$/);
  if (!match || !match[1]) {
    return false;
  }

  try {
    return hasDiscoverModalIntentForSlug(decodeURIComponent(match[1]));
  } catch {
    return hasDiscoverModalIntentForSlug(match[1]);
  }
}
