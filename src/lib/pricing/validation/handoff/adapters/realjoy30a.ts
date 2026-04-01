export function parseMoney(value: string): number | null {
  const parsed = Number(value.replace(/[^0-9.-]+/g, "").trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.round(parsed * 100) / 100;
}

export function toUsDateFromIso(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

export function extractRealjoyPropertyName(detailHtml: string): string {
  const h1Match = detailHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!h1Match?.[1]) {
    return "";
  }
  return h1Match[1]
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildRealjoyQuoteRequestBody(input: {
  startDate: string;
  endDate: string;
  propertyId: string;
  propertyName: string;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("checkin", toUsDateFromIso(input.startDate));
  body.set("checkout", toUsDateFromIso(input.endDate));
  body.set("propertyID", input.propertyId);
  body.set("roomTypeID", "");
  body.set("propertyName", input.propertyName);
  body.set("hash", "");
  return body;
}

export function parseRealjoyPriceByLabel(
  html: string,
  label: string,
): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<span\\s+class="(?:pdp|book)-quote-item-text">\\s*${escaped}\\s*<\\/span>[\\s\\S]*?<span\\s+class="(?:pdp|book)-quote-item-price"\\s+data-price="([^"]+)"`,
      "i",
    ),
    new RegExp(`${escaped}[\\s\\S]{0,240}?data-price="([0-9,.-]+)"`, "i"),
  ];

  for (const pattern of patterns) {
    const value = pattern.exec(html)?.[1] ?? "";
    const parsed = parseMoney(value);
    if (parsed !== null && parsed >= 0) {
      return parsed;
    }
  }

  return null;
}

export function parseRealjoyRenderedTotal(html: string): number | null {
  const byLabel = parseRealjoyPriceByLabel(html, "Total");
  if (byLabel !== null) {
    return byLabel;
  }

  const byDataPrice = html.match(
    /class="(?:[^"]*\s)?(?:book|pdp)-quote-item-price(?:\s[^"]*)?"[^>]*data-price="([0-9,.-]+)"[^>]*>[\s\S]*?<sup>\.[0-9]{2}<\/sup>/i,
  )?.[1];
  if (byDataPrice) {
    const parsed = parseMoney(byDataPrice);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}
