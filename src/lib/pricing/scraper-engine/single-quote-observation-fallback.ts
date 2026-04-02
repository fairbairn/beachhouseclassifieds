import { performance } from "node:perf_hooks";
import type {
  SingleQuoteObservationInput,
  SingleQuoteObservationResult,
} from "./types";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function parseMoneyFromText(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, "").trim();
  if (!cleaned) {
    return null;
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildQ4vrGuests(
  handoffUrl: string,
  adults: number,
  children: number,
): string {
  const safeAdults = Math.max(1, Math.floor(adults));
  const safeChildren = Math.max(0, Math.floor(children));

  try {
    const parsed = new URL(handoffUrl);
    const handoffGuests = parsed.searchParams.get("guests")?.trim() ?? "";
    if (handoffGuests && !handoffGuests.includes(",")) {
      return String(Math.max(1, safeAdults + safeChildren));
    }
  } catch {
    // fall through
  }

  return `${safeAdults},${safeChildren},0`;
}

function parseRcapiContext(handoffUrl: string): {
  eid: string | null;
  idsTuple: string | null;
} {
  try {
    const parsed = new URL(handoffUrl);
    const eid =
      parsed.searchParams.get("rcav[eid]") ?? parsed.searchParams.get("eid");
    const idsTuple = parsed.searchParams.get("rcav[IDs][8][]") ?? null;
    return {
      eid: eid?.trim() || null,
      idsTuple: idsTuple?.trim() || null,
    };
  } catch {
    return {
      eid: null,
      idsTuple: null,
    };
  }
}

function parseNrbeParamsFromHandoff(handoffUrl: string): {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
} | null {
  try {
    const parsed = new URL(handoffUrl);
    const fragment = parsed.hash.startsWith("#")
      ? parsed.hash.slice(1)
      : parsed.hash;
    const hash = new URLSearchParams(fragment);
    const payloadRaw = hash.get("payload") ?? "";
    if (!payloadRaw) {
      return null;
    }
    const payload = JSON.parse(payloadRaw) as Record<string, unknown>;
    const unitId = String(payload.unitId ?? "").trim();
    const arrivalDate = String(payload.arrivalDate ?? "").trim();
    const departureDate = String(payload.departureDate ?? "").trim();
    if (!unitId || !arrivalDate || !departureDate) {
      return null;
    }
    return { unitId, arrivalDate, departureDate };
  } catch {
    return null;
  }
}

async function runQ4vrQuoteObservation(
  input: SingleQuoteObservationInput,
): Promise<SingleQuoteObservationResult> {
  const handoffUrl = input.handoffUrl ?? "";
  const detailUrl = new URL(input.detailUrl);
  const baseHost = detailUrl.origin;
  const endpointUrl = `${baseHost}/wp-admin/admin-ajax.php`;
  const handoff = new URL(handoffUrl, baseHost);
  const unitCode = handoff.searchParams.get("unit_code")?.trim() ?? "";
  const guests = buildQ4vrGuests(handoffUrl, input.adults, input.children);

  if (!unitCode) {
    return {
      elapsedMs: 0,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: false,
        currency: null,
        baseTotal: null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: null,
        quotedTotal: null,
        handoffUrl: handoffUrl || null,
        reason: "missing_unit_code",
      },
    };
  }

  const params = new URLSearchParams();
  params.set("post_type", "vacation_rental");
  params.set("s", "");
  params.set("action", "q4vr_stay");
  params.set("unit_code", unitCode);
  params.set("start_date", input.checkInIso);
  params.set("end_date", input.checkOutIso);
  params.set("guests", guests);

  const startedAt = performance.now();
  try {
    const response = await fetch(`${endpointUrl}?${params.toString()}`, {
      method: "GET",
      headers: {
        accept: "application/json, text/javascript, */*; q=0.01",
        "user-agent": USER_AGENT,
        referer: input.detailUrl,
        origin: baseHost,
      },
    });

    if (!response.ok) {
      return {
        elapsedMs: performance.now() - startedAt,
        observation: {
          startDate: input.checkInIso,
          endDate: input.checkOutIso,
          quoteAvailable: false,
          currency: null,
          baseTotal: null,
          taxesTotal: null,
          feesTotalExclTaxes: null,
          grandTotal: null,
          quotedTotal: null,
          handoffUrl: handoffUrl || null,
          reason: `http_${response.status}`,
        },
      };
    }

    const payload = (await response.json()) as {
      success?: unknown;
      data?: unknown;
    };
    const elapsedMs = performance.now() - startedAt;
    const fragment = typeof payload.data === "string" ? payload.data : "";
    const success =
      payload.success === true && fragment.includes("total-price");
    const totalMatch = fragment.match(
      /id=["']total-price["'][^>]*>\s*\$?([0-9,]+(?:\.[0-9]{2})?)/i,
    );
    const quotedTotal = totalMatch?.[1]
      ? parseMoneyFromText(totalMatch[1])
      : null;

    return {
      elapsedMs,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: success,
        currency: quotedTotal !== null ? "USD" : null,
        baseTotal: null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: quotedTotal,
        quotedTotal,
        handoffUrl: handoffUrl || null,
        reason: success ? null : "quote_fragment_missing_total",
      },
    };
  } catch (error) {
    return {
      elapsedMs: performance.now() - startedAt,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: false,
        currency: null,
        baseTotal: null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: null,
        quotedTotal: null,
        handoffUrl: handoffUrl || null,
        reason: error instanceof Error ? error.message : "request_failed",
      },
    };
  }
}

async function runRcapiQuoteObservation(
  input: SingleQuoteObservationInput,
): Promise<SingleQuoteObservationResult> {
  const endpointPath = input.endpointPath ?? "";
  const handoffUrl = input.handoffUrl ?? "";
  const detailUrl = new URL(input.detailUrl);
  const baseHost = detailUrl.origin;
  const endpoint = endpointPath.startsWith("/")
    ? `${baseHost}${endpointPath}`
    : `${baseHost}/${endpointPath}`;

  const rcapiContext = parseRcapiContext(handoffUrl);
  if (!rcapiContext.eid || !rcapiContext.idsTuple) {
    return {
      elapsedMs: 0,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: false,
        currency: null,
        baseTotal: null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: null,
        quotedTotal: null,
        handoffUrl: handoffUrl || null,
        reason: "missing_rcapi_context",
      },
    };
  }

  const params = new URLSearchParams();
  params.set("rcav[begin]", toUsDate(input.checkInIso));
  params.set("rcav[end]", toUsDate(input.checkOutIso));
  params.set("rcav[adult]", String(input.adults));
  params.set("rcav[child]", String(input.children));
  params.set("rcav[eid]", rcapiContext.eid);
  params.append("rcav[IDs][8][]", rcapiContext.idsTuple);
  params.set("eid", rcapiContext.eid);

  const startedAt = performance.now();
  try {
    const response = await fetch(`${endpoint}?${params.toString()}`, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": USER_AGENT,
        referer: input.detailUrl,
      },
    });

    if (!response.ok) {
      return {
        elapsedMs: performance.now() - startedAt,
        observation: {
          startDate: input.checkInIso,
          endDate: input.checkOutIso,
          quoteAvailable: false,
          currency: null,
          baseTotal: null,
          taxesTotal: null,
          feesTotalExclTaxes: null,
          grandTotal: null,
          quotedTotal: null,
          handoffUrl: handoffUrl || null,
          reason: `http_${response.status}`,
        },
      };
    }

    const payload = (await response.json()) as unknown;
    const elapsedMs = performance.now() - startedAt;
    const rows = Array.isArray(payload)
      ? (payload as Array<{ prices?: Array<{ p?: unknown }> }>)
      : [];
    const amount = Number(rows[0]?.prices?.[0]?.p ?? "");
    const success = Number.isFinite(amount) && amount > 0;

    return {
      elapsedMs,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: success,
        currency: success ? "USD" : null,
        baseTotal: success ? amount : null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: success ? amount : null,
        quotedTotal: success ? amount : null,
        handoffUrl: handoffUrl || null,
        reason: success ? null : "rcapi_missing_total",
      },
    };
  } catch (error) {
    return {
      elapsedMs: performance.now() - startedAt,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: false,
        currency: null,
        baseTotal: null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: null,
        quotedTotal: null,
        handoffUrl: handoffUrl || null,
        reason: error instanceof Error ? error.message : "request_failed",
      },
    };
  }
}

async function runNrbeQuoteObservation(
  input: SingleQuoteObservationInput,
): Promise<SingleQuoteObservationResult> {
  const endpointPath = input.endpointPath ?? "";
  const handoffUrl = input.handoffUrl ?? "";
  const detailUrl = new URL(input.detailUrl);
  const baseHost = detailUrl.origin;
  const endpoint = endpointPath.startsWith("/")
    ? `${baseHost}${endpointPath}`
    : `${baseHost}/${endpointPath}`;
  const params = parseNrbeParamsFromHandoff(handoffUrl);

  if (!params) {
    return {
      elapsedMs: 0,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: false,
        currency: null,
        baseTotal: null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: null,
        quotedTotal: null,
        handoffUrl: handoffUrl || null,
        reason: "missing_nrbe_context",
      },
    };
  }

  const query = new URLSearchParams();
  query.set("unitId", params.unitId);
  query.set("arrivalDate", params.arrivalDate);
  query.set("departureDate", params.departureDate);
  query.set("adults", String(input.adults));
  query.set("children", String(input.children));

  const startedAt = performance.now();
  try {
    const response = await fetch(`${endpoint}?${query.toString()}`, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": USER_AGENT,
        referer: input.detailUrl,
      },
    });

    if (!response.ok) {
      return {
        elapsedMs: performance.now() - startedAt,
        observation: {
          startDate: input.checkInIso,
          endDate: input.checkOutIso,
          quoteAvailable: false,
          currency: null,
          baseTotal: null,
          taxesTotal: null,
          feesTotalExclTaxes: null,
          grandTotal: null,
          quotedTotal: null,
          handoffUrl: handoffUrl || null,
          reason: `http_${response.status}`,
        },
      };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const elapsedMs = performance.now() - startedAt;
    const total = Number(payload.total ?? "");
    const subTotal = Number(payload.subTotal ?? payload.subtotal ?? "");
    const taxes = Number(payload.taxes ?? "");
    const success =
      Number.isFinite(total) && total > 0 && Number.isFinite(subTotal);

    return {
      elapsedMs,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: success,
        currency: success ? "USD" : null,
        baseTotal: Number.isFinite(subTotal) ? subTotal : null,
        taxesTotal: Number.isFinite(taxes) ? taxes : null,
        feesTotalExclTaxes:
          Number.isFinite(total) &&
          Number.isFinite(subTotal) &&
          Number.isFinite(taxes)
            ? Math.max(0, total - subTotal - taxes)
            : null,
        grandTotal: Number.isFinite(total) ? total : null,
        quotedTotal: Number.isFinite(total) ? total : null,
        handoffUrl: handoffUrl || null,
        reason: success ? null : "nrbe_missing_total",
      },
    };
  } catch (error) {
    return {
      elapsedMs: performance.now() - startedAt,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: false,
        currency: null,
        baseTotal: null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: null,
        quotedTotal: null,
        handoffUrl: handoffUrl || null,
        reason: error instanceof Error ? error.message : "request_failed",
      },
    };
  }
}

export async function runFallbackSingleQuoteObservation(
  input: SingleQuoteObservationInput,
): Promise<SingleQuoteObservationResult> {
  const endpointPath = input.endpointPath ?? "";

  if (endpointPath.includes("q4vr_stay")) {
    return runQ4vrQuoteObservation(input);
  }
  if (endpointPath.includes("/rcapi/item/avail/search")) {
    return runRcapiQuoteObservation(input);
  }
  if (endpointPath.includes("/api/nrbe/reservation-quotes.json")) {
    return runNrbeQuoteObservation(input);
  }

  return {
    elapsedMs: 0,
    observation: {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: false,
      currency: null,
      baseTotal: null,
      taxesTotal: null,
      feesTotalExclTaxes: null,
      grandTotal: null,
      quotedTotal: null,
      handoffUrl: input.handoffUrl ?? null,
      reason: `unsupported_endpoint:${endpointPath || "missing_endpoint_path"}`,
    },
  };
}
