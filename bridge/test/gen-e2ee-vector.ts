/**
 * Writes fixtures/e2ee-vector.json: fixed keys + the bridge's derived keys, a sealed frame and a
 * pairing proof. The Swift core test replays it to prove both implementations interoperate.
 *   bun test/gen-e2ee-vector.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { b64urlDecode, b64urlEncode, FrameCipher, type KeyPair, pairingProof, serverKeys } from "../src/crypto";

function fixedKeyPair(seed: string): KeyPair {
	const priv = crypto.createHash("sha256").update(seed).digest();
	const der = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), priv]);
	const jwk = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" }).export({ format: "jwk" });
	return { publicKey: b64urlDecode(jwk.x!), privateKey: b64urlDecode(jwk.d!) };
}

const host = fixedKeyPair("host");
const device = fixedKeyPair("device");
const clientEph = fixedKeyPair("client-eph");
const serverEph = fixedKeyPair("server-eph");
const clientNonce = Buffer.alloc(16, 1);
const serverNonce = Buffer.alloc(16, 2);
const keys = serverKeys(host, serverEph, {
	deviceKey: device.publicKey,
	hostKey: host.publicKey,
	clientEph: clientEph.publicKey,
	serverEph: serverEph.publicKey,
	clientNonce,
	serverNonce,
});
const serverCipher = new FrameCipher(keys.s2c, keys.c2s);
const plaintext = JSON.stringify({ ev: "session.update", p: { sessionId: "s1", seq: 1, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "가재 🦞" } } } });
const frame0 = serverCipher.seal(Buffer.from(plaintext));
const frame1 = serverCipher.seal(Buffer.from("{}"));
const secret = Buffer.alloc(32, 7);

const vector = {
	hostPrivate: b64urlEncode(host.privateKey),
	hostPublic: b64urlEncode(host.publicKey),
	devicePrivate: b64urlEncode(device.privateKey),
	clientEphPrivate: b64urlEncode(clientEph.privateKey),
	serverEphPublic: b64urlEncode(serverEph.publicKey),
	clientNonce: b64urlEncode(clientNonce),
	serverNonce: b64urlEncode(serverNonce),
	c2s: b64urlEncode(keys.c2s),
	s2c: b64urlEncode(keys.s2c),
	plaintext,
	serverFrames: [b64urlEncode(frame0), b64urlEncode(frame1)],
	pairingSecret: b64urlEncode(secret),
	pairingProof: b64urlEncode(pairingProof(secret, device.publicKey, clientEph.publicKey)),
};
const out = path.join(import.meta.dir, "../../fixtures/e2ee-vector.json");
fs.writeFileSync(out, `${JSON.stringify(vector, null, 2)}\n`);
console.log(`wrote ${out}`);
