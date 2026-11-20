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
import { CPaceInitiator } from "./cpace";
import { decodeCode } from "./device-code";
import { checkOffer, type PairingOffer } from "./offer";

export interface ClientIdentity {
	device: KeyPair;
	hostKey: Buffer;
}

export class BridgeClientError extends Error {
	constructor(
		readonly code: string | number,
		message: string,
		/** The JSON-RPC error's `data` (`{ code: "host_turn" }` and the like), when the bridge sent one. */
		readonly data?: unknown,
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

	/**
	 * Device-code pairing (gjcm-code-v1, #128): a CPace session on the code's address gets the offer, then the usual
	 * pairing hello follows on the same address. `dial` overrides the address only (tests dial 127.0.0.1); the
	 * password is still the code. Errors carry the bridge's code (`code_wrong` with `data.left`, …) or the app-side
	 * ones: `code_format`, `code_unsupported`, `bridge_outdated` (a 0.1.5 bridge answers `bad_hello`), `pake_failed`.
	 */
	static async pairWithCode(
		code: string,
		options: { dial?: string; device?: KeyPair; name?: string } = {},
	): Promise<{ client: BridgeClient; offer: PairingOffer; identity: ClientIdentity }> {
		const decoded = decodeCode(code);
		if (!decoded.ok) throw new BridgeClientError(decoded.error, "invalid code", decoded);
		const endpoint = options.dial ?? decoded.endpoint;
		const offer = await fetchOfferWithCode(endpoint, decoded.code);
		const identity = BridgeClient.identityFromOffer(offer, options.device);
		const client = await BridgeClient.connect(endpoint, identity, {
			pairing: { id: offer.pairingId, secret: offer.secret },
			name: options.name,
		});
		return { client, offer, identity };
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
			if (message.e) pending.reject(new BridgeClientError(message.e.code, message.e.message, message.e.data));
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

/** Runs the CPace exchange of a device code and returns the offer out of `pake.ok`. */
export async function fetchOfferWithCode(endpoint: string, code: string): Promise<PairingOffer> {
	const ws = new WebSocket(endpoint);
	const inbox: any[] = [];
	const waiters: Array<(m: any) => void> = [];
	let closedReason = "";
	const deliver = (m: any) => {
		const waiter = waiters.shift();
		if (waiter) waiter(m);
		else inbox.push(m);
	};
	ws.addEventListener("message", e => {
		try {
			deliver(JSON.parse(String(e.data)));
		} catch {
			deliver({ t: "error", code: "pake_failed", message: "unreadable reply" });
		}
	});
	ws.addEventListener("close", e => {
		closedReason = e.reason;
		while (waiters.length) waiters.shift()!({ t: "closed" });
	});
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new BridgeClientError("connect", "websocket error")), { once: true });
	});
	const next = () =>
		new Promise<any>(resolve => {
			if (inbox.length) resolve(inbox.shift());
			else if (ws.readyState === WebSocket.CLOSED) resolve({ t: "closed" });
			else waiters.push(resolve);
		});
	const expect = async (t: string) => {
		const m = await next();
		if (m?.t === t) return m;
		if (m?.t === "error") {
			const remote = String(m.code ?? "");
			if (remote === "bad_hello") throw new BridgeClientError("bridge_outdated", "the bridge does not know device codes");
			throw new BridgeClientError(remote, String(m.message ?? remote), typeof m.left === "number" ? { left: m.left } : undefined);
		}
		throw new BridgeClientError("closed", closedReason || "connection closed");
	};
	try {
		const cpace = new CPaceInitiator(Buffer.from(code));
		ws.send(JSON.stringify({ t: "pake", v: 1, sid: b64urlEncode(cpace.sid), ya: b64urlEncode(cpace.ya) }));
		const reply = await expect("pake.reply");
		const session = cpace.finish(b64urlDecode(String(reply.yb ?? "")));
		if (!session) throw new BridgeClientError("pake_failed", "invalid point from the bridge");
		ws.send(JSON.stringify({ t: "pake.confirm", ta: b64urlEncode(session.ta) }));
		const ok = await expect("pake.ok");
		if (!session.verifyTb(b64urlDecode(String(ok.tb ?? "")))) throw new BridgeClientError("pake_failed", "bridge failed key confirmation");
		const plain = session.open(b64urlDecode(String(ok.box ?? "")));
		if (!plain) throw new BridgeClientError("pake_failed", "offer box did not open");
		try {
			return checkOffer(JSON.parse(plain.toString("utf8")));
		} catch (error) {
			throw new BridgeClientError("pake_failed", `bad offer: ${error instanceof Error ? error.message : String(error)}`);
		}
	} finally {
		ws.close();
	}
}
