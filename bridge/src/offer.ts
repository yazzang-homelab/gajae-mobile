/**
 * Pairing offer: `gjcm://pair?o=<base64url(JSON)>`, shown as a QR code by `gjcm-bridge pair`.
 * Like Paseo's ConnectionOfferV2 it carries the host static public key (so the phone can
 * authenticate the host from the very first connection) plus candidate endpoints; unlike Paseo
 * it also carries a single-use pairing secret, so only someone who saw the QR can enroll a device.
 */
import os from "node:os";
import { b64urlEncode } from "./crypto";
import type { BridgeState, HostIdentity, PendingPairing } from "./state";

export interface PairingOffer {
	v: 1;
	hostId: string;
	name: string;
	hostKey: string;
	endpoints: string[];
	pairingId: string;
	secret: string;
	exp: string;
}

export function buildOffer(host: HostIdentity, pairing: PendingPairing, endpoints: string[]): PairingOffer {
	return {
		v: 1,
		hostId: host.hostId,
		// GJCM_HOST_NAME names a host whose machine name means nothing to the user (the review demo).
		name: process.env.GJCM_HOST_NAME || os.hostname(),
		hostKey: b64urlEncode(host.keyPair.publicKey),
		endpoints,
		pairingId: pairing.id,
		secret: pairing.secret,
		exp: pairing.expiresAt,
	};
}

export function offerUrl(offer: PairingOffer): string {
	return `gjcm://pair?o=${Buffer.from(JSON.stringify(offer)).toString("base64url")}`;
}

export function parseOfferUrl(url: string): PairingOffer {
	const parsed = new URL(url);
	if (parsed.protocol !== "gjcm:") throw new Error("not a gjcm:// URL");
	const encoded = parsed.searchParams.get("o");
	if (!encoded) throw new Error("missing offer");
	const offer = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	if (offer?.v !== 1) throw new Error("unsupported offer version");
	return offer;
}

/** Tailscale first (reachable off-LAN), then private LAN IPv4 addresses. */
export async function discoverEndpoints(port: number): Promise<string[]> {
	const endpoints: string[] = [];
	try {
		const proc = Bun.spawn(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "ignore" });
		const status = JSON.parse(await new Response(proc.stdout).text());
		const dns = String(status?.Self?.DNSName ?? "").replace(/\.$/, "");
		for (const ip of status?.Self?.TailscaleIPs ?? []) if (!String(ip).includes(":")) endpoints.push(`ws://${ip}:${port}/ws`);
		if (dns) endpoints.push(`ws://${dns}:${port}/ws`);
	} catch {
		// tailscale not installed or not running
	}
	for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
		if (/^(docker|veth|br-|virbr|tailscale|lo)/.test(name)) continue;
		for (const addr of addrs ?? []) {
			if (addr.family !== "IPv4" || addr.internal || addr.address.startsWith("100.")) continue;
			endpoints.push(`ws://${addr.address}:${port}/ws`);
		}
	}
	return [...new Set(endpoints)];
}

/** Reviewers may open the app days apart: one reusable code for the demo host, renewed a day before it lapses. */
const DEMO_PAIRING_TTL_MS = 30 * 24 * 60 * 60_000;
const DEMO_RENEW_BEFORE_MS = 24 * 60 * 60_000;

export function demoOfferUrl(state: BridgeState, endpoint: string, now = Date.now()): string {
	const live = state.pendingPairings(now).find(p => p.reusable && Date.parse(p.expiresAt) - now > DEMO_RENEW_BEFORE_MS);
	return offerUrl(buildOffer(state.host(), live ?? state.createPairing(DEMO_PAIRING_TTL_MS, true), [endpoint]));
}
