import bs58 from "bs58";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  brotliCompressSync,
  brotliDecompressSync,
  gunzipSync,
  gzipSync,
} from "node:zlib";
import secrets from "secrets.js-grempe";

export type EnvironmentBundleEnvelopeV1 = {
  v: 1;
  alg: "aes-256-gcm";
  comp?: "none" | "br" | "gz";
  ivHex: string;
  ctHex: string;
  tagHex: string;
  kid?: string;
};

export type EnvironmentBundleReference = {
  version: string;
  fingerprint: string;
};

export type EnvironmentTokenParts = {
  hash16: string;
  shareTwo: string;
  payloadBase58: string;
};

export type EnvironmentBundleMergePrecedence = "bundle-wins" | "env-wins";

export type LoadEnvironmentBundleIntoProcessEnvOptions = {
  allowlist?: readonly string[];
  mergePrecedence?: EnvironmentBundleMergePrecedence;
  processEnv?: NodeJS.ProcessEnv;
};

export type LoadEnvironmentBundleIntoProcessEnvResult = {
  loaded: boolean;
  appliedKeys: string[];
  skippedOverrideKeys: string[];
  mergePrecedence: EnvironmentBundleMergePrecedence;
};

const ENVIRONMENT_AAD = "beachhouseclassifieds.environment.v1";
const ENVIRONMENT_HKDF_SALT = "beachhouseclassifieds.environment.keysplit.v1";
const ENVIRONMENT_HKDF_INFO = "environment-bundle-aes256gcm-key";
const ENVIRONMENT_TOKEN_RE = /^([0-9a-fA-F]{16})\.([^\.]+)\.(.+)$/;

export const ENVIRONMENT_BUNDLE_DEFAULT_ALLOWLIST = [
  "APP_ENV_PROFILE",
  "REDIS_URL",
  "DATABASE_URL",
  "BUNNY_STORAGE_SECRET_ACCESS_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "IMAGE_FETCH_TIMEOUT_MS",
  "IMAGE_FETCH_RETRY_COUNT",
] as const;

function decodeHex(value: string, label: string): Buffer {
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(normalized)
  ) {
    throw new Error(`environment_bundle_invalid_${label}_hex`);
  }

  return Buffer.from(normalized, "hex");
}

function tryParseEnvelopeFromJson(
  raw: string,
): EnvironmentBundleEnvelopeV1 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<EnvironmentBundleEnvelopeV1>;

    if (parsed.v !== 1 || parsed.alg !== "aes-256-gcm") {
      return null;
    }

    if (!parsed.ivHex || !parsed.ctHex || !parsed.tagHex) {
      return null;
    }

    const comp =
      parsed.comp === undefined || parsed.comp === null ? "none" : parsed.comp;
    if (comp !== "none" && comp !== "br" && comp !== "gz") {
      return null;
    }

    return {
      v: 1,
      alg: "aes-256-gcm",
      comp,
      ivHex: parsed.ivHex,
      ctHex: parsed.ctHex,
      tagHex: parsed.tagHex,
      kid: parsed.kid,
    };
  } catch {
    return null;
  }
}

function parseEnvelope(rawEnvironment: string): EnvironmentBundleEnvelopeV1 {
  const tokenParts = parseEnvironmentToken(rawEnvironment);
  const trimmed = (tokenParts?.payloadBase58 || rawEnvironment).trim();
  if (!trimmed) {
    throw new Error("environment_bundle_empty");
  }

  const jsonDirect = tryParseEnvelopeFromJson(trimmed);
  if (jsonDirect) {
    return jsonDirect;
  }

  if (trimmed.length % 2 === 0 && /^[0-9a-f]+$/i.test(trimmed)) {
    const asHexJson = tryParseEnvelopeFromJson(
      Buffer.from(trimmed, "hex").toString("utf8"),
    );
    if (asHexJson) {
      return asHexJson;
    }
  }

  try {
    const asBase58Json = Buffer.from(bs58.decode(trimmed)).toString("utf8");
    const parsed = tryParseEnvelopeFromJson(asBase58Json);
    if (parsed) {
      return parsed;
    }
  } catch {
    // Ignore and fall through to a single standardized error.
  }

  throw new Error("environment_bundle_unrecognized_transport_or_shape");
}

function normalizePayload(
  payload: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) {
      continue;
    }
    out[key] = typeof value === "string" ? value : String(value);
  }

  return out;
}

function compressUtf8(
  plaintextUtf8: string,
  compression: "none" | "br" | "gz",
): Buffer {
  const source = Buffer.from(plaintextUtf8, "utf8");

  if (compression === "br") {
    return brotliCompressSync(source);
  }

  if (compression === "gz") {
    return gzipSync(source);
  }

  return source;
}

function decompressUtf8(
  payloadBytes: Buffer,
  compression: "none" | "br" | "gz",
): string {
  if (compression === "br") {
    return brotliDecompressSync(payloadBytes).toString("utf8");
  }

  if (compression === "gz") {
    return gunzipSync(payloadBytes).toString("utf8");
  }

  return payloadBytes.toString("utf8");
}

export function parseEnvironmentKeyHex(rawKeyHex: string): Buffer {
  const key = decodeHex(rawKeyHex, "key");
  if (key.length !== 32) {
    throw new Error("environment_bundle_invalid_key_length");
  }
  return key;
}

function parseEnvironmentShareHex(
  rawShareHex: string,
  label: "share_a" | "share_b",
): Buffer {
  const share = decodeHex(rawShareHex, label);
  if (share.length < 16) {
    throw new Error(`environment_bundle_invalid_${label}_length`);
  }
  return share;
}

export function deriveEnvironmentKeyHexFromShares(params: {
  shareAHex: string;
  shareBHex: string;
}): string {
  const shareA = parseEnvironmentShareHex(params.shareAHex, "share_a");
  const shareB = parseEnvironmentShareHex(params.shareBHex, "share_b");
  const ikm = Buffer.concat([shareA, shareB]);
  const key = hkdfSync(
    "sha256",
    ikm,
    Buffer.from(ENVIRONMENT_HKDF_SALT, "utf8"),
    Buffer.from(ENVIRONMENT_HKDF_INFO, "utf8"),
    32,
  );

  return Buffer.from(key).toString("hex");
}

export function encryptEnvironmentBundle(params: {
  payload: Record<string, unknown>;
  keyHex?: string;
  kid?: string;
  compression?: "none" | "br" | "gz";
}): { keyHex: string; envelope: EnvironmentBundleEnvelopeV1 } {
  const key = params.keyHex
    ? parseEnvironmentKeyHex(params.keyHex)
    : randomBytes(32);
  const iv = randomBytes(12);
  const normalizedPayload = normalizePayload(params.payload);
  const compression = params.compression ?? "br";
  const plaintext = compressUtf8(
    JSON.stringify(normalizedPayload),
    compression,
  );

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(ENVIRONMENT_AAD, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    keyHex: key.toString("hex"),
    envelope: {
      v: 1,
      alg: "aes-256-gcm",
      comp: compression,
      ivHex: iv.toString("hex"),
      ctHex: ciphertext.toString("hex"),
      tagHex: tag.toString("hex"),
      ...(params.kid ? { kid: params.kid } : {}),
    },
  };
}

export function decryptEnvironmentBundle(params: {
  environment: string;
  keyHex: string;
}): Record<string, string> {
  const envelope = parseEnvelope(params.environment);
  const key = parseEnvironmentKeyHex(params.keyHex);

  const iv = decodeHex(envelope.ivHex, "iv");
  const ciphertext = decodeHex(envelope.ctHex, "ciphertext");
  const tag = decodeHex(envelope.tagHex, "tag");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(ENVIRONMENT_AAD, "utf8"));
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  const compression = envelope.comp ?? "none";
  const jsonPayload = decompressUtf8(plaintext, compression);

  const parsed = JSON.parse(jsonPayload) as Record<string, unknown>;
  return normalizePayload(parsed);
}

export function serializeEnvironmentBundleAsHexJson(
  envelope: EnvironmentBundleEnvelopeV1,
): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("hex");
}

export function serializeEnvironmentBundleAsBase58Json(
  envelope: EnvironmentBundleEnvelopeV1,
): string {
  return bs58.encode(Buffer.from(JSON.stringify(envelope), "utf8"));
}

export function createEnvironmentToken(params: {
  shareTwo: string;
  payloadBase58: string;
}): string {
  const shareTwo = params.shareTwo.trim();
  const payloadBase58 = params.payloadBase58.trim();
  const hash16 = createHash("sha256")
    .update(`${shareTwo}.${payloadBase58}`)
    .digest("hex")
    .slice(0, 16);
  return `${hash16}.${shareTwo}.${payloadBase58}`;
}

export function parseEnvironmentToken(
  rawEnvironment: string,
): EnvironmentTokenParts | null {
  const trimmed = rawEnvironment.trim();
  const match = trimmed.match(ENVIRONMENT_TOKEN_RE);
  if (!match) {
    return null;
  }

  const [, hash16Raw, shareTwo, payloadBase58] = match;
  const expectedHash16 = createHash("sha256")
    .update(`${shareTwo}.${payloadBase58}`)
    .digest("hex")
    .slice(0, 16)
    .toLowerCase();

  if (expectedHash16 !== hash16Raw.toLowerCase()) {
    throw new Error("environment_bundle_token_hash_mismatch");
  }

  return {
    hash16: hash16Raw.toLowerCase(),
    shareTwo,
    payloadBase58,
  };
}

export function computeEnvironmentFingerprint(environment: string): string {
  const tokenParts = parseEnvironmentToken(environment);
  const normalized = tokenParts
    ? `${tokenParts.shareTwo}.${tokenParts.payloadBase58}`
    : environment;
  return createHash("sha256").update(normalized).digest("hex");
}

export function createEnvironmentReference(
  environment: string,
): EnvironmentBundleReference {
  const fingerprint = computeEnvironmentFingerprint(environment);
  return {
    version: `env-v1-${fingerprint.slice(0, 12)}`,
    fingerprint,
  };
}

export function loadEnvironmentBundleIntoProcessEnv(
  options?: LoadEnvironmentBundleIntoProcessEnvOptions,
): LoadEnvironmentBundleIntoProcessEnvResult {
  const processEnv = options?.processEnv ?? process.env;
  const mergePrecedence = options?.mergePrecedence ?? "bundle-wins";
  const allowlist = options?.allowlist ?? ENVIRONMENT_BUNDLE_DEFAULT_ALLOWLIST;

  const rawEnvironment = processEnv.ENVIRONMENT?.trim();
  if (!rawEnvironment) {
    return {
      loaded: false,
      appliedKeys: [],
      skippedOverrideKeys: [],
      mergePrecedence,
    };
  }

  const rawKeyHex = processEnv.ENVIRONMENT_KEY_HEX?.trim();
  const keyHex =
    rawKeyHex ||
    deriveEnvironmentKeyHexFromToken(rawEnvironment, processEnv) ||
    deriveEnvironmentKeyHexFromRuntimeEnv(processEnv);

  const payload = decryptEnvironmentBundle({
    environment: rawEnvironment,
    keyHex,
  });

  const appliedKeys: string[] = [];
  const skippedOverrideKeys: string[] = [];
  for (const key of allowlist) {
    const nextValue = payload[key];
    if (nextValue === undefined) {
      continue;
    }

    const hasExisting = processEnv[key] !== undefined;
    if (mergePrecedence === "env-wins" && hasExisting) {
      skippedOverrideKeys.push(key);
      continue;
    }

    processEnv[key] = nextValue;
    appliedKeys.push(key);
  }

  return {
    loaded: true,
    appliedKeys,
    skippedOverrideKeys,
    mergePrecedence,
  };
}

function deriveEnvironmentKeyHexFromToken(
  rawEnvironment: string,
  processEnv: NodeJS.ProcessEnv,
): string | null {
  const tokenParts = parseEnvironmentToken(rawEnvironment);
  if (!tokenParts) {
    return null;
  }

  const shareOne =
    processEnv.ENVIRONMENT_KEY?.trim() || processEnv.SHAMIR_SHARE_1?.trim();
  if (!shareOne) {
    throw new Error(
      "environment_bundle_missing_share_one provide ENVIRONMENT_KEY (preferred) or SHAMIR_SHARE_1 when ENVIRONMENT token embeds share2",
    );
  }

  return secrets.combine([shareOne, tokenParts.shareTwo]);
}

function deriveEnvironmentKeyHexFromRuntimeEnv(
  processEnv: NodeJS.ProcessEnv,
): string {
  const shareAHex = processEnv.ENVIRONMENT_KEY_SHARE_A_HEX?.trim();
  const shareBHex = processEnv.ENVIRONMENT_KEY_SHARE_B_HEX?.trim();

  if (!shareAHex || !shareBHex) {
    throw new Error(
      "environment_bundle_missing_key_material provide ENVIRONMENT_KEY_HEX or both ENVIRONMENT_KEY_SHARE_A_HEX and ENVIRONMENT_KEY_SHARE_B_HEX",
    );
  }

  return deriveEnvironmentKeyHexFromShares({
    shareAHex,
    shareBHex,
  });
}
