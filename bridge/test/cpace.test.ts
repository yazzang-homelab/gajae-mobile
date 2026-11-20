import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import vector from "../../fixtures/cpace-vector.json";
import {
	CODE_CI,
	calculateGenerator,
	confirmationTag,
	CPaceInitiator,
	cpaceRespond,
	decodeUCoordinate,
	deriveIsk,
	elligator2,
	encodeLittleEndian,
	generatorString,
	CPACE_DSI,
	lvCat,
	openBox,
	prependLen,
	sealBox,
	sealKey,
	x25519,
} from "../src/cpace";

const unhex = (s: string) => Buffer.from(s, "hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("CPace vectors (draft-irtf-cfrg-cpace-21, fixtures/cpace-vector.json)", () => {
	test("the fixture pins the draft", () => {
		expect(vector.spec.draft).toBe("draft-irtf-cfrg-cpace-21");
		expect(vector.spec.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("prepend_len and lv_cat (draft A.1)", () => {
		expect(hex(prependLen(Buffer.alloc(0)))).toBe("00");
		expect(hex(prependLen(Buffer.from("1234")))).toBe("0431323334");
		expect(hex(prependLen(Buffer.alloc(127))).slice(0, 2)).toBe("7f");
		expect(hex(prependLen(Buffer.alloc(128))).slice(0, 4)).toBe("8001");
		expect(hex(lvCat(Buffer.from("1234"), Buffer.from("5"), Buffer.alloc(0), Buffer.from("678")))).toBe("043132333401350003363738");
	});

	test("B.1.1 generator", () => {
		const g = vector.draft.generator;
		expect(hex(generatorString(CPACE_DSI, unhex(g.prs), unhex(g.ci), unhex(g.sid)))).toBe(g.generatorString);
		expect(hex(encodeLittleEndian(decodeUCoordinate(unhex(g.hash))))).toBe(g.u);
		expect(hex(calculateGenerator(unhex(g.prs), unhex(g.ci), unhex(g.sid)))).toBe(g.g);
	});

	test("B.1.2–B.1.5 messages, K and ISK", () => {
		const e = vector.draft.exchange;
		const ya = x25519(unhex(e.ya), unhex(e.g))!;
		const yb = x25519(unhex(e.yb), unhex(e.g))!;
		expect(hex(ya)).toBe(e.Ya);
		expect(hex(yb)).toBe(e.Yb);
		expect(hex(x25519(unhex(e.ya), yb)!)).toBe(e.K);
		expect(hex(x25519(unhex(e.yb), ya)!)).toBe(e.K);
		expect(hex(Buffer.concat([lvCat(ya, unhex(e.ADa)), lvCat(yb, unhex(e.ADb))]))).toBe(e.transcriptIr);
		expect(hex(deriveIsk(unhex(e.sid), unhex(e.K), ya, unhex(e.ADa), yb, unhex(e.ADb)))).toBe(e.ISK);
		// The same through the protocol objects, with the draft's scalars and AD.
		const a = new CPaceInitiator(unhex(e.prs), { ci: unhex(e.ci), sid: unhex(e.sid), scalar: unhex(e.ya), ad: unhex(e.ADa) });
		const b = cpaceRespond(unhex(e.prs), unhex(e.sid), a.ya, { ci: unhex(e.ci), scalar: unhex(e.yb), ad: unhex(e.ADb), peerAd: unhex(e.ADa) })!;
		expect(hex(b.isk)).toBe(e.ISK);
		expect(hex(a.finish(b.yb, unhex(e.ADb))!.isk)).toBe(e.ISK);
	});

	test("B.1.10 low-order points abort, the rest match", () => {
		const { s, cases } = vector.draft.lowOrder;
		for (const c of cases) {
			const out = x25519(unhex(s), unhex(c.u));
			expect(out ? hex(out) : null).toBe(c.q);
		}
		// The abort cases also stop either side of the protocol.
		for (const c of cases.filter(c => c.q === null)) {
			expect(cpaceRespond(Buffer.from("X"), crypto.randomBytes(16), unhex(c.u))).toBeUndefined();
			expect(new CPaceInitiator(Buffer.from("X")).finish(unhex(c.u))).toBeUndefined();
		}
	});

	test("V3: Elligator2 boundary and random inputs match the independent reference", () => {
		expect(vector.map.length).toBeGreaterThanOrEqual(17);
		for (const m of vector.map) expect(hex(encodeLittleEndian(elligator2(decodeUCoordinate(unhex(m.u)))))).toBe(m.g);
	});

	test("V3: 200+ generators for gjcm-code-v1 match the independent reference", () => {
		expect(vector.generator.length).toBeGreaterThanOrEqual(200);
		for (const g of vector.generator) expect(hex(calculateGenerator(unhex(g.prs), CODE_CI, unhex(g.sid)))).toBe(g.g);
	});

	test("X25519 vectors (abort = null)", () => {
		for (const x of vector.x25519) {
			const out = x25519(unhex(x.k), unhex(x.u));
			expect(out ? hex(out) : null).toBe(x.out);
		}
	});

	test("full transaction from sid to box", () => {
		const t = vector.transaction;
		const a = new CPaceInitiator(Buffer.from(t.code), { sid: unhex(t.sid), scalar: unhex(t.ya) });
		expect(hex(a.ya)).toBe(t.Ya);
		const b = cpaceRespond(Buffer.from(t.code), unhex(t.sid), a.ya, { scalar: unhex(t.yb) })!;
		expect(hex(b.yb)).toBe(t.Yb);
		expect(hex(b.isk)).toBe(t.ISK);
		expect(hex(sealKey(b.isk))).toBe(t.kSeal);
		const session = a.finish(b.yb)!;
		expect(hex(session.ta)).toBe(t.Ta);
		const confirmed = b.confirm(session.ta)!;
		expect(hex(confirmed.tb)).toBe(t.Tb);
		expect(session.verifyTb(confirmed.tb)).toBe(true);
		expect(hex(confirmed.seal(Buffer.from(t.offer)))).toBe(t.box);
		expect(session.open(unhex(t.box))?.toString("utf8")).toBe(t.offer);
	});
});

describe("CPace protocol properties", () => {
	test("a wrong code fails both confirmations and cannot open the box", () => {
		const a = new CPaceInitiator(Buffer.from("4PUXU36F4W"));
		const b = cpaceRespond(Buffer.from("4PUXU36F4X"), a.sid, a.ya)!;
		const session = a.finish(b.yb)!;
		// The bridge hands out neither Tb nor a seal for a wrong Ta.
		expect(b.confirm(session.ta)).toBeUndefined();
		expect(b.confirm(Buffer.alloc(64))).toBeUndefined();
		// And what it would have sent under its own code proves nothing to the phone.
		expect(session.verifyTb(confirmationTag(a.sid, b.isk, b.yb, Buffer.alloc(0)))).toBe(false);
		expect(session.open(sealBox(b.isk, Buffer.from("offer")))).toBeUndefined();
	});

	test("a replayed sid and Ya get a fresh Yb and ISK every time (seal nonce invariant 1)", () => {
		const a = new CPaceInitiator(Buffer.from("4PUXU36F4W"));
		const first = cpaceRespond(Buffer.from("4PUXU36F4W"), a.sid, a.ya)!;
		const second = cpaceRespond(Buffer.from("4PUXU36F4W"), a.sid, a.ya)!;
		expect(hex(first.yb)).not.toBe(hex(second.yb));
		expect(hex(first.isk)).not.toBe(hex(second.isk));
		expect(hex(sealKey(first.isk))).not.toBe(hex(sealKey(second.isk)));
	});

	test("one session seals exactly once (invariant 2)", () => {
		const a = new CPaceInitiator(Buffer.from("CODE"));
		const b = cpaceRespond(Buffer.from("CODE"), a.sid, a.ya)!;
		const ta = a.finish(b.yb)!.ta;
		b.confirm(ta)!.seal(Buffer.from("x"));
		// A second confirm is the same session: still one seal.
		expect(() => b.confirm(ta)!.seal(Buffer.from("y"))).toThrow();
	});

	test("a tampered box does not open", () => {
		const a = new CPaceInitiator(Buffer.from("CODE"));
		const b = cpaceRespond(Buffer.from("CODE"), a.sid, a.ya)!;
		const box = b.confirm(a.finish(b.yb)!.ta)!.seal(Buffer.from("offer"));
		box[0]! ^= 1;
		expect(openBox(b.isk, box)).toBeUndefined();
		expect(openBox(b.isk, Buffer.alloc(3))).toBeUndefined();
	});

	test("malformed inputs abort instead of throwing", () => {
		expect(x25519(Buffer.alloc(31), Buffer.alloc(32, 9))).toBeUndefined();
		expect(cpaceRespond(Buffer.from("CODE"), Buffer.alloc(16), Buffer.alloc(31))).toBeUndefined();
		expect(new CPaceInitiator(Buffer.from("CODE")).finish(Buffer.alloc(33))).toBeUndefined();
	});
});
