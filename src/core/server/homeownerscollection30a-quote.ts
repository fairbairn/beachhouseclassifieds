type HomeownersFeeLine = {
  name: string;
  amount: number;
};

type BuyPageChargeSummary = {
  base_total: number | null;
  taxes_total: number | null;
  fees_total_excl_taxes: number | null;
  fee_lines: HomeownersFeeLine[];
  grand_total: number | null;
};

type RcapiPriceNode = {
  p?: string;
  c?: string;
  dn?: string | null;
  qp?: {
    rcav?: {
      begin?: string;
      end?: string;
      adult?: string;
      child?: string;
      eid?: string;
      coupon?: string;
      IDs?: Record<string, string[]>;
    };
    special_data?: {
      processor?: string;
      special_nid?: string;
    };
    eid?: number;
  };
};

type RcapiSearchItem = {
  eid?: number;
  prices?: RcapiPriceNode[];
};

export type HomeownersCheckoutQuote = {
  entity_id: number;
  start_date: string;
  end_date: string;
  nights: number;
  quote_available: boolean;
  currency: string;
  quoted_total: number | null;
  discount_name: string | null;
  buy_url: string | null;
  base_total: number | null;
  taxes_total: number | null;
  fees_total_excl_taxes: number | null;
  fee_lines: HomeownersFeeLine[];
  grand_total: number | null;
  nightly_rate_proxy: number | null;
  reliability:
    | "buy_page_charges"
    | "rcapi_total_proxy"
    | "unavailable"
    | "parse_failed";
  latency_ms: number;
};

export type FetchHomeownersCheckoutQuoteInput = {
  entityId: number;
  detailUrl: string;
  checkInIso: string;
  checkOutIso: string;
  couponCode?: string;
  adults?: number;
  children?: number;
  fetchBuyPage?: boolean;
};

const HOMEOWNERS_ORIGIN = "https://homeownerscollection.com";
const HOMEOWNERS_RCAPI_PATH = "/rcapi/item/avail/search";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function parseUsdAmountFromText(value: string): number | null {
  const matches = Array.from(value.matchAll(/\$([0-9][0-9,]*\.[0-9]{2})/g));
  const match = matches[matches.length - 1];
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number((match[1] ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? roundCurrency(parsed) : null;
}

function decodeMinimalEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseBuyPageChargeSummary(html: string): BuyPageChargeSummary | null {
  const wrapperMatch = html.match(
    /<div id="charges-wrapper"[\s\S]*?<\/fieldset>\s*<\/div>/i,
  );
  const wrapper = wrapperMatch?.[0] ?? "";
  if (!wrapper) {
    return null;
  }

  const feeLines: HomeownersFeeLine[] = [];
  let baseTotal: number | null = null;
  let taxesTotal: number | null = null;
  let grandTotal: number | null = null;

  const rows = wrapper.matchAll(/<tr class="([^"]*)">([\s\S]*?)<\/tr>/gi);
  for (const row of rows) {
    const rowClass = (row[1] ?? "").toLowerCase();
    const rowHtml = row[2] ?? "";
    const amount = parseUsdAmountFromText(rowHtml);
    if (amount === null) {
      continue;
    }

    const text = decodeMinimalEntities(stripHtml(rowHtml));
    const normalizedText = text.toLowerCase();

    if (rowClass.includes("line-item")) {
      if (normalizedText.includes("lodging:")) {
        baseTotal = amount;
        continue;
      }

      const feeName = text
        .replace(/you save\s+\$[0-9,]+\.[0-9]{2}/gi, "")
        .replace(/show details \+/gi, "")
        .replace(/hide details -/gi, "")
        .replace(/i accept this charge/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);

      if (feeName) {
        feeLines.push({ name: feeName, amount });
      }
      continue;
    }

    if (rowClass.includes("tax")) {
      taxesTotal = amount;
      continue;
    }

    if (rowClass.includes("total") && !rowClass.includes("sub-total")) {
      grandTotal = amount;
    }
  }

  const feesTotalExclTaxes =
    feeLines.length > 0
      ? roundCurrency(feeLines.reduce((sum, line) => sum + line.amount, 0))
      : null;

  return {
    base_total: baseTotal,
    taxes_total: taxesTotal,
    fees_total_excl_taxes: feesTotalExclTaxes,
    fee_lines: feeLines,
    grand_total: grandTotal,
  };
}

export function extractHomeownersEntityIdFromHtml(html: string): number | null {
  const patterns = [
    /rcav%5Beid%5D=(\d+)/i,
    /[?&]eid=(\d+)(?:&|"|')/i,
    /["']eid["']\s*:\s*(\d+)/i,
    /["']eid["']\s*:\s*["'](\d+)["']/i,
    /eid\\"\s*:\s*\\"(\d+)\\"/i,
    /\/rescms\/item\/(\d+)\/buy/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match?.[1]) {
      continue;
    }
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function buildBuyUrlFromQuote(
  fallbackEid: number,
  fallbackBeginIso: string,
  fallbackEndIso: string,
  quoteNode: RcapiPriceNode | null,
): string | null {
  const params = new URLSearchParams();
  const qp = quoteNode?.qp;
  const rcav = qp?.rcav;

  const begin = rcav?.begin?.trim() || toUsDate(fallbackBeginIso);
  const end = rcav?.end?.trim() || toUsDate(fallbackEndIso);
  const adult = rcav?.adult?.trim() || "1";
  const child = rcav?.child?.trim() || "0";
  const eidRaw = rcav?.eid?.trim() || String(qp?.eid ?? fallbackEid);
  const coupon = rcav?.coupon?.trim() ?? "";

  params.set("rcav[begin]", begin);
  params.set("rcav[end]", end);
  params.set("rcav[adult]", adult);
  params.set("rcav[child]", child);
  params.set("rcav[eid]", eidRaw);
  params.set("rcav[coupon]", coupon);

  let appendedIds = false;
  if (rcav?.IDs && typeof rcav.IDs === "object") {
    for (const [key, values] of Object.entries(rcav.IDs)) {
      for (const value of values ?? []) {
        if (typeof value === "string" && value.trim()) {
          params.append(`rcav[IDs][${key}][]`, value.trim());
          appendedIds = true;
        }
      }
    }
  }

  if (!appendedIds) {
    params.append("rcav[IDs][8][]", "0");
  }

  if (qp?.special_data?.processor) {
    params.set("special_data[processor]", qp.special_data.processor);
  }
  if (qp?.special_data?.special_nid) {
    params.set("special_data[special_nid]", qp.special_data.special_nid);
  }

  params.set("eid", eidRaw);
  return `${HOMEOWNERS_ORIGIN}/rescms/item/${eidRaw}/buy?${params.toString()}`;
}

async function fetchRcapiQuote(input: {
  eid: number;
  checkInIso: string;
  checkOutIso: string;
  couponCode: string;
  adults: number;
  children: number;
  referer: string;
}): Promise<{
  quote_available: boolean;
  currency: string;
  quoted_total: number | null;
  discount_name: string | null;
  quote_node: RcapiPriceNode | null;
}> {
  const params = new URLSearchParams();
  params.set("rcav[begin]", toUsDate(input.checkInIso));
  params.set("rcav[end]", toUsDate(input.checkOutIso));
  params.set("rcav[adult]", String(Math.max(1, Math.floor(input.adults))));
  params.set("rcav[child]", String(Math.max(0, Math.floor(input.children))));
  params.set("rcav[eid]", String(input.eid));
  params.set("rcav[coupon]", input.couponCode);
  params.set("rcav[flex]", "");
  params.set("rcav[flex_type]", "d");

  const url = `${HOMEOWNERS_ORIGIN}${HOMEOWNERS_RCAPI_PATH}?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
      referer: input.referer,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    return {
      quote_available: false,
      currency: "USD",
      quoted_total: null,
      discount_name: null,
      quote_node: null,
    };
  }

  const payload = (await response.json()) as unknown;
  const list = Array.isArray(payload) ? (payload as RcapiSearchItem[]) : [];
  const first = list[0];
  const priceNode = first?.prices?.[0] ?? null;
  const quotedTotalRaw = Number(priceNode?.p ?? "");
  const quotedTotal =
    Number.isFinite(quotedTotalRaw) && quotedTotalRaw > 0
      ? roundCurrency(quotedTotalRaw)
      : null;

  return {
    quote_available: quotedTotal !== null,
    currency: priceNode?.c?.trim() || "USD",
    quoted_total: quotedTotal,
    discount_name:
      typeof priceNode?.dn === "string" && priceNode.dn.trim().length > 0
        ? priceNode.dn.trim()
        : null,
    quote_node: priceNode,
  };
}

async function fetchBuyPageSummary(
  buyUrl: string,
  referer: string,
): Promise<BuyPageChargeSummary | null> {
  const response = await fetch(buyUrl, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      referer,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    return null;
  }

  const html = await response.text();
  return parseBuyPageChargeSummary(html);
}

export async function resolveHomeownersEntityIdFromDetailUrl(
  detailUrl: string,
): Promise<number | null> {
  const response = await fetch(detailUrl, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    return null;
  }

  const html = await response.text();
  return extractHomeownersEntityIdFromHtml(html);
}

export async function fetchHomeownersCheckoutQuote(
  input: FetchHomeownersCheckoutQuoteInput,
): Promise<HomeownersCheckoutQuote> {
  if (!isIsoDate(input.checkInIso) || !isIsoDate(input.checkOutIso)) {
    throw new Error(
      "checkInIso and checkOutIso must be ISO dates (YYYY-MM-DD)",
    );
  }

  const startMs = Date.now();
  const couponCode = input.couponCode ?? "INVALIDCODE";
  const adults = input.adults ?? 1;
  const children = input.children ?? 0;
  const fetchBuyPage = input.fetchBuyPage ?? true;

  const checkInMs = Date.parse(`${input.checkInIso}T00:00:00.000Z`);
  const checkOutMs = Date.parse(`${input.checkOutIso}T00:00:00.000Z`);
  const nightsRaw = Math.round((checkOutMs - checkInMs) / 86400000);
  const nights = Number.isFinite(nightsRaw) ? Math.max(0, nightsRaw) : 0;

  const quote = await fetchRcapiQuote({
    eid: input.entityId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    couponCode,
    adults,
    children,
    referer: input.detailUrl,
  });

  if (!quote.quote_available) {
    const buyUrl = buildBuyUrlFromQuote(
      input.entityId,
      input.checkInIso,
      input.checkOutIso,
      quote.quote_node,
    );
    return {
      entity_id: input.entityId,
      start_date: input.checkInIso,
      end_date: input.checkOutIso,
      nights,
      quote_available: false,
      currency: quote.currency,
      quoted_total: null,
      discount_name: quote.discount_name,
      buy_url: buyUrl,
      base_total: null,
      taxes_total: null,
      fees_total_excl_taxes: null,
      fee_lines: [],
      grand_total: null,
      nightly_rate_proxy: null,
      reliability: "unavailable",
      latency_ms: Date.now() - startMs,
    };
  }

  const buyUrl = buildBuyUrlFromQuote(
    input.entityId,
    input.checkInIso,
    input.checkOutIso,
    quote.quote_node,
  );

  const buySummary =
    fetchBuyPage && buyUrl
      ? await fetchBuyPageSummary(buyUrl, input.detailUrl)
      : null;

  const baseTotal =
    buySummary?.base_total ??
    (quote.quoted_total !== null ? roundCurrency(quote.quoted_total) : null);

  const nightlyRateProxy =
    baseTotal !== null && nights > 0 ? roundCurrency(baseTotal / nights) : null;

  return {
    entity_id: input.entityId,
    start_date: input.checkInIso,
    end_date: input.checkOutIso,
    nights,
    quote_available: true,
    currency: quote.currency,
    quoted_total: quote.quoted_total,
    discount_name: quote.discount_name,
    buy_url: buyUrl,
    base_total: baseTotal,
    taxes_total: buySummary?.taxes_total ?? null,
    fees_total_excl_taxes: buySummary?.fees_total_excl_taxes ?? null,
    fee_lines: buySummary?.fee_lines ?? [],
    grand_total: buySummary?.grand_total ?? null,
    nightly_rate_proxy: nightlyRateProxy,
    reliability:
      buySummary && buySummary.base_total !== null
        ? "buy_page_charges"
        : quote.quoted_total !== null
          ? "rcapi_total_proxy"
          : "parse_failed",
    latency_ms: Date.now() - startMs,
  };
}
