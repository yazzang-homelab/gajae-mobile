/**
 * Writes fixtures/cpace-vector.json for gjcm-code-v1 (#128): the CPace and device-code vectors the bridge, iOS and
 * Android tests replay.
 *   bun test/gen-cpace-vector.ts [draft-irtf-cfrg-cpace-21.txt]
 *
 * V1  the draft is pinned by URL and sha256 (downloaded when no path is given).
 * V2  B.1.1–B.1.5 and B.1.10 are read out of the draft text (base64 JSON blocks where the draft has them, the body
 *     lines for transcript_ir, s and q0–qb), never copied by hand.
 * V3  200+ pseudo-random (fixed-stream) generators and field boundary inputs, each computed twice: by src/cpace.ts and by the independent
 *     test/cpace_ref.py (RFC 9380 §6.7.1 + RFC 7748 ladder). Any disagreement stops the generator.
 * Plus device codes (every range, with and without a port, rejects) and one full transaction from sid to box.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	CODE_CI,
	calculateGenerator,
	confirmationTag,
	cpaceRespond,
	decodeUCoordinate,
	deriveIsk,
	elligator2,
	encodeLittleEndian,
	generatorString,
	CPACE_DSI,
	CPaceInitiator,
	lvCat,
	sealKey,
	x25519,
} from "../src/cpace";
import { decodeCode, encodeCode, formatCode } from "../src/device-code";

const DRAFT_URL = "https://www.ietf.org/archive/id/draft-irtf-cfrg-cpace-21.txt";
const DRAFT_SHA256 = "ed2772c26c21d43a199d490c1ebe5c5d2431a7dbce50d2124d4fa40957fbf58f";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => Buffer.from(s, "hex");
function same(what: string, a: string | undefined | null, b: string | undefined | null): void {
	if ((a ?? null) !== (b ?? null)) throw new Error(`${what}: ${a} != ${b}`);
}

const draftText = process.argv[2] ? fs.readFileSync(process.argv[2], "utf8") : await (await fetch(DRAFT_URL)).text();
same("draft sha256", crypto.createHash("sha256").update(draftText).digest("hex"), DRAFT_SHA256);
const lines = draftText.split("\n");

function section(head: string): string[] {
	const start = lines.findIndex(l => l.startsWith(head));
	if (start < 0) throw new Error(`no section ${head}`);
	const end = lines.findIndex((l, i) => i > start && /^(?:[A-Z0-9]\.[0-9.]+\s|Appendix )/.test(l));
	return lines.slice(start + 1, end);
}

function jsonBlock(head: string): Record<string, string> {
	const b64 = section(head)
		.map(l => /^\s+#(\S+)$/.exec(l)?.[1])
		.filter(Boolean)
		.join("");
	const parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
	return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === "string" ? v.toLowerCase() : String(v)]));
}

/** The hex lines that follow a `label` line in the body (multi-line values end at the first non-hex line). */
function bodyHex(head: string, label: RegExp): string {
	const body = section(head);
	const at = body.findIndex(l => label.test(l));
	if (at < 0) throw new Error(`no ${label} in ${head}`);
	let out = "";
	for (const l of body.slice(at + 1)) {
		const m = /^\s+([0-9a-f]+)\s*$/.exec(l);
		if (m) out += m[1];
		else if (out && !/^\s*$/.test(l) && !/^(Abdalla|Internet-Draft)/.test(l)) break;
	}
	return out;
}

/** `name: hex` on one line (B.1.10). */
function bodyLine(head: string, name: string): string {
	const m = section(head)
		.map(l => new RegExp(`^\\s+${name}:?\\s*=?\\s*([0-9a-f]{64})\\s*$`).exec(l))
		.find(Boolean);
	if (!m) throw new Error(`no ${name} in ${head}`);
	return m[1]!;
}

// ---- V2: the draft's own vectors, checked against src/cpace.ts
const b11 = jsonBlock("B.1.1.1.");
const b19 = jsonBlock("B.1.9.");
const b1101 = jsonBlock("B.1.10.1.");
const transcriptIr = bodyHex("B.1.5.", /transcript_ir\(Ya,ADa,Yb,ADb\): \(length: 74 bytes\)/);

same("generator_string", hex(generatorString(CPACE_DSI, unhex(b11.PRS!), unhex(b11.CI!), unhex(b11.sid!))), b11["generator_string(G.DSI,PRS,CI,sid,H.s_in_bytes)"]);
same("hash", hex(crypto.createHash("sha512").update(unhex(b11["generator_string(G.DSI,PRS,CI,sid,H.s_in_bytes)"]!)).digest().subarray(0, 32)), b11["hash generator string"]);
same("u", hex(encodeLittleEndian(decodeUCoordinate(unhex(b11["hash generator string"]!)))), b11["decoded field element of 255 bits"]);
same("g", hex(calculateGenerator(unhex(b19.PRS!), unhex(b19.CI!), unhex(b19.sid!))), b19.g);
const Ya = x25519(unhex(b19.ya!), unhex(b19.g!))!;
const Yb = x25519(unhex(b19.yb!), unhex(b19.g!))!;
same("Ya", hex(Ya), b19.Ya);
same("Yb", hex(Yb), b19.Yb);
same("K", hex(x25519(unhex(b19.ya!), Yb)!), b19.K);
same("K'", hex(x25519(unhex(b19.yb!), Ya)!), b19.K);
same("transcript_ir", hex(Buffer.concat([lvCat(Ya, unhex(b19.ADa!)), lvCat(Yb, unhex(b19.ADb!))])), transcriptIr);
same("ISK_IR", hex(deriveIsk(unhex(b19.sid!), unhex(b19.K!), Ya, unhex(b19.ADa!), Yb, unhex(b19.ADb!))), b19.ISK_IR);

const lowOrderS = bodyLine("B.1.10.", "s");
const lowOrder = Array.from({ length: 12 }, (_, i) => {
	const n = i.toString(16);
	const u = b1101[`Invalid Y${i}`]!;
	same(`u${n} body vs JSON`, bodyLine("B.1.10.", `u${n}`), u);
	const q = bodyLine("B.1.10.", `q${n}`);
	const expected = /^0+$/.test(q) ? null : q;
	same(`q${n}`, hex(x25519(unhex(lowOrderS), unhex(u)) ?? Buffer.alloc(0)) || null, expected);
	return { u, q: expected };
});
// The draft: u0–u5 and u7 must abort.
for (const i of [0, 1, 2, 3, 4, 5, 7]) if (lowOrder[i]!.q !== null) throw new Error(`u${i} must abort`);

// ---- V3: random and boundary inputs, src/cpace.ts vs test/cpace_ref.py
// "Random" inputs come from a fixed SHA-256 counter stream, so rerunning the generator rewrites the same fixture.
let streamCounter = 0;
const randomBytes = (n: number): Buffer => {
	const out: Buffer[] = [];
	for (let have = 0; have < n; have += 32) {
		const counter = Buffer.alloc(4);
		counter.writeUInt32BE(streamCounter++);
		out.push(crypto.createHash("sha256").update("gjcm-code-v1 vector stream").update(counter).digest());
	}
	return Buffer.concat(out).subarray(0, n);
};
const randomInt = (n: number): number => randomBytes(4).readUInt32BE() % n;
const P = (1n << 255n) - 19n;
const le = (x: bigint) => {
	const out = Buffer.alloc(32);
	let v = x;
	for (let i = 0; i < 32; i++) {
		out[i] = Number(v & 0xffn);
		v >>= 8n;
	}
	return out;
};
const boundary = [0n, 1n, 2n, 3n, (P - 1n) / 2n, (P + 1n) / 2n, P - 2n, P - 1n, P, P + 1n, P + 18n, 1n << 254n, (1n << 254n) - 1n];
const mapInputs = [
	...boundary.map(le),
	// bit 255 set: decodeUCoordinate drops it
	...[0n, 1n, P - 1n, P + 18n].map(x => le(x | (1n << 255n))),
	...Array.from({ length: 64 }, () => randomBytes(32)),
].map(hex);

const randomCode = () => {
	const ranges = [
		() => `100.${64 + randomInt(64)}.${randomInt(256)}.${randomInt(256)}`,
		() => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`,
		() => `172.${16 + randomInt(16)}.${randomInt(256)}.${randomInt(256)}`,
		() => `192.168.${randomInt(256)}.${randomInt(256)}`,
	];
	const ip = ranges[randomInt(4)]!();
	return encodeCode({ ip, port: randomInt(2) ? 7787 : 1 + randomInt(65535) }, randomInt(2 ** 20));
};
const generatorInputs = [
	...Array.from({ length: 200 }, () => ({ prs: Buffer.from(randomCode()), sid: randomBytes(16) })),
	// long passwords cross the 128-byte block (ZPAD 0) and the LEB128 two-byte length
	...[0, 1, 108, 109, 110, 127, 128, 200].map(n => ({ prs: randomBytes(n), sid: randomBytes(16) })),
].map(g => ({ prs: hex(g.prs), ci: hex(CODE_CI), sid: hex(g.sid) }));

const x25519Inputs = [
	...lowOrder.map(l => ({ k: lowOrderS, u: l.u })),
	...Array.from({ length: 16 }, () => ({ k: hex(randomBytes(32)), u: hex(randomBytes(32)) })),
];

// ---- full transaction with fixed scalars
const code = encodeCode({ ip: "100.85.215.116", port: 7787 }, 0x5a5a5);
const tx = {
	code,
	sid: hex(Buffer.alloc(16, 0x11)),
	ya: hex(crypto.createHash("sha256").update("gjcm-code-v1 vector ya").digest()),
	yb: hex(crypto.createHash("sha256").update("gjcm-code-v1 vector yb").digest()),
	offer: JSON.stringify({
		v: 1,
		hostId: "aG9zdC1pZC0x",
		name: "가재 호스트",
		hostKey: Buffer.alloc(32, 3).toString("base64url"),
		endpoints: ["ws://100.85.215.116:7787/ws", "ws://192.168.0.10:7787/ws"],
		pairingId: "cGFpcjEy",
		secret: Buffer.alloc(32, 9).toString("base64url"),
		exp: "2026-11-20T12:00:00.000Z",
	}),
};

const ref = await runReference({
	map: mapInputs,
	generator: [...generatorInputs, { prs: b19.PRS!, ci: b19.CI!, sid: b19.sid! }],
	x25519: [...x25519Inputs, { k: b19.ya!, u: b19.g! }],
	transaction: { prs: hex(Buffer.from(code)), ci: hex(CODE_CI), sid: tx.sid, ya: tx.ya, yb: tx.yb, ada: "", adb: "" },
});

const map = mapInputs.map((u, i) => {
	const g = hex(encodeLittleEndian(elligator2(decodeUCoordinate(unhex(u)))));
	same(`map ${u}`, g, ref.map[i]);
	return { u, g };
});
const generator = generatorInputs.map((input, i) => {
	const g = hex(calculateGenerator(unhex(input.prs), unhex(input.ci), unhex(input.sid)));
	same(`generator ${input.prs}`, g, ref.generator[i]);
	return { prs: input.prs, sid: input.sid, g };
});
same("reference g (draft)", ref.generator[generatorInputs.length], b19.g);
same("reference Ya (draft)", ref.x25519[x25519Inputs.length], b19.Ya);
const x25519Vectors = x25519Inputs.map((input, i) => {
	const out = x25519(unhex(input.k), unhex(input.u));
	same(`x25519 ${input.u}`, out ? hex(out) : null, ref.x25519[i]);
	return { k: input.k, u: input.u, out: out ? hex(out) : null };
});

const initiator = new CPaceInitiator(Buffer.from(code), { sid: unhex(tx.sid), scalar: unhex(tx.ya) });
const responder = cpaceRespond(Buffer.from(code), unhex(tx.sid), initiator.ya, { scalar: unhex(tx.yb) })!;
const session = initiator.finish(responder.yb)!;
const confirmed = responder.confirm(session.ta);
if (!confirmed || !session.verifyTb(confirmed.tb)) throw new Error("transaction does not confirm");
const box = confirmed.seal(Buffer.from(tx.offer));
same("box opens", session.open(box)?.toString("utf8"), tx.offer);
const K = x25519(unhex(tx.ya), responder.yb)!;
same("tx g", hex(calculateGenerator(Buffer.from(code), CODE_CI, unhex(tx.sid))), ref.transaction.g);
same("tx Ya", hex(initiator.ya), ref.transaction.Ya);
same("tx Yb", hex(responder.yb), ref.transaction.Yb);
same("tx K", hex(K), ref.transaction.K);
same("tx ISK", hex(session.isk), ref.transaction.ISK);
same("tx Ta", hex(session.ta), ref.transaction.Ta);
same("tx Tb", hex(confirmed.tb), ref.transaction.Tb);
same("tx Ta'", hex(confirmationTag(unhex(tx.sid), session.isk, initiator.ya, Buffer.alloc(0))), ref.transaction.Ta);

// ---- device codes
const codeCases = [
	{ ip: "100.64.0.0", port: 7787, secret: 0 },
	{ ip: "100.127.255.255", port: 7787, secret: 0xfffff },
	{ ip: "100.85.215.116", port: 7787, secret: 0x12345 },
	{ ip: "100.85.215.116", port: 17787, secret: 0x54321 },
	{ ip: "10.0.0.1", port: 7787, secret: 1 },
	{ ip: "10.255.255.254", port: 1, secret: 0xabcde },
	{ ip: "172.16.0.0", port: 7787, secret: 0x00fff },
	{ ip: "172.31.255.255", port: 65535, secret: 0xfff00 },
	{ ip: "192.168.0.1", port: 7787, secret: 0x0f0f0 },
	{ ip: "192.168.255.255", port: 8080, secret: 0x80000 },
];
// `L` is a normal character (only 0 O 1 I are left out): one valid code that contains it.
for (let secret = 0; ; secret++) {
	if (encodeCode({ ip: "192.168.0.7", port: 7787 }, secret).includes("L")) {
		codeCases.push({ ip: "192.168.0.7", port: 7787, secret });
		break;
	}
}
const valid = codeCases.map(c => {
	const encoded = encodeCode(c, c.secret);
	const decoded = decodeCode(encoded);
	if (!decoded.ok || decoded.address.ip !== c.ip || decoded.address.port !== c.port) throw new Error(`code round trip ${c.ip}`);
	return { ...c, range: decoded.address.range, code: encoded, formatted: formatCode(encoded) };
});
/**
 * Codes no bridge prints, built bit by bit here (encodeCode refuses them): an explicit port of 0,
 * and an explicit 7787, which has a shorter canonical code. Both must decode to code_format.
 */
function forgeExplicitPort(port: number): string {
	const bits: number[] = [];
	const push = (v: number, width: number) => {
		for (let i = width - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) % 2);
	};
	push(0b1000 | 0b100, 4); // explicit port, 192.168.0.0/16
	push(0x0007, 16); // 192.168.0.7
	push(port, 16);
	push(0x12345, 20);
	const m = bits.length;
	const chars = Math.ceil((m + 4) / 5);
	const packed = Buffer.alloc(Math.ceil(m / 8));
	bits.forEach((b, i) => {
		if (b) packed[i >> 3]! |= 0x80 >> (i & 7);
	});
	const digest = crypto.createHash("sha256").update("gjcm-code-v1").update(Buffer.from([m])).update(packed).digest();
	for (let i = 0; i < chars * 5 - m; i++) bits.push((digest[i >> 3]! >> (7 - (i & 7))) & 1);
	let out = "";
	for (let i = 0; i < chars; i++) {
		let v = 0;
		for (let j = 0; j < 5; j++) v = v * 2 + bits[i * 5 + j]!;
		out += "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"[v];
	}
	return out;
}
// The forger agrees with the encoder on a code it does print.
if (forgeExplicitPort(8080) !== encodeCode({ ip: "192.168.0.7", port: 8080 }, 0x12345)) throw new Error("forged code drifted from encodeCode");
const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "2" ? "3" : "2") + s.slice(i + 1);
const sample = valid[2]!.code;
const rejectInputs = [
	flip(sample, sample.length - 1),
	flip(sample, 3),
	sample.slice(0, -1),
	`${sample}2`,
	`${sample.slice(0, 2)}0${sample.slice(3)}`,
	`${sample.slice(0, 4)}O${sample.slice(5)}`,
	`${sample.slice(0, 5)}1${sample.slice(6)}`,
	`I${sample.slice(1)}`,
	"",
	// reserved range types: 000 and 101–111 (the first character carries the type in its top four bits)
	`2${sample.slice(1)}`,
	`C${sample.slice(1)}`,
	`G${sample.slice(1)}`,
	`J${sample.slice(1)}`,
	`Z${sample.slice(1)}`,
	`E${sample.slice(1)}`,
	`U${sample.slice(1)}`,
	`W${sample.slice(1)}`,
	// explicit port 0 and explicit 7787 (non-canonical): well-formed bits with a valid check, still code_format
	forgeExplicitPort(0),
	forgeExplicitPort(7787),
	// the reported position counts code characters only: hyphens and spaces before the bad character are not counted
	`${sample.slice(0, 4)}-${sample.slice(4, 6)}O${sample.slice(7)}`,
	` ${sample.slice(0, 2)} ${sample.slice(2, 4)}-1${sample.slice(5)}`,
	// not separators: zero-width space, NEL, and a full-width letter
	`${sample.slice(0, 4)}\u200b${sample.slice(4)}`,
	`${sample.slice(0, 4)}\u0085${sample.slice(4)}`,
	`${sample.slice(0, 4)}Ａ${sample.slice(5)}`,
	// only ASCII letters are uppercased: ß and ſ do not become SS and S
	`${sample.slice(0, 4)}ß${sample.slice(4)}`,
	`${sample.slice(0, 4)}ſ${sample.slice(5)}`,
];
const reject = rejectInputs.map(input => {
	const decoded = decodeCode(input);
	if (decoded.ok) throw new Error(`${input} should be rejected`);
	return { input, error: decoded.error, ...("position" in decoded && decoded.position ? { position: decoded.position } : {}) };
});
const normalize = [
	{ input: formatCode(sample).toLowerCase(), code: sample },
	{ input: ` ${formatCode(sample)} `, code: sample },
	{ input: sample.split("").join(" "), code: sample },
	// the full separator set: hyphen and JavaScript's \s, nothing else
	{ input: `\ufeff${formatCode(sample).replaceAll("-", "\u00a0")}`, code: sample },
	{ input: `${sample.slice(0, 4)}\u3000${sample.slice(4, 8)}\u2009${sample.slice(8)}\r\n`, code: sample },
	{ input: `\t${sample.slice(0, 3)}\u2028${sample.slice(3, 6)}\u202f${sample.slice(6)}\u205f\u1680\v\f`, code: sample },
];
for (const n of normalize) {
	const d = decodeCode(n.input);
	if (!d.ok || d.code !== n.code) throw new Error(`normalize ${n.input}`);
}

const vector = {
	spec: {
		suite: "CPACE-X25519-SHA512",
		draft: "draft-irtf-cfrg-cpace-21",
		url: DRAFT_URL,
		sha256: DRAFT_SHA256,
		independentReference: "bridge/test/cpace_ref.py (RFC 9380 6.7.1 Elligator2 + RFC 7748 ladder, Python standard library)",
		ci: CODE_CI.toString(),
		seal: "HKDF-SHA256(ISK, salt empty, info 'gjcm-code-v1 seal', 32) → AES-256-GCM, nonce 12 zero bytes, AAD 'gjcm-code-v1'",
	},
	draft: {
		generator: {
			prs: b11.PRS,
			ci: b11.CI,
			sid: b11.sid,
			generatorString: b11["generator_string(G.DSI,PRS,CI,sid,H.s_in_bytes)"],
			hash: b11["hash generator string"],
			u: b11["decoded field element of 255 bits"],
			g: b11["generator g"],
		},
		exchange: {
			prs: b19.PRS,
			ci: b19.CI,
			sid: b19.sid,
			g: b19.g,
			ya: b19.ya,
			ADa: b19.ADa,
			Ya: b19.Ya,
			yb: b19.yb,
			ADb: b19.ADb,
			Yb: b19.Yb,
			K: b19.K,
			transcriptIr,
			ISK: b19.ISK_IR,
		},
		lowOrder: { s: lowOrderS, cases: lowOrder, note: "q null = abort (X25519 fails or yields zero)" },
	},
	map,
	generator,
	x25519: x25519Vectors,
	transaction: {
		...tx,
		ci: CODE_CI.toString(),
		Ya: hex(initiator.ya),
		Yb: hex(responder.yb),
		K: hex(K),
		ISK: hex(session.isk),
		Ta: hex(session.ta),
		Tb: hex(confirmed.tb),
		kSeal: hex(sealKey(session.isk)),
		box: hex(box),
	},
	codes: { alphabet: "23456789ABCDEFGHJKLMNPQRSTUVWXYZ", defaultPort: 7787, valid, reject, normalize },
};

const out = path.join(import.meta.dir, "../../fixtures/cpace-vector.json");
fs.writeFileSync(out, `${JSON.stringify(vector, null, 2)}\n`);
console.log(`wrote ${out}: ${map.length} map, ${generator.length} generator, ${x25519Vectors.length} x25519, ${valid.length} codes`);

async function runReference(request: unknown): Promise<any> {
	const proc = Bun.spawn(["python3", path.join(import.meta.dir, "cpace_ref.py")], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
	proc.stdin.write(JSON.stringify(request));
	await proc.stdin.end();
	const text = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) throw new Error("cpace_ref.py failed");
	return JSON.parse(text);
}
