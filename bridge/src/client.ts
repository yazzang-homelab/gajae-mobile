/**
 * Reference phone-side client (TypeScript). The Swift `BridgeClient` implements the same
 * handshake; this one drives the bridge from tests and from `bun src/client.ts` smoke runs.
 */
import {
	b64urlDecode,
	b64urlEncode,
	clientKeys,
	FrameCipher,
	generateKeyPair,
	type KeyPair,
	pairingProof,
	randomBytes,
} from "./crypto";
import type { PairingOffer } from "./offer";

export interface ClientIdentity {
	device: KeyPair;
	hostKey: Buffer;
}

export class BridgeClientError extends Error {
	constructor(
		readonly code: string | number,
		message: string,
	) {
		super(message);
	}
}

export class BridgeClient {
	#ws: WebSocket;
	#cipher?: FrameCipher;
	#nextId = 1;
	#pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
	readonly events: Array<{ ev: string; p: any }> = [];
	#waiters: Array<{ match(e: { ev: string; p: any }): boolean; resolve(e: { ev: string; p: any }): void }> = [];
	closed: Promise<{ code: number; reason: string }>;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		this.closed = new Promise(resolve => ws.addEventListener("close", e => resolve({ code: e.code, reason: e.reason })));
		this.closed.then(({ reason }) => {
			for (const p of this.#pending.values()) p.reject(new BridgeClientError("closed", reason || "connection closed"));
			this.#pending.clear();
		});
	}

	static async connect(
		endpoint: string,
		identity: ClientIdentity,
		options: { pairing?: { id: string; secret: string }; name?: string } = {},
	): Promise<BridgeClient> {
		const ws = new WebSocket(endpoint);
		ws.binaryType = "arraybuffer";
		const client = new BridgeClient(ws);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new BridgeClientError("connect", "websocket error")), { once: true });
		});
		const eph = generateKeyPair();
		const nonce = randomBytes(16);
		const hello: Record<string, unknown> = {
			t: "hello",
			v: 1,
			deviceKey: b64urlEncode(identity.device.publicKey),
			eph: b64urlEncode(eph.publicKey),
			nonce: b64urlEncode(nonce),
			name: options.name,
		};
		if (options.pairing) {
			hello.pairing = {
				id: options.pairing.id,
				proof: b64urlEncode(pairingProof(b64urlDecode(options.pairing.secret), identity.device.publicKey, eph.publicKey)),
			};
		}
		const reply = new Promise<any>((resolve, reject) => {
			ws.addEventListener(
				"message",
				e => {
					try {
						resolve(JSON.parse(String(e.data)));
					} catch (error) {
						reject(error);
					}
				},
				{ once: true },
			);
			client.closed.then(({ reason }) => reject(new BridgeClientError("closed", reason)));
		});
		ws.send(JSON.stringify(hello));
		const welcome = await reply;
		if (welcome.t === "error") throw new BridgeClientError(welcome.code, welcome.message);
		const keys = clientKeys(identity.device, eph, {
			deviceKey: identity.device.publicKey,
			hostKey: identity.hostKey,
			clientEph: eph.publicKey,
			serverEph: b64urlDecode(welcome.eph),
			clientNonce: nonce,
			serverNonce: b64urlDecode(welcome.nonce),
		});
		client.#cipher = new FrameCipher(keys.c2s, keys.s2c);
		ws.addEventListener("message", e => client.#onFrame(e.data as ArrayBuffer));
		return client;
	}

	static identityFromOffer(offer: PairingOffer, device = generateKeyPair()): ClientIdentity {
		return { device, hostKey: b64urlDecode(offer.hostKey) };
	}

	request<T = any>(m: string, p?: unknown): Promise<T> {
		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#ws.send(this.#cipher!.seal(Buffer.from(JSON.stringify({ id, m, p }))));
		});
	}

	/** Resolves with the first already-received or future event matching the predicate. */
	waitFor(match: (e: { ev: string; p: any }) => boolean, timeoutMs = 120_000): Promise<{ ev: string; p: any }> {
		const existing = this.events.find(match);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for event")), timeoutMs);
			this.#waiters.push({
				match,
				resolve: e => {
					clearTimeout(timer);
					resolve(e);
				},
			});
		});
	}

	close(): void {
		this.#ws.close();
	}

	#onFrame(data: ArrayBuffer): void {
		const message = JSON.parse(this.#cipher!.open(new Uint8Array(data)).toString("utf8"));
		if (typeof message.id === "number") {
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id);
			if (message.e) pending.reject(new BridgeClientError(message.e.code, message.e.message));
			else pending.resolve(message.r);
			return;
		}
		this.events.push(message);
		this.#waiters = this.#waiters.filter(w => {
			if (!w.match(message)) return true;
			w.resolve(message);
			return false;
		});
	}
}
