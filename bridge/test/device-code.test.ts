import { describe, expect, test } from "bun:test";
import vector from "../../fixtures/cpace-vector.json";
import { CODE_ALPHABET, decodeCode, encodableEndpoint, encodeCode, formatCode, newCode, normalizeCode } from "../src/device-code";

describe("gjcm-code-v1 device codes", () => {
	test("the alphabet leaves out 0 O 1 I and keeps L", () => {
		expect(CODE_ALPHABET).toHaveLength(32);
		for (const c of "0O1I") expect(CODE_ALPHABET).not.toContain(c);
		expect(CODE_ALPHABET).toContain("L");
		expect(vector.codes.alphabet).toBe(CODE_ALPHABET);
	});

	test("fixture codes encode and decode", () => {
		for (const c of vector.codes.valid) {
			expect(encodeCode(c, c.secret)).toBe(c.code);
			expect(formatCode(c.code)).toBe(c.formatted);
			const d = decodeCode(c.formatted.toLowerCase());
			expect(d).toMatchObject({ ok: true, code: c.code, address: { ip: c.ip, port: c.port, range: c.range } });
		}
		expect(vector.codes.valid.some(c => c.code.includes("L"))).toBe(true);
	});

	test("fixture rejects: check, length, 0 O 1 I with their position, reserved types", () => {
		for (const r of vector.codes.reject) {
			const d = decodeCode(r.input);
			expect(d.ok).toBe(false);
			expect(d).toMatchObject({ error: r.error, ...(r.position ? { position: r.position } : {}) });
		}
	});

	test("normalization: case, spaces, hyphens", () => {
		for (const n of vector.codes.normalize) expect(decodeCode(n.input)).toMatchObject({ ok: true, code: n.code });
		expect(normalizeCode("ab-cd 2")).toEqual({ ok: true, code: "ABCD2" });
		expect(normalizeCode("ab0")).toEqual({ ok: false, error: "code_format", position: 3, char: "0" });
		expect(normalizeCode("a-b-o")).toEqual({ ok: false, error: "code_format", position: 3, char: "O" });
	});

	test("lengths per range, with the default port and an explicit one", () => {
		const len = (ip: string, port: number) => newCode({ ip, port }).length;
		expect([len("100.64.1.2", 7787), len("10.1.2.3", 7787), len("172.20.1.2", 7787), len("192.168.1.2", 7787)]).toEqual([10, 11, 10, 9]);
		expect([len("100.64.1.2", 8000), len("10.1.2.3", 8000), len("172.20.1.2", 8000), len("192.168.1.2", 8000)]).toEqual([14, 14, 13, 12]);
	});

	test("about 94% or more of single-character typos are caught by the check", () => {
		const code = encodeCode({ ip: "100.85.215.116", port: 7787 }, 0x12345);
		let caught = 0;
		let total = 0;
		for (let i = 0; i < code.length; i++)
			for (const c of CODE_ALPHABET) {
				if (c === code[i]) continue;
				const typo = code.slice(0, i) + c + code.slice(i + 1);
				const d = decodeCode(typo);
				total++;
				if (!d.ok) caught++;
			}
		expect(caught / total).toBeGreaterThan(0.9);
	});

	test("only ws:// to a private IPv4 on /ws fits in a code", () => {
		expect(encodableEndpoint("ws://100.85.215.116:7787/ws")).toEqual({ ok: true, address: { ip: "100.85.215.116", port: 7787, range: "tailscale" } });
		expect(encodableEndpoint("ws://192.168.0.5/ws")).toMatchObject({ ok: true, address: { port: 80 } });
		for (const endpoint of [
			"wss://demo.example/ws",
			"ws://pve3.tail3be9ef.ts.net:7787/ws",
			"ws://[fd7a:115c::1]:7787/ws",
			"ws://100.85.215.116:7787/other",
			"ws://8.8.8.8:7787/ws",
			"ws://100.128.0.1:7787/ws",
			"ws://172.32.0.1:7787/ws",
			"ws://192.168.0.5:0/ws",
			"not a url",
		]) {
			const r = encodableEndpoint(endpoint);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
		}
		expect(() => encodeCode({ ip: "8.8.8.8", port: 7787 }, 1)).toThrow();
		expect(() => encodeCode({ ip: "10.0.0.1", port: 7787 }, 2 ** 20)).toThrow();
		// Port 0 would print a code that no decoder accepts.
		expect(() => encodeCode({ ip: "10.0.0.1", port: 0 }, 1)).toThrow();
	});
});
