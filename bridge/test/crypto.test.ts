import { describe, expect, test } from "bun:test";
import { clientKeys, FrameCipher, generateKeyPair, pairingProof, randomBytes, serverKeys } from "../src/crypto";

function handshake(clientHostKey?: Buffer) {
	const host = generateKeyPair();
	const device = generateKeyPair();
	const ce = generateKeyPair();
	const se = generateKeyPair();
	const base = { deviceKey: device.publicKey, clientEph: ce.publicKey, serverEph: se.publicKey, clientNonce: randomBytes(16), serverNonce: randomBytes(16) };
	const server = serverKeys(host, se, { ...base, hostKey: host.publicKey });
	const client = clientKeys(device, ce, { ...base, hostKey: clientHostKey ?? host.publicKey });
	return { server, client };
}

describe("gjcm-e2ee-v1", () => {
	test("both sides derive the same directional keys", () => {
		const { server, client } = handshake();
		expect(client.c2s.equals(server.c2s)).toBe(true);
		expect(client.s2c.equals(server.s2c)).toBe(true);
		expect(client.c2s.equals(client.s2c)).toBe(false);
	});

	test("a client pinned to the wrong host key cannot talk to the host", () => {
		const { server, client } = handshake(generateKeyPair().publicKey);
		const phone = new FrameCipher(client.c2s, client.s2c);
		const host = new FrameCipher(server.s2c, server.c2s);
		expect(() => host.open(phone.seal(Buffer.from("hi")))).toThrow();
	});

	test("frames round-trip in order and reject tampering and replay", () => {
		const { server, client } = handshake();
		const phone = new FrameCipher(client.c2s, client.s2c);
		const host = new FrameCipher(server.s2c, server.c2s);
		const f1 = phone.seal(Buffer.from("한글 첫 프레임"));
		const f2 = phone.seal(Buffer.from("second"));
		expect(host.open(f1).toString()).toBe("한글 첫 프레임");
		expect(host.open(f2).toString()).toBe("second");
		expect(() => host.open(f1)).toThrow("replayed");
		const f3 = phone.seal(Buffer.from("third"));
		f3[f3.length - 1] ^= 1;
		expect(() => host.open(f3)).toThrow();
		expect(host.open(phone.seal(Buffer.from("x"))).toString()).toBe("x"); // failed frame did not advance state
		expect(phone.seal(Buffer.from("y")).readBigUInt64BE(0)).toBe(4n);
	});

	test("pairing proof binds the secret to the device and ephemeral keys", () => {
		const secret = randomBytes(32);
		const d = generateKeyPair().publicKey;
		const e = generateKeyPair().publicKey;
		expect(pairingProof(secret, d, e).equals(pairingProof(secret, d, e))).toBe(true);
		expect(pairingProof(secret, d, e).equals(pairingProof(secret, e, d))).toBe(false);
	});
});
