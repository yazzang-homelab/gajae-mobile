/**
 * Durable bridge state under GJCM_HOME (default ~/.gjc-mobile). Every file is owner-only (0600).
 *   host.json      host static X25519 identity + stable hostId
 *   devices.json   paired phones (device public keys); revoke = delete row
 *   pairings.json  pending single-use pairing secrets (from `gjcm-bridge pair`), at most one with a device code
 *   pairings.lock  held while `pair` or `serve` rewrites pairings.json (see `mutatePairings`)
 *   uploads/       files uploaded from the phone, per session
 * Agent sessions are NOT stored here: gjc keeps them in ~/.gjc/agent/sessions.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { b64urlDecode, b64urlEncode, generateKeyPair, type KeyPair, randomBytes } from "./crypto";
import type { PairingOffer } from "./offer";

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
	/** The device code for this pairing (gjcm-code-v1, #128). Only the newest pairing keeps one. */
	code?: PairingCode;
}

export interface PairingCode {
	/** The normalized code: the CPace password. */
	prs: string;
	/** Code sessions still allowed; each `pake` takes one before any key material leaves the bridge. */
	attemptsLeft: number;
	/** The same offer the QR carries; `pake.ok` seals it with the secret rotated. */
	offer: PairingOffer;
}

/** Another process (or a stuck one) held pairings.lock past the wait. */
export class PairingsBusyError extends Error {
	constructor() {
		super("pairings.json is locked by another gjcm-bridge process");
	}
}

/** A lock older than this is from a process that died while holding it. */
const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 1_000;
const LOCK_POLL_MS = 25;

export interface PairingsChange<T> {
	/** The rows to store; omit to leave pairings.json as it was (expired rows are still pruned). */
	rows?: PendingPairing[];
	result: T;
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

	/**
	 * A new pending pairing. `code` (when given) attaches a device code to it and drops the code of every older
	 * pairing: one active code per host, while their QR secrets stay valid.
	 */
	createPairing(
		options: { ttlMs?: number; reusable?: boolean; code?: (pairing: PendingPairing) => PairingCode } = {},
	): Promise<PendingPairing> {
		return this.mutatePairings(rows => {
			const pairing = newPairing(options);
			if (options.code) pairing.code = options.code(pairing);
			const rest = options.code ? rows.map(({ code: _code, ...row }) => row) : rows;
			return { rows: [...rest, pairing], result: pairing };
		});
	}

	/** Unexpired pending pairings (read only; writers prune expired rows under the lock). */
	pendingPairings(now = Date.now()): PendingPairing[] {
		const all: PendingPairing[] = readJson(path.join(this.home, "pairings.json"), []);
		return all.filter(p => Date.parse(p.expiresAt) > now);
	}

	/**
	 * Consumes the pairing `id` only if `proven` accepts it, so a request with a wrong proof cannot burn a
	 * one-time code. Lookup and removal happen under the lock: of two valid requests for the same code, one wins.
	 */
	consumePairing(id: string, proven: (pairing: PendingPairing) => boolean): Promise<PendingPairing | undefined> {
		return this.mutatePairings(rows => {
			const found = rows.find(p => p.id === id);
			if (!found || !proven(found)) return { result: undefined };
			return { rows: found.reusable ? undefined : rows.filter(p => p !== found), result: found };
		});
	}

	#pairingsQueue: Promise<unknown> = Promise.resolve();

	/**
	 * Read-modify-write of pairings.json under `pairings.lock`, the one lock `gjcm-bridge pair` (its own process)
	 * and `serve` share. Expired rows are dropped before `change` sees the list. Calls in this process run one at a
	 * time; waiting for another process polls asynchronously (never blocking serve's event loop) for about a second,
	 * then fails with `PairingsBusyError`. A lock file older than 10 s is left over from a crash and is cleared.
	 */
	mutatePairings<T>(change: (rows: PendingPairing[], now: number) => PairingsChange<T>): Promise<T> {
		const run = this.#pairingsQueue.then(async () => {
			const release = await this.#lockPairings();
			try {
				const file = path.join(this.home, "pairings.json");
				const all: PendingPairing[] = readJson(file, []);
				const now = Date.now();
				const live = all.filter(p => Date.parse(p.expiresAt) > now);
				const { rows, result } = change(live, now);
				if (rows) writePrivate(file, rows);
				else if (live.length !== all.length) writePrivate(file, live);
				return result;
			} finally {
				release();
			}
		});
		this.#pairingsQueue = run.catch(() => {});
		return run;
	}

	async #lockPairings(): Promise<() => void> {
		const lock = path.join(this.home, "pairings.lock");
		const deadline = Date.now() + LOCK_WAIT_MS;
		for (;;) {
			try {
				const fd = fs.openSync(lock, "wx", 0o600);
				fs.writeSync(fd, `${process.pid}\n`);
				fs.closeSync(fd);
				return () => fs.rmSync(lock, { force: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			let age: number;
			try {
				age = Date.now() - fs.statSync(lock).mtimeMs;
			} catch {
				continue; // released between open and stat
			}
			if (age > STALE_LOCK_MS) {
				fs.rmSync(lock, { force: true });
				continue;
			}
			if (Date.now() >= deadline) throw new PairingsBusyError();
			await Bun.sleep(LOCK_POLL_MS);
		}
	}
}

/** A pending pairing row (not stored yet). */
export function newPairing(options: { ttlMs?: number; reusable?: boolean } = {}): PendingPairing {
	const { ttlMs = 15 * 60_000, reusable = false } = options;
	return {
		id: b64urlEncode(randomBytes(6)),
		secret: b64urlEncode(randomBytes(32)),
		expiresAt: new Date(Date.now() + ttlMs).toISOString(),
		...(reusable ? { reusable: true } : {}),
	};
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
