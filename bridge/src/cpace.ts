/**
 * CPACE-X25519-SHA512, pinned to draft-irtf-cfrg-cpace-21 (gjcm-code-v1, issue #128).
 *
 * The phone (initiator A) and the bridge (responder B) share only the typed device code (PRS). Each side
 * sends one X25519 point, both derive ISK, and explicit key confirmation (§10.4) follows:
 *   A → B  sid, Ya
 *   B → A  Yb
 *   A → B  Ta = HMAC-SHA512(mac_key, lv_cat(Ya, ADa))
 *   B → A  Tb = HMAC-SHA512(mac_key, lv_cat(Yb, ADb)) and box = AES-256-GCM(kSeal, offer)   (only after Ta checks)
 * A wrong code gives the attacker one guess per online session and nothing to test offline.
 *
 * Invariants the seal relies on (its nonce is fixed at zero):
 *   1. The responder draws a fresh scalar yb for every session, so ISK and kSeal never repeat.
 *   2. One kSeal seals exactly one message (the offer in `pake.ok`).
 *
 * X25519 is the platform's (node:crypto; BoringSSL under Bun, OpenSSL under Node): it clamps the raw 32-byte scalar itself. The generator
 * comes from Elligator2 over GF(2^255-19), computed here with BigInt; it depends only on public values and the
 * code, and the bridge runs it at most five times per code.
 */
import crypto from "node:crypto";

export const CPACE_DSI = Buffer.from("CPace255");
export const CPACE_S_IN_BYTES = 128;
/** Channel identifier: roles are fixed (app = A, bridge = B), and the code already names the address. */
export const CODE_CI = Buffer.from("gjcm-code-v1");
const SEAL_INFO = Buffer.from("gjcm-code-v1 seal");
const SEAL_AAD = Buffer.from("gjcm-code-v1");
const SEAL_NONCE = Buffer.alloc(12);
const TAG_BYTES = 16;

const P = (1n << 255n) - 19n;
const A = 486662n;
/** Z = 2: the non-square RFC 9380 picks for curve25519. */
const Z = 2n;

function mod(x: bigint): bigint {
	const r = x % P;
	return r < 0n ? r + P : r;
}

function pow(base: bigint, exp: bigint): bigint {
	let result = 1n;
	let b = mod(base);
	let e = exp;
	while (e > 0n) {
		if (e & 1n) result = (result * b) % P;
		b = (b * b) % P;
		e >>= 1n;
	}
	return result;
}

const inv = (x: bigint) => pow(x, P - 2n);

/** LEB128 length prefix (draft A.1.1). */
export function prependLen(data: Uint8Array): Buffer {
	const bytes: number[] = [];
	let length = data.length;
	do {
		let b = length & 0x7f;
		length = Math.floor(length / 128);
		if (length > 0) b |= 0x80;
		bytes.push(b);
	} while (length > 0);
	return Buffer.concat([Buffer.from(bytes), data]);
}

export function lvCat(...parts: Uint8Array[]): Buffer {
	return Buffer.concat(parts.map(prependLen));
}

export function generatorString(dsi: Uint8Array, prs: Uint8Array, ci: Uint8Array, sid: Uint8Array, sInBytes = CPACE_S_IN_BYTES): Buffer {
	const zpad = Math.max(0, sInBytes - 1 - prependLen(prs).length - prependLen(dsi).length);
	return lvCat(dsi, prs, Buffer.alloc(zpad), ci, sid);
}

export function decodeLittleEndian(bytes: Uint8Array): bigint {
	let x = 0n;
	for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]!);
	return x;
}

export function encodeLittleEndian(x: bigint): Buffer {
	const out = Buffer.alloc(32);
	let v = x;
	for (let i = 0; i < 32; i++) {
		out[i] = Number(v & 0xffn);
		v >>= 8n;
	}
	return out;
}

/** RFC 7748 decodeUCoordinate for X25519: bit 255 is ignored; the value is taken mod p by the field arithmetic. */
export function decodeUCoordinate(bytes: Uint8Array): bigint {
	const b = Buffer.from(bytes);
	b[31]! &= 0x7f;
	return decodeLittleEndian(b);
}

/**
 * Elligator2 onto curve25519 (draft A.5): v = -A / (1 + Z r²), ε = legendre(v³ + A v² + v), x = ε v − (1 − ε) A/2.
 * 1 + 2r² is never zero (−1/2 is a non-square mod p), and v³ + A v² + v is never zero, so ε is ±1.
 */
export function elligator2(r: bigint): bigint {
	const u = mod(r);
	const v = mod(-A * inv(1n + Z * u * u));
	const gv = mod(v * v * v + A * v * v + v);
	const eps = pow(gv, (P - 1n) / 2n); // 1 or p - 1
	// Arithmetic select instead of a branch: x = ε·v − (1 − ε)·A/2.
	return mod(eps * v - mod(1n - eps) * A * inv(2n));
}

/** G.calculate_generator(H, PRS, sid, CI): the X25519 u-coordinate both sides start from. */
export function calculateGenerator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Buffer {
	const hash = crypto.createHash("sha512").update(generatorString(CPACE_DSI, prs, ci, sid)).digest().subarray(0, 32);
	return encodeLittleEndian(elligator2(decodeUCoordinate(hash)));
}

const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

/**
 * scalar_mult_vfy: X25519(scalar, u), or undefined when the key agreement fails (the platform library rejects a low-order
 * input by refusing an all-zero result) or yields the neutral element. Callers abort on undefined.
 */
export function x25519(scalar: Uint8Array, u: Uint8Array): Buffer | undefined {
	if (scalar.length !== 32 || u.length !== 32) return undefined;
	try {
		const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, scalar]), format: "der", type: "pkcs8" });
		const publicKey = crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, u]), format: "der", type: "spki" });
		const out = crypto.diffieHellman({ privateKey, publicKey });
		return out.every(b => b === 0) ? undefined : out;
	} catch {
		return undefined;
	}
}

/** ISK for the initiator/responder setting: H(lv_cat(DSI‖"_ISK", sid, K) ‖ transcript_ir(Ya, ADa, Yb, ADb)). */
export function deriveIsk(sid: Uint8Array, k: Uint8Array, ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array): Buffer {
	const dsiIsk = Buffer.concat([CPACE_DSI, Buffer.from("_ISK")]);
	return crypto
		.createHash("sha512")
		.update(lvCat(dsiIsk, sid, k))
		.update(lvCat(ya, ada))
		.update(lvCat(yb, adb))
		.digest();
}

/** §10.4 key confirmation: mac_key = H("CPaceMac" ‖ sid ‖ ISK); tag = HMAC(mac_key, lv_cat(Y, AD)). */
export function confirmationTag(sid: Uint8Array, isk: Uint8Array, y: Uint8Array, ad: Uint8Array): Buffer {
	const macKey = crypto.createHash("sha512").update(Buffer.from("CPaceMac")).update(sid).update(isk).digest();
	return crypto.createHmac("sha512", macKey).update(lvCat(y, ad)).digest();
}

export function sealKey(isk: Uint8Array): Buffer {
	return Buffer.from(crypto.hkdfSync("sha256", isk, Buffer.alloc(0), SEAL_INFO, 32));
}

/** Seals once per ISK (invariant 2), so the zero nonce never repeats under one key. */
export function sealBox(isk: Uint8Array, plaintext: Uint8Array): Buffer {
	const cipher = crypto.createCipheriv("aes-256-gcm", sealKey(isk), SEAL_NONCE);
	cipher.setAAD(SEAL_AAD);
	return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

export function openBox(isk: Uint8Array, box: Uint8Array): Buffer | undefined {
	if (box.length < TAG_BYTES) return undefined;
	try {
		const decipher = crypto.createDecipheriv("aes-256-gcm", sealKey(isk), SEAL_NONCE);
		decipher.setAAD(SEAL_AAD);
		decipher.setAuthTag(Buffer.from(box.subarray(box.length - TAG_BYTES)));
		return Buffer.concat([decipher.update(box.subarray(0, box.length - TAG_BYTES)), decipher.final()]);
	} catch {
		return undefined;
	}
}

function tagsEqual(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface CPaceOptions {
	ci?: Uint8Array;
	/** Fixed scalar, for test vectors only. */
	scalar?: Uint8Array;
	ad?: Uint8Array;
}

/** Party A (the phone). `start()` → Ya; `finish(Yb)` → Ta plus the checks for B's answer. */
export class CPaceInitiator {
	readonly sid: Buffer;
	readonly ya: Buffer;
	readonly #prs: Buffer;
	readonly #scalar: Buffer;
	readonly #ci: Uint8Array;
	readonly #ad: Uint8Array;

	constructor(prs: Uint8Array, options: CPaceOptions & { sid?: Uint8Array } = {}) {
		this.#prs = Buffer.from(prs);
		this.#ci = options.ci ?? CODE_CI;
		this.#ad = options.ad ?? Buffer.alloc(0);
		this.sid = Buffer.from(options.sid ?? crypto.randomBytes(16));
		this.#scalar = Buffer.from(options.scalar ?? crypto.randomBytes(32));
		const ya = x25519(this.#scalar, calculateGenerator(this.#prs, this.#ci, this.sid));
		if (!ya) throw new Error("cpace: generator rejected");
		this.ya = ya;
	}

	/** Undefined when Yb is invalid (abort). */
	finish(yb: Uint8Array, peerAd: Uint8Array = Buffer.alloc(0)): CPaceInitiatorSession | undefined {
		if (yb.length !== 32) return undefined;
		const k = x25519(this.#scalar, yb);
		if (!k) return undefined;
		const isk = deriveIsk(this.sid, k, this.ya, this.#ad, yb, peerAd);
		return {
			isk,
			ta: confirmationTag(this.sid, isk, this.ya, this.#ad),
			verifyTb: tb => tagsEqual(tb, confirmationTag(this.sid, isk, yb, peerAd)),
			open: box => openBox(isk, box),
		};
	}
}

export interface CPaceInitiatorSession {
	isk: Buffer;
	ta: Buffer;
	verifyTb(tb: Uint8Array): boolean;
	open(box: Uint8Array): Buffer | undefined;
}

/** The bridge's side. The ISK stays inside: Tb and the seal come only from `confirm`. */
export interface CPaceResponderSession {
	yb: Buffer;
	/**
	 * Tb and the one-shot seal, handed out only for the right Ta: nothing that proves the code to the phone
	 * exists before the phone has proved it to the bridge. Undefined for a wrong Ta.
	 */
	confirm(ta: Uint8Array): CPaceConfirmed | undefined;
}

export interface CPaceConfirmed {
	/** Tb proves the bridge knew the code too. */
	tb: Buffer;
	seal(plaintext: Uint8Array): Buffer;
}

/** Party B (the bridge). Undefined when Ya is invalid (abort). A fresh yb per call (invariant 1). */
export function cpaceRespond(
	prs: Uint8Array,
	sid: Uint8Array,
	ya: Uint8Array,
	options: CPaceOptions & { peerAd?: Uint8Array } = {},
): CPaceResponderSession | undefined {
	if (ya.length !== 32 || sid.length === 0) return undefined;
	const ci = options.ci ?? CODE_CI;
	const ad = options.ad ?? Buffer.alloc(0);
	const peerAd = options.peerAd ?? Buffer.alloc(0);
	const scalar = Buffer.from(options.scalar ?? crypto.randomBytes(32));
	const yb = x25519(scalar, calculateGenerator(prs, ci, sid));
	if (!yb) return undefined;
	const k = x25519(scalar, ya);
	if (!k) return undefined;
	const isk = deriveIsk(sid, k, ya, peerAd, yb, ad);
	let sealed = false;
	const confirmed: CPaceConfirmed = {
		tb: confirmationTag(sid, isk, yb, ad),
		seal: plaintext => {
			if (sealed) throw new Error("cpace: kSeal seals exactly one message");
			sealed = true;
			return sealBox(isk, plaintext);
		},
	};
	return {
		yb,
		confirm: ta => (tagsEqual(ta, confirmationTag(sid, isk, ya, peerAd)) ? confirmed : undefined),
	};
}
