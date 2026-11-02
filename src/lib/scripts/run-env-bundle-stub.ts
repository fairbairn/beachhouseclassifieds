import { randomUUID } from "node:crypto";
import chalk from "chalk";
import secrets from "secrets.js-grempe";
import {
	createEnvironmentToken,
	parseEnvironmentToken,
	decryptEnvironmentBundle,
	encryptEnvironmentBundle,
	serializeEnvironmentBundleAsBase58Json,
	loadEnvironmentBundleIntoProcessEnv,
	serializeEnvironmentBundleAsHexJson,
} from "../../core/tooling/env/environment-bundle";

function assert(condition: unknown, message: string): void {
	if (!condition) {
		throw new Error(message);
	}
}

function splitTokenParts(token: string): {
	hash16: string;
	shareTwo: string;
	payloadBase58: string;
} | null {
	const match = token.match(/^([0-9a-fA-F]{16})\.([^\.]+)\.(.+)$/);
	if (!match) {
		return null;
	}

	return {
		hash16: match[1],
		shareTwo: match[2],
		payloadBase58: match[3],
	};
}

function restoreEnvVar(
	key: string,
	value: string | undefined,
): void {
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
}

async function main(): Promise<void> {
	const samplePayload = {
		REDIS_URL: "redis://127.0.0.1:6379",
		BUNNY_STORAGE_SECRET_ACCESS_KEY: `stub-secret-${randomUUID().slice(0, 8)}`,
		IMAGE_FETCH_TIMEOUT_MS: "8000",
		IMAGE_FETCH_RETRY_COUNT: "2",
		HTTP_PROXY: "http://proxy.example:8080",
		EXTRA_IGNORED_KEY: "should-not-inject",
	};

	const packed = encryptEnvironmentBundle({ payload: samplePayload });

	// Demonstrate proven secret sharing: split the 32-byte key into 2-of-2 shares.
	const shamirShares = secrets.share(packed.keyHex, 2, 2);
	assert(shamirShares.length === 2, "expected two shamir shares");
	const reconstructedKeyHex = secrets.combine(shamirShares);
	assert(
		reconstructedKeyHex === packed.keyHex,
		"reconstructed key mismatch",
	);

	let singleShareDecryptFailed = false;
	try {
		const oneShareKeyHex = secrets.combine([shamirShares[0]]);
		decryptEnvironmentBundle({
			environment: JSON.stringify(packed.envelope),
			keyHex: oneShareKeyHex,
		});
	} catch {
		singleShareDecryptFailed = true;
	}
	assert(singleShareDecryptFailed, "single shamir share should not decrypt");

	const tamperedShare = `${shamirShares[1].slice(0, -1)}${shamirShares[1].slice(-1) === "0" ? "1" : "0"}`;
	let wrongShareDecryptFailed = false;
	try {
		const wrongKeyHex = secrets.combine([shamirShares[0], tamperedShare]);
		decryptEnvironmentBundle({
			environment: JSON.stringify(packed.envelope),
			keyHex: wrongKeyHex,
		});
	} catch {
		wrongShareDecryptFailed = true;
	}
	assert(wrongShareDecryptFailed, "tampered shamir share should fail decryption");

	const envelopeJson = JSON.stringify(packed.envelope);
	const envelopeHexJson = serializeEnvironmentBundleAsHexJson(packed.envelope);
	const envelopeBase58Json = serializeEnvironmentBundleAsBase58Json(
		packed.envelope,
	);
	const environmentToken = createEnvironmentToken({
		shareTwo: shamirShares[1],
		payloadBase58: envelopeBase58Json,
	});
	const tokenParts = parseEnvironmentToken(environmentToken);
	assert(tokenParts !== null, "environment token should parse");

	const decodedFromJson = decryptEnvironmentBundle({
		environment: envelopeJson,
		keyHex: reconstructedKeyHex,
	});
	const decodedFromHexJson = decryptEnvironmentBundle({
		environment: envelopeHexJson,
		keyHex: reconstructedKeyHex,
	});
	const decodedFromBase58Json = decryptEnvironmentBundle({
		environment: envelopeBase58Json,
		keyHex: reconstructedKeyHex,
	});
	const decodedFromToken = decryptEnvironmentBundle({
		environment: environmentToken,
		keyHex: reconstructedKeyHex,
	});

	assert(
		decodedFromJson.BUNNY_STORAGE_SECRET_ACCESS_KEY ===
			samplePayload.BUNNY_STORAGE_SECRET_ACCESS_KEY,
		"json envelope decrypt mismatch",
	);
	assert(
		decodedFromHexJson.BUNNY_STORAGE_SECRET_ACCESS_KEY ===
			samplePayload.BUNNY_STORAGE_SECRET_ACCESS_KEY,
		"hex-json envelope decrypt mismatch",
	);
	assert(
		decodedFromBase58Json.BUNNY_STORAGE_SECRET_ACCESS_KEY ===
			samplePayload.BUNNY_STORAGE_SECRET_ACCESS_KEY,
		"base58-json envelope decrypt mismatch",
	);
	assert(
		decodedFromToken.BUNNY_STORAGE_SECRET_ACCESS_KEY ===
			samplePayload.BUNNY_STORAGE_SECRET_ACCESS_KEY,
		"token envelope decrypt mismatch",
	);

	const original = {
		ENVIRONMENT: process.env.ENVIRONMENT,
		ENVIRONMENT_KEY_HEX: process.env.ENVIRONMENT_KEY_HEX,
		SHAMIR_SHARE_1: process.env.SHAMIR_SHARE_1,
		REDIS_URL: process.env.REDIS_URL,
		EXTRA_IGNORED_KEY: process.env.EXTRA_IGNORED_KEY,
	};

	try {
		delete process.env.REDIS_URL;
		delete process.env.ENVIRONMENT_KEY_HEX;
		process.env.ENVIRONMENT = environmentToken;
		process.env.SHAMIR_SHARE_1 = shamirShares[0];

		const applied = loadEnvironmentBundleIntoProcessEnv();
		assert(applied.loaded, "bundle should be marked loaded");
		assert(applied.appliedKeys.includes("REDIS_URL"), "REDIS_URL should be applied");
		assert(
			process.env.REDIS_URL === samplePayload.REDIS_URL,
			"REDIS_URL was not injected",
		);
		assert(
			process.env.EXTRA_IGNORED_KEY !== "should-not-inject",
			"allowlist failed: EXTRA_IGNORED_KEY should not be injected",
		);
	} finally {
		restoreEnvVar("ENVIRONMENT", original.ENVIRONMENT);
		restoreEnvVar("ENVIRONMENT_KEY_HEX", original.ENVIRONMENT_KEY_HEX);
		restoreEnvVar("SHAMIR_SHARE_1", original.SHAMIR_SHARE_1);
		restoreEnvVar("REDIS_URL", original.REDIS_URL);
		restoreEnvVar("EXTRA_IGNORED_KEY", original.EXTRA_IGNORED_KEY);
	}

	process.stdout.write("env_bundle_stub_ok\n");
	process.stdout.write(`envelope_json_chars=${envelopeJson.length}\n`);
	process.stdout.write(`envelope_hex_chars=${envelopeHexJson.length}\n`);
	process.stdout.write(`envelope_base58_chars=${envelopeBase58Json.length}\n`);
	process.stdout.write(`environment_token_chars=${environmentToken.length}\n`);
	process.stdout.write(`envelope_comp=${packed.envelope.comp || "none"}\n`);
	process.stdout.write("shamir_scheme=2of2\n");

	const tokenVisual = splitTokenParts(environmentToken);

	process.stdout.write(`\n${chalk.bold.cyan("example_export_lines")}:\n`);
	process.stdout.write(
		`${chalk.bold.green("ENVIRONMENT") }=` +
			`${chalk.magenta(tokenVisual?.hash16 || "invalid")}.` +
			`${chalk.yellow(tokenVisual?.shareTwo || "invalid")}.` +
			`${chalk.blue(tokenVisual?.payloadBase58 || "invalid")}\n`,
	);
	process.stdout.write(
		`${chalk.gray("token_parts")}: ` +
			`${chalk.magenta("hash16")}(${tokenVisual?.hash16.length || 0}) ` +
			`${chalk.yellow("share2")}(${tokenVisual?.shareTwo.length || 0}) ` +
			`${chalk.blue("payload")}(${tokenVisual?.payloadBase58.length || 0})\n`,
	);
	process.stdout.write(
		`${chalk.bold.green("LOCAL_SHARE1_FILE") }=.secrets/env-shares/${tokenParts?.hash16 || "unknown"}.share1\n`,
	);
	process.stdout.write(
		`${chalk.bold.green("LOCAL_SHARE1_VALUE") }=${chalk.yellow(shamirShares[0])}\n`,
	);
}

void main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`env_bundle_stub_failed ${message}\n`);
	process.exit(1);
});
