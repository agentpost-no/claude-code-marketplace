import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Hosts that must never be fetched.
 *
 * A string check on the hostname is not enough, and the first version of this was
 * bypassed four different ways: `127.1`, the integer form `2130706433`, the octal
 * `0177.0.0.1`, and the hex v4-mapped `[::ffff:7f00:1]`. Worse, a name the attacker
 * controls can simply resolve to 169.254.169.254, which no syntactic check can catch.
 *
 * So the address is resolved first and every answer is checked. That still leaves a
 * rebinding window between resolve and connect, which is why the fetch is also pinned
 * to the address that was checked.
 */
export async function resolvePublicAddress(hostname: string): Promise<string | null> {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
		return null;
	}

	let addresses: string[];
	try {
		const literal = isIP(host);
		addresses = literal ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
	} catch {
		return null;
	}

	if (addresses.length === 0) return null;
	// Every answer must be public: one private address in the set is enough to abuse.
	if (addresses.some((address) => !isPublicAddress(address))) return null;
	return addresses[0];
}

export function isPublicAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 6) {
		const v6 = address.toLowerCase();
		if (v6 === "::1" || v6 === "::") return false;
		// Unique-local fc00::/7 and link-local fe80::/10.
		if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return false;
		// v4-mapped, in either notation.
		const mapped = v6.match(/^::ffff:(.+)$/);
		if (mapped) {
			const inner = mapped[1];
			if (isIP(inner) === 4) return isPublicAddress(inner);
			const hex = inner.replace(/:/g, "");
			if (/^[0-9a-f]{8}$/.test(hex)) {
				const octets = [0, 2, 4, 6].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
				return isPublicAddress(octets.join("."));
			}
			return false;
		}
		return true;
	}
	if (version !== 4) return false;

	const [a, b] = address.split(".").map(Number);
	return !(
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) || // link-local, including the cloud metadata service
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		a >= 224
	);
}
