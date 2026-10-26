/**
 * Durable bridge state under GJCM_HOME (default ~/.gjc-mobile). Every file is owner-only (0600).
 *   host.json      host static X25519 identity + stable hostId
 *   devices.json   paired phones (device public keys); revoke = delete row
 *   pairings.json  pending single-use pairing secrets (from `gjcm-bridge pair`)
 *   uploads/       files uploaded from the phone, per session
 * Agent sessions are NOT stored here: gjc keeps them in ~/.gjc/agent/sessions.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { b64urlDecode, b64urlEncode, generateKeyPair, type KeyPair, randomBytes } from "./crypto";

export interface DeviceRecord {
	deviceKey: string; // base64url raw X25519 public key
	name: string;
	pairedAt: string;
	lastSeenAt?: string;
}

export interface PendingPairing {
	id: string;
	secret: string; // base64url 32 bytes
	expiresAt: string;
	/** Demo host only (`pair --reusable`): stays valid for every device until it expires. */
	reusable?: boolean;
}

export interface HostIdentity {
	hostId: string;
	keyPair: KeyPair;
}

export function defaultHome(): string {
	return process.env.GJCM_HOME || path.join(os.homedir(), ".gjc-mobile");
}

export class BridgeState {
	readonly home: string;

	constructor(home = defaultHome()) {
		this.home = home;
		fs.mkdirSync(home, { recursive: true, mode: 0o700 });
		fs.chmodSync(home, 0o700);
	}

	get uploadsDir(): string {
		return path.join(this.home, "uploads");
	}

	host(): HostIdentity {
		const file = path.join(this.home, "host.json");
		if (fs.existsSync(file)) {
			const raw = JSON.parse(fs.readFileSync(file, "utf8"));
			return {
				hostId: raw.hostId,
				keyPair: { publicKey: b64urlDecode(raw.publicKey), privateKey: b64urlDecode(raw.privateKey) },
			};
		}
		const keyPair = generateKeyPair();
		const identity = { hostId: b64urlEncode(randomBytes(12)), keyPair };
		writePrivate(file, {
			v: 1,
			hostId: identity.hostId,
			publicKey: b64urlEncode(keyPair.publicKey),
			privateKey: b64urlEncode(keyPair.privateKey),
		});
		return identity;
	}

	devices(): DeviceRecord[] {
		return readJson(path.join(this.home, "devices.json"), []);
	}

	saveDevices(devices: DeviceRecord[]): void {
		writePrivate(path.join(this.home, "devices.json"), devices);
	}

	findDevice(deviceKey: string): DeviceRecord | undefined {
		return this.devices().find(d => d.deviceKey === deviceKey);
	}

	upsertDevice(record: DeviceRecord): void {
		const rest = this.devices().filter(d => d.deviceKey !== record.deviceKey);
		this.saveDevices([...rest, record]);
	}

	touchDevice(deviceKey: string): void {
		const devices = this.devices();
		const found = devices.find(d => d.deviceKey === deviceKey);
		if (!found) return;
		found.lastSeenAt = new Date().toISOString();
		this.saveDevices(devices);
	}

	revokeDevice(prefix: string): DeviceRecord[] {
		const devices = this.devices();
		const removed = devices.filter(d => d.deviceKey.startsWith(prefix) || d.name === prefix);
		this.saveDevices(devices.filter(d => !removed.includes(d)));
		return removed;
	}

	createPairing(ttlMs = 10 * 60_000, reusable = false): PendingPairing {
		const pending = this.pendingPairings();
		const pairing: PendingPairing = {
			id: b64urlEncode(randomBytes(6)),
			secret: b64urlEncode(randomBytes(32)),
			expiresAt: new Date(Date.now() + ttlMs).toISOString(),
			...(reusable ? { reusable: true } : {}),
		};
		writePrivate(path.join(this.home, "pairings.json"), [...pending, pairing]);
		return pairing;
	}

	/** Unexpired pending pairings; expired rows are pruned on every read. */
	pendingPairings(now = Date.now()): PendingPairing[] {
		const file = path.join(this.home, "pairings.json");
		const all: PendingPairing[] = readJson(file, []);
		const live = all.filter(p => Date.parse(p.expiresAt) > now);
		if (live.length !== all.length) writePrivate(file, live);
		return live;
	}

	consumePairing(id: string): PendingPairing | undefined {
		const pending = this.pendingPairings();
		const found = pending.find(p => p.id === id);
		if (found && !found.reusable) writePrivate(path.join(this.home, "pairings.json"), pending.filter(p => p !== found));
		return found;
	}
}

function readJson<T>(file: string, fallback: T): T {
	if (!fs.existsSync(file)) return fallback;
	return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writePrivate(file: string, value: unknown): void {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}
