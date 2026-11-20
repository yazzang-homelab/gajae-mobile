/**
 * gjcm-code-v1 device code: the bridge address and a 20-bit secret in 9–14 characters the user types.
 *
 *   bits (MSB first) = type(4) ‖ addr(n) ‖ [port(16)] ‖ secret(20) ‖ check(k ≥ 4, up to the character boundary)
 *   type: high bit = explicit port (absent means 7787); low 3 bits = address range
 *     001 Tailscale 100.64.0.0/10 (22)  010 10.0.0.0/8 (24)  011 172.16.0.0/12 (20)  100 192.168.0.0/16 (16)
 *     000, 101–111 reserved → code_unsupported
 *   check = top k bits of SHA-256("gjcm-code-v1" ‖ m ‖ first m bits packed MSB first, zero padded)
 *
 * The whole normalized string (check included) is the CPace password; the check only catches typos before dialing.
 * Only `ws://<IPv4 in a range above>[:port]/ws` fits in a code; any other endpoint stays QR only.
 */
import crypto from "node:crypto";

export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_DEFAULT_PORT = 7787;
export const CODE_SECRET_BITS = 20;
const CHECK_LABEL = Buffer.from("gjcm-code-v1");
const EXPLICIT_PORT = 0b1000;

export type CodeRange = "tailscale" | "ten" | "oneSevenTwo" | "oneNineTwo";

interface RangeSpec {
	type: number;
	range: CodeRange;
	base: number;
	prefixBits: number;
}

const RANGES: RangeSpec[] = [
	{ type: 0b001, range: "tailscale", base: ipv4(100, 64, 0, 0), prefixBits: 10 },
	{ type: 0b010, range: "ten", base: ipv4(10, 0, 0, 0), prefixBits: 8 },
	{ type: 0b011, range: "oneSevenTwo", base: ipv4(172, 16, 0, 0), prefixBits: 12 },
	{ type: 0b100, range: "oneNineTwo", base: ipv4(192, 168, 0, 0), prefixBits: 16 },
];

function ipv4(a: number, b: number, c: number, d: number): number {
	return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function ipText(n: number): string {
	return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

export interface CodeAddress {
	ip: string;
	port: number;
	range: CodeRange;
}

export type EncodableResult = { ok: true; address: CodeAddress } | { ok: false; reason: string };

/** Whether `endpoint` fits in a code, and why not when it does not (shown to the user as is). */
export function encodableEndpoint(endpoint: string): EncodableResult {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return { ok: false, reason: `주소 형식이 아닙니다(${endpoint})` };
	}
	if (url.protocol !== "ws:") return { ok: false, reason: `ws:// 주소만 코드에 담을 수 있습니다(${url.protocol}//)` };
	if (url.pathname !== "/ws" || url.search || url.hash || url.username || url.password)
		return { ok: false, reason: `경로가 /ws인 주소만 코드에 담을 수 있습니다(${endpoint})` };
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(url.hostname);
	const octets = m?.slice(1).map(Number);
	if (!octets || octets.some(o => o > 255)) return { ok: false, reason: `IPv4 주소만 코드에 담을 수 있습니다(${url.hostname})` };
	const n = ipv4(octets[0]!, octets[1]!, octets[2]!, octets[3]!);
	const spec = RANGES.find(r => n >>> (32 - r.prefixBits) === r.base >>> (32 - r.prefixBits));
	if (!spec) return { ok: false, reason: `Tailscale(100.64/10)이나 사설 LAN 대역 주소만 코드에 담을 수 있습니다(${url.hostname})` };
	const port = url.port ? Number(url.port) : 80;
	return { ok: true, address: { ip: ipText(n), port, range: spec.range } };
}

class BitWriter {
	bits: number[] = [];
	push(value: number, width: number): void {
		for (let i = width - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
	}
}

function readBits(bits: number[], from: number, width: number): number {
	let v = 0;
	for (let i = 0; i < width; i++) v = v * 2 + bits[from + i]!;
	return v;
}

function packMsbFirst(bits: number[]): Buffer {
	const out = Buffer.alloc(Math.ceil(bits.length / 8));
	bits.forEach((bit, i) => {
		if (bit) out[i >> 3]! |= 0x80 >> (i & 7);
	});
	return out;
}

function checkBits(payload: number[], k: number): number[] {
	const digest = crypto
		.createHash("sha256")
		.update(CHECK_LABEL)
		.update(Buffer.from([payload.length]))
		.update(packMsbFirst(payload))
		.digest();
	const out: number[] = [];
	for (let i = 0; i < k; i++) out.push((digest[i >> 3]! >> (7 - (i & 7))) & 1);
	return out;
}

/** Payload bits (type through secret) for a range and port choice. */
function payloadBits(spec: RangeSpec, explicitPort: boolean): number {
	return 4 + (32 - spec.prefixBits) + (explicitPort ? 16 : 0) + CODE_SECRET_BITS;
}

/** Characters for m payload bits: room for at least 4 check bits. */
function codeLength(m: number): number {
	return Math.ceil((m + 4) / 5);
}

export function encodeCode(address: { ip: string; port: number }, secret: number): string {
	const found = encodableEndpoint(`ws://${address.ip}:${address.port}/ws`);
	if (!found.ok) throw new Error(found.reason);
	if (!Number.isInteger(secret) || secret < 0 || secret >= 2 ** CODE_SECRET_BITS) throw new Error("secret must be 20 bits");
	const spec = RANGES.find(r => r.range === found.address.range)!;
	const explicitPort = address.port !== CODE_DEFAULT_PORT;
	const w = new BitWriter();
	w.push((explicitPort ? EXPLICIT_PORT : 0) | spec.type, 4);
	const [a, b, c, d] = found.address.ip.split(".").map(Number) as [number, number, number, number];
	const hostBits = 32 - spec.prefixBits;
	w.push((ipv4(a, b, c, d) - spec.base) >>> 0, hostBits);
	if (explicitPort) w.push(address.port, 16);
	w.push(secret, CODE_SECRET_BITS);
	const m = w.bits.length;
	const chars = codeLength(m);
	const bits = [...w.bits, ...checkBits(w.bits, chars * 5 - m)];
	let out = "";
	for (let i = 0; i < chars; i++) out += CODE_ALPHABET[readBits(bits, i * 5, 5)];
	return out;
}

/** A new random code for this address (secret from crypto.randomInt). */
export function newCode(address: { ip: string; port: number }): string {
	return encodeCode(address, crypto.randomInt(0, 2 ** CODE_SECRET_BITS));
}

export type NormalizeResult = { ok: true; code: string } | { ok: false; error: "code_format"; position: number; char: string };

/** Uppercase, drop spaces and hyphens; any other character outside the alphabet (0 O 1 I …) is rejected with its 1-based position. */
export function normalizeCode(input: string): NormalizeResult {
	let code = "";
	for (const ch of input.toUpperCase()) {
		if (ch === "-" || /\s/.test(ch)) continue;
		if (!CODE_ALPHABET.includes(ch)) return { ok: false, error: "code_format", position: code.length + 1, char: ch };
		code += ch;
	}
	return { ok: true, code };
}

/** Groups of four: K7M2-9QXD-HP. */
export function formatCode(code: string): string {
	return code.match(/.{1,4}/g)?.join("-") ?? "";
}

export type DecodeResult =
	| { ok: true; code: string; address: CodeAddress; endpoint: string }
	| { ok: false; error: "code_format"; position?: number }
	| { ok: false; error: "code_unsupported" };

export function decodeCode(input: string): DecodeResult {
	const normalized = normalizeCode(input);
	if (!normalized.ok) return { ok: false, error: "code_format", position: normalized.position };
	const code = normalized.code;
	if (code.length === 0) return { ok: false, error: "code_format" };
	const bits: number[] = [];
	for (const ch of code) {
		const v = CODE_ALPHABET.indexOf(ch);
		for (let i = 4; i >= 0; i--) bits.push((v >> i) & 1);
	}
	const type = readBits(bits, 0, 4);
	const spec = RANGES.find(r => r.type === (type & 0b111));
	if (!spec) return { ok: false, error: "code_unsupported" };
	const explicitPort = (type & EXPLICIT_PORT) !== 0;
	const m = payloadBits(spec, explicitPort);
	if (code.length !== codeLength(m)) return { ok: false, error: "code_format" };
	const expected = checkBits(bits.slice(0, m), code.length * 5 - m);
	if (expected.some((bit, i) => bit !== bits[m + i])) return { ok: false, error: "code_format" };
	const hostBits = 32 - spec.prefixBits;
	const ip = ipText((spec.base + readBits(bits, 4, hostBits)) >>> 0);
	const port = explicitPort ? readBits(bits, 4 + hostBits, 16) : CODE_DEFAULT_PORT;
	if (port === 0) return { ok: false, error: "code_format" };
	return { ok: true, code, address: { ip, port, range: spec.range }, endpoint: `ws://${ip}:${port}/ws` };
}
