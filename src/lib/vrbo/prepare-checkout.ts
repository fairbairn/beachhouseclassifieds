export const VRBO_PREPARE_CHECKOUT_OPERATION =
  "lodgingPropertyCheckoutPrepareCheckout";

type UnknownRecord = Record<string, unknown>;

export interface GraphqlOperation {
  operationName?: string;
  query?: string;
  variables?: unknown;
  extensions?: unknown;
}

export interface GraphqlRequestSnapshot {
  url: string;
  operationName?: string;
  body: unknown;
}

export interface GraphqlResponseSnapshot {
  url: string;
  status: number;
  body: unknown;
}

export interface VrbPrepareCheckoutCapture {
  request: GraphqlRequestSnapshot;
  response: GraphqlResponseSnapshot;
  prepareCheckoutNode: unknown;
  summary: Record<string, unknown>;
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function pickOperationName(operation: GraphqlOperation): string {
  if (typeof operation.operationName === "string") {
    return operation.operationName;
  }

  if (typeof operation.query === "string") {
    if (operation.query.includes(VRBO_PREPARE_CHECKOUT_OPERATION)) {
      return VRBO_PREPARE_CHECKOUT_OPERATION;
    }
  }

  return "";
}

export function parseGraphqlPostData(postData: string): GraphqlOperation[] {
  if (!postData) {
    return [];
  }

  try {
    const parsed = JSON.parse(postData) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(isObject) as GraphqlOperation[];
    }

    if (isObject(parsed)) {
      return [parsed as GraphqlOperation];
    }
  } catch {
    // Some requests may use non-JSON post bodies.
  }

  return [];
}

export function isPrepareCheckoutOperation(
  operation: GraphqlOperation,
): boolean {
  const name = pickOperationName(operation);
  if (name === VRBO_PREPARE_CHECKOUT_OPERATION) {
    return true;
  }

  if (typeof operation.query === "string") {
    return operation.query.includes(VRBO_PREPARE_CHECKOUT_OPERATION);
  }

  return false;
}

export function extractPrepareCheckoutNode(responseJson: unknown): unknown {
  if (!isObject(responseJson)) {
    return null;
  }

  const data = responseJson.data;
  if (!isObject(data)) {
    return null;
  }

  if (VRBO_PREPARE_CHECKOUT_OPERATION in data) {
    return data[VRBO_PREPARE_CHECKOUT_OPERATION as keyof typeof data] ?? null;
  }

  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return null;
}

function looksLikeMoney(value: unknown): value is UnknownRecord {
  if (!isObject(value)) {
    return false;
  }

  const amountKeys = ["amount", "value", "raw", "micros", "units"];
  const hasAmount = amountKeys.some((key) => toNumber(value[key]) !== null);
  const hasCurrency =
    typeof value.currency === "string" ||
    typeof value.currencyCode === "string";

  return hasAmount && hasCurrency;
}

function collectNamedMoney(
  node: unknown,
  path: string[] = [],
  out: Array<{ path: string; value: unknown }> = [],
): Array<{ path: string; value: unknown }> {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => {
      collectNamedMoney(entry, [...path, String(index)], out);
    });
    return out;
  }

  if (!isObject(node)) {
    return out;
  }

  for (const [key, value] of Object.entries(node)) {
    const nextPath = [...path, key];
    const keyMatches =
      /(total|subtotal|tax|fee|night|deposit|price|rent)/i.test(key);

    if (keyMatches && (looksLikeMoney(value) || typeof value === "number")) {
      out.push({ path: nextPath.join("."), value });
    }

    collectNamedMoney(value, nextPath, out);
  }

  return out;
}

export function summarizePrepareCheckoutNode(
  node: unknown,
): Record<string, unknown> {
  if (!isObject(node)) {
    return {
      found: false,
    };
  }

  const checkoutSession = isObject(node.checkoutSession)
    ? (node.checkoutSession as UnknownRecord)
    : null;

  const price =
    (checkoutSession && isObject(checkoutSession.price)
      ? (checkoutSession.price as UnknownRecord)
      : null) || (isObject(node.price) ? (node.price as UnknownRecord) : null);

  const lineItems =
    (price && Array.isArray(price.lineItems) ? price.lineItems : null) ||
    (checkoutSession && Array.isArray(checkoutSession.lineItems)
      ? checkoutSession.lineItems
      : null) ||
    (Array.isArray(node.lineItems) ? node.lineItems : null);

  const totals = collectNamedMoney(node).slice(0, 40);

  return {
    found: true,
    checkoutSessionId:
      (checkoutSession?.id as string | undefined) ??
      (checkoutSession?.sessionId as string | undefined) ??
      null,
    currency:
      (price?.currencyCode as string | undefined) ??
      (price?.currency as string | undefined) ??
      null,
    total:
      (price?.total as unknown) ??
      (price?.totalPrice as unknown) ??
      (checkoutSession?.total as unknown) ??
      null,
    subtotal: (price?.subtotal as unknown) ?? (price?.base as unknown) ?? null,
    taxes:
      (price?.taxes as unknown) ??
      (price?.tax as unknown) ??
      (price?.taxTotal as unknown) ??
      null,
    fees:
      (price?.fees as unknown) ??
      (price?.feeTotal as unknown) ??
      (price?.serviceFees as unknown) ??
      null,
    nightlyRate:
      (price?.nightlyRate as unknown) ??
      (price?.nightly as unknown) ??
      (price?.rate as unknown) ??
      null,
    deposit:
      (price?.deposit as unknown) ??
      (checkoutSession?.deposit as unknown) ??
      null,
    lineItemCount: Array.isArray(lineItems) ? lineItems.length : 0,
    lineItems: Array.isArray(lineItems) ? lineItems : [],
    totalsByPath: totals,
  };
}
