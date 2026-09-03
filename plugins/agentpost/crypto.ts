import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { keysDir } from "./paths.js";
import type { KeyPair } from "./types.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers-sumo");

let ready: Promise<void> | null = null;

/**
 * Await once before any other call here.
 *
 * Deliberately not a top-level await: a bundled top-level await is illegal in hosts
 * that wrap plugin modules in a function (OpenClaw's plugin loader does), and it fails
 * at load time with a bare SyntaxError. An explicit init keeps the same guarantee
 * without constraining how the bundle is evaluated.
 */
export function initSodium(): Promise<void> {
	ready ??= Promise.resolve(sodium.ready).then(() => undefined);
	return ready;
}

export function toBase64(data: Uint8Array): string {
	return sodium.to_base64(data, sodium.base64_variants.ORIGINAL);
}

export function fromBase64(s: string): Uint8Array {
	return sodium.from_base64(s, sodium.base64_variants.ORIGINAL);
}

export function sealedBoxDecrypt(ciphertext: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array {
	return sodium.crypto_box_seal_open(ciphertext, publicKey, privateKey);
}

export function loadOrGenerateKeys(dir: string = keysDir()): KeyPair {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const pubPath = join(dir, "public.key");
	const privPath = join(dir, "private.key");

	if (existsSync(pubPath) && existsSync(privPath)) {
		return {
			publicKey: new Uint8Array(readFileSync(pubPath)),
			privateKey: new Uint8Array(readFileSync(privPath)),
		};
	}

	const kp = sodium.crypto_box_keypair();
	writeFileSync(pubPath, Buffer.from(kp.publicKey));
	writeFileSync(privPath, Buffer.from(kp.privateKey), { mode: 0o600 });
	chmodSync(privPath, 0o600);
	return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export function loadOrGenerateHmacKey(dir: string = keysDir()): Uint8Array {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const hmacPath = join(dir, "hmac.key");

	if (existsSync(hmacPath)) {
		return new Uint8Array(readFileSync(hmacPath));
	}

	const key: Uint8Array = sodium.crypto_auth_keygen();
	writeFileSync(hmacPath, Buffer.from(key), { mode: 0o600 });
	chmodSync(hmacPath, 0o600);
	return key;
}

export function hmac(key: Uint8Array, message: Uint8Array): Uint8Array {
	return sodium.crypto_auth(message, key);
}
