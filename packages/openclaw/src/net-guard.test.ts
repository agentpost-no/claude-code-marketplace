import { describe, expect, it } from "bun:test";
import { isPublicAddress } from "./net-guard.js";

/**
 * Attachment content leaves the machine as email, so a fetch the agent can be talked
 * into is an exfiltration primitive - and the text that talks it into one arrives as
 * inbound mail.
 *
 * The first version of this guard matched on the hostname string and was bypassed four
 * ways, all of which are pinned below. Anything unparseable is blocked rather than
 * allowed: `127.1` is not a valid address to `isIP`, but every resolver reaches
 * loopback with it.
 */
describe("isPublicAddress", () => {
	const blocked = [
		["loopback", "127.0.0.1"],
		["loopback, short form", "127.1"],
		["loopback, integer form", "2130706433"],
		["loopback, octal form", "0177.0.0.1"],
		["cloud metadata", "169.254.169.254"],
		["private 10/8", "10.0.0.5"],
		["private 172.16/12", "172.16.0.1"],
		["private 192.168/16", "192.168.1.1"],
		["carrier-grade NAT", "100.64.0.1"],
		["this network", "0.0.0.0"],
		["multicast", "239.0.0.1"],
		["IPv6 loopback", "::1"],
		["IPv6 unspecified", "::"],
		["IPv6 link-local", "fe80::1"],
		["IPv6 unique-local", "fc00::1"],
		["v4-mapped loopback, dotted", "::ffff:127.0.0.1"],
		["v4-mapped loopback, hex", "::ffff:7f00:1"],
		["v4-mapped metadata, hex", "::ffff:a9fe:a9fe"],
	] as const;

	for (const [label, address] of blocked) {
		it(`blocks ${label} (${address})`, () => {
			expect(isPublicAddress(address)).toBe(false);
		});
	}

	const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"];
	for (const address of allowed) {
		it(`allows the public address ${address}`, () => {
			expect(isPublicAddress(address)).toBe(true);
		});
	}
});
