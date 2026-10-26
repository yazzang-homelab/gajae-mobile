/**
 * gjcm-e2ee-v1 — end-to-end encrypted channel between the phone and the bridge.
 *
 * Handshake (one plaintext round trip, then everything is AES-256-GCM):
 *   client → hello   { deviceKey: D_pub, eph: Ec_pub, nonce: Nc, pairing? }
 *   server → welcome { eph: Es_pub, nonce: Ns }
 *   ikm  = DH(Es, Ec) ‖ DH(H, Ec) ‖ DH(H, D)         (ee ‖ es ‖ ss)
 *   keys = HKDF-SHA256(ikm, salt = Nc ‖ Ns, info = LABEL ‖ D_pub ‖ H_pub ‖ Ec_pub ‖ Es_pub, 64)
 *          → [0..32) client→server, [32..64) server→client
 * Only a server holding H and a client holding D derive the same keys, so the first
 * encrypted frame each side decrypts doubles as key confirmation.
 *
 * Frame: 8-byte big-endian counter ‖ ciphertext ‖ 16-byte tag; GCM nonce = 4 zero bytes ‖ counter.
 * Counters start at 0 per direction and must strictly increase (replay/reorder → reject).
 */
import crypto from "node:crypto";

export const PROTOCOL_LABEL = "gjcm-e2ee-v1";
const AAD = Buffer.from("gjcm1");
const TAG_BYTES = 16;
const COUNTER_BYTES = 8;

export interface KeyPair {
	publicKey: Buffer; // raw 32 bytes
	privateKey: Buffer; // raw 32 bytes
}

export function generateKeyPair(): KeyPair {
	const pair = crypto.generateKeyPairSync("x25519");
	const jwk = pair.privateKey.export({ format: "jwk" });
	return { publicKey: b64urlDecode(jwk.x!), privateKey: b64urlDecode(jwk.d!) };
}

function privateKeyObject(pair: KeyPair): crypto.KeyObject {
	return crypto.createPrivateKey({
		key: { kty: "OKP", crv: "X25519", x: b64urlEncode(pair.publicKey), d: b64urlEncode(pair.privateKey) },
		format: "jwk",
	});
}

function publicKeyObject(raw: Buffer): crypto.KeyObject {
	if (raw.length !== 32) throw new Error("X25519 public key must be 32 bytes");
	return crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b64urlEncode(raw) }, format: "jwk" });
}

export function dh(own: KeyPair, peerPublic: Buffer): Buffer {
	return crypto.diffieHellman({ privateKey: privateKeyObject(own), publicKey: publicKeyObject(peerPublic) });
}

export interface HandshakeTranscript {
	deviceKey: Buffer;
	hostKey: Buffer;
	clientEph: Buffer;
	serverEph: Buffer;
	clientNonce: Buffer;
	serverNonce: Buffer;
}

export function deriveSessionKeys(ikm: Buffer, t: HandshakeTranscript): { c2s: Buffer; s2c: Buffer } {
	const info = Buffer.concat([Buffer.from(PROTOCOL_LABEL), t.deviceKey, t.hostKey, t.clientEph, t.serverEph]);
	const salt = Buffer.concat([t.clientNonce, t.serverNonce]);
	const okm = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, 64));
	return { c2s: okm.subarray(0, 32), s2c: okm.subarray(32, 64) };
}

/** Server side of the key schedule: host static H, server ephemeral Es. */
export function serverKeys(host: KeyPair, serverEph: KeyPair, t: HandshakeTranscript) {
	const ikm = Buffer.concat([dh(serverEph, t.clientEph), dh(host, t.clientEph), dh(host, t.deviceKey)]);
	return deriveSessionKeys(ikm, t);
}

/** Client side of the key schedule: device static D, client ephemeral Ec. */
export function clientKeys(device: KeyPair, clientEph: KeyPair, t: HandshakeTranscript) {
	const ikm = Buffer.concat([dh(clientEph, t.serverEph), dh(clientEph, t.hostKey), dh(device, t.hostKey)]);
	return deriveSessionKeys(ikm, t);
}

export function pairingProof(pairingSecret: Buffer, deviceKey: Buffer, clientEph: Buffer): Buffer {
	return crypto.createHmac("sha256", pairingSecret).update(Buffer.from("gjcm-pair-v1")).update(deviceKey).update(clientEph).digest();
}

export class FrameCipher {
	#sendKey: Buffer;
	#recvKey: Buffer;
	#sendCounter = 0n;
	#recvNext = 0n;

	constructor(sendKey: Buffer, recvKey: Buffer) {
		this.#sendKey = sendKey;
		this.#recvKey = recvKey;
	}

	seal(plaintext: Uint8Array): Buffer {
		const counter = this.#sendCounter++;
		const header = Buffer.alloc(COUNTER_BYTES);
		header.writeBigUInt64BE(counter);
		const cipher = crypto.createCipheriv("aes-256-gcm", this.#sendKey, nonceFor(header), { authTagLength: TAG_BYTES });
		cipher.setAAD(AAD);
		return Buffer.concat([header, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
	}

	open(frame: Uint8Array): Buffer {
		const buf = Buffer.from(frame);
		if (buf.length < COUNTER_BYTES + TAG_BYTES) throw new Error("frame too short");
		const header = buf.subarray(0, COUNTER_BYTES);
		const counter = header.readBigUInt64BE();
		if (counter < this.#recvNext) throw new Error("replayed or reordered frame");
		const decipher = crypto.createDecipheriv("aes-256-gcm", this.#recvKey, nonceFor(header), { authTagLength: TAG_BYTES });
		decipher.setAAD(AAD);
		decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
		const plain = Buffer.concat([decipher.update(buf.subarray(COUNTER_BYTES, buf.length - TAG_BYTES)), decipher.final()]);
		this.#recvNext = counter + 1n;
		return plain;
	}
}

function nonceFor(counterHeader: Buffer): Buffer {
	return Buffer.concat([Buffer.alloc(4), counterHeader]);
}

export function b64urlEncode(buf: Uint8Array): string {
	return Buffer.from(buf).toString("base64url");
}

export function b64urlDecode(text: string): Buffer {
	return Buffer.from(text, "base64url");
}

export function randomBytes(n: number): Buffer {
	return crypto.randomBytes(n);
}
