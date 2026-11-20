import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeClient } from "../src/client";
import { CODE_ATTEMPTS, decideConfirm, decideStart } from "../src/code-pairing";
import { decodeCode, encodeCode } from "../src/device-code";
import type { PairingOffer } from "../src/offer";
import { BridgeState, PairingsBusyError, type PendingPairing } from "../src/state";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
function tempHome(): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjcm-code-"));
	homes.push(home);
	return home;
}

const offer = (id: string): PairingOffer => ({
	v: 1,
	hostId: "h",
	name: "host",
	hostKey: Buffer.alloc(32, 1).toString("base64url"),
	endpoints: ["ws://100.100.1.2:7787/ws"],
	pairingId: id,
	secret: Buffer.alloc(32, 2).toString("base64url"),
	exp: "2999-01-01T00:00:00.000Z",
});
const row = (id: string, code?: { prs: string; attemptsLeft: number }): PendingPairing => ({
	id,
	secret: Buffer.alloc(32, 2).toString("base64url"),
	expiresAt: "2999-01-01T00:00:00.000Z",
	...(code ? { code: { ...code, offer: offer(id) } } : {}),
});

describe("device-code decisions (code-pairing.ts)", () => {
	test("start takes one attempt before anything goes out", () => {
		const { rows, result } = decideStart([row("a"), row("b", { prs: "P", attemptsLeft: CODE_ATTEMPTS })]);
		expect(result).toEqual({ kind: "start", pairingId: "b", prs: "P", left: CODE_ATTEMPTS - 1 });
		expect(rows!.find(r => r.id === "b")!.code!.attemptsLeft).toBe(CODE_ATTEMPTS - 1);
		expect(rows!.find(r => r.id === "a")).toEqual(row("a"));
	});

	test("start without a code is expired; with no attempts left the code is dropped", () => {
		expect(decideStart([row("a")]).result).toEqual({ kind: "expired" });
		const locked = decideStart([row("b", { prs: "P", attemptsLeft: 0 })]);
		expect(locked.result).toEqual({ kind: "locked" });
		expect(locked.rows![0]!.code).toBeUndefined();
	});

	test("a confirmed tag drops the code, rotates the secret and returns the offer with it", () => {
		const before = row("b", { prs: "P", attemptsLeft: 2 });
		const { rows, result } = decideConfirm([before], { pairingId: "b", prs: "P" }, true, () => "ROTATED");
		expect(rows![0]).toEqual({ id: "b", secret: "ROTATED", expiresAt: before.expiresAt });
		expect(result).toEqual({ kind: "ok", offer: { ...offer("b"), secret: "ROTATED", exp: before.expiresAt } });
	});

	test("a wrong tag reports the attempts left, and locks the code at zero", () => {
		expect(decideConfirm([row("b", { prs: "P", attemptsLeft: 3 })], { pairingId: "b", prs: "P" }, false)).toEqual({
			result: { kind: "wrong", left: 3 },
		});
		const locked = decideConfirm([row("b", { prs: "P", attemptsLeft: 0 })], { pairingId: "b", prs: "P" }, false);
		expect(locked.result).toEqual({ kind: "locked" });
		expect(locked.rows![0]!.code).toBeUndefined();
	});

	test("confirm re-checks the row: a newer code, a QR hello or expiry retire the session", () => {
		const session = { pairingId: "b", prs: "P" };
		expect(decideConfirm([], session, true).result).toEqual({ kind: "expired" });
		expect(decideConfirm([row("b")], session, true).result).toEqual({ kind: "expired" });
		expect(decideConfirm([row("b", { prs: "NEW", attemptsLeft: 5 })], session, true).result).toEqual({ kind: "expired" });
	});
});

describe("pairings.json lock", () => {
	test("createPairing with a code keeps one active code and the older QR secrets", async () => {
		const state = new BridgeState(tempHome());
		const first = await state.createPairing({ code: p => ({ prs: "ONE", attemptsLeft: 5, offer: offer(p.id) }) });
		const second = await state.createPairing({ code: p => ({ prs: "TWO", attemptsLeft: 5, offer: offer(p.id) }) });
		const rows = state.pendingPairings();
		expect(rows.map(r => [r.id, r.code?.prs])).toEqual([
			[first.id, undefined],
			[second.id, "TWO"],
		]);
		expect(rows[0]!.secret).toBe(first.secret);
		// Default lifetime 15 minutes.
		expect(Date.parse(second.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
		expect(Date.parse(second.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
	});

	test("a held lock makes writers wait about a second and then fail; a stale one is cleared", async () => {
		const home = tempHome();
		const state = new BridgeState(home);
		const lock = path.join(home, "pairings.lock");
		fs.writeFileSync(lock, "999999\n");
		const started = Date.now();
		await expect(state.createPairing()).rejects.toBeInstanceOf(PairingsBusyError);
		const waited = Date.now() - started;
		expect(waited).toBeGreaterThanOrEqual(900);
		expect(waited).toBeLessThan(3_000);
		expect(state.pendingPairings()).toHaveLength(0);
		// Released while waiting: the writer gets through.
		setTimeout(() => fs.rmSync(lock), 200);
		await state.createPairing();
		expect(state.pendingPairings()).toHaveLength(1);
		// Left behind by a crash (older than 10 s): cleared.
		fs.writeFileSync(lock, "999999\n");
		const old = new Date(Date.now() - 11_000);
		fs.utimesSync(lock, old, old);
		await state.createPairing();
		expect(state.pendingPairings()).toHaveLength(2);
		expect(fs.existsSync(lock)).toBe(false);
	});

	test("writers in one process run one at a time", async () => {
		const state = new BridgeState(tempHome());
		await Promise.all(Array.from({ length: 10 }, () => state.createPairing()));
		expect(state.pendingPairings()).toHaveLength(10);
	});

	test("expired rows are pruned by the next write", async () => {
		const home = tempHome();
		const state = new BridgeState(home);
		fs.writeFileSync(path.join(home, "pairings.json"), JSON.stringify([{ ...row("old"), expiresAt: "2000-01-01T00:00:00.000Z" }]));
		await state.createPairing();
		const stored = JSON.parse(fs.readFileSync(path.join(home, "pairings.json"), "utf8"));
		expect(stored.map((r: PendingPairing) => r.id)).not.toContain("old");
	});
});

describe("pairWithCode against bridges that cannot take it", () => {
	test("a 0.1.5 bridge (bad_hello) maps to bridge_outdated", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no", { status: 426 })),
			websocket: {
				message(ws) {
					ws.send(JSON.stringify({ t: "error", code: "bad_hello", message: "expected hello v1" }));
					ws.close(4401, "bad_hello");
				},
			},
		});
		try {
			const code = encodeCode({ ip: "100.100.1.2", port: 7787 }, 7);
			await expect(BridgeClient.pairWithCode(code, { dial: `ws://127.0.0.1:${server.port}/ws` })).rejects.toMatchObject({
				code: "bridge_outdated",
			});
		} finally {
			server.stop(true);
		}
	});

	test("malformed codes fail before dialing", async () => {
		await expect(BridgeClient.pairWithCode("0000", { dial: "ws://127.0.0.1:1/ws" })).rejects.toMatchObject({ code: "code_format" });
		await expect(BridgeClient.pairWithCode("ZPUXU36F4W", { dial: "ws://127.0.0.1:1/ws" })).rejects.toMatchObject({ code: "code_unsupported" });
	});
});

describe("gjcm-bridge pair", () => {
	const cli = path.join(import.meta.dir, "..", "src", "cli.ts");
	const pair = async (home: string, ...args: string[]) => {
		const proc = Bun.spawn([process.execPath, cli, "pair", ...args], {
			env: { ...process.env, GJCM_HOME: home, GJCM_HOST_NAME: "test-host" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		return { out, err, status: await proc.exited };
	};
	const stored = (home: string): PendingPairing[] => JSON.parse(fs.readFileSync(path.join(home, "pairings.json"), "utf8"));

	test("prints the code above the QR; 15 minutes; the code row carries the QR's offer", async () => {
		const home = tempHome();
		const { out, status } = await pair(home, "--endpoint", "ws://100.85.215.116:7787/ws", "--endpoint", "ws://192.168.0.10:7787/ws");
		expect(status).toBe(0);
		const rows = stored(home);
		expect(rows).toHaveLength(1);
		const code = rows[0]!.code!;
		expect(code.attemptsLeft).toBe(CODE_ATTEMPTS);
		expect(decodeCode(code.prs)).toMatchObject({ ok: true, endpoint: "ws://100.85.215.116:7787/ws" });
		expect(code.offer).toMatchObject({
			pairingId: rows[0]!.id,
			secret: rows[0]!.secret,
			name: "test-host",
			endpoints: ["ws://100.85.215.116:7787/ws", "ws://192.168.0.10:7787/ws"],
		});
		const formatted = code.prs.match(/.{1,4}/g)!.join("-").split("").join(" ");
		expect(out.indexOf(formatted)).toBeGreaterThan(-1);
		expect(out.indexOf(formatted)).toBeLessThan(out.indexOf("gjcm://pair?o="));
		expect(out).toContain("100.85.215.116 (Tailscale) · 15분 · 1회 · 5회 틀리면 폐기");
		expect(out).toContain("--code-lan");
		expect(Date.parse(rows[0]!.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
	});

	test("--code-lan puts the LAN address in the code; an explicit port is kept", async () => {
		const home = tempHome();
		const { out } = await pair(home, "--code-lan", "--endpoint", "ws://100.85.215.116:9000/ws", "--endpoint", "ws://192.168.0.10:9000/ws");
		expect(decodeCode(stored(home)[0]!.code!.prs)).toMatchObject({ ok: true, endpoint: "ws://192.168.0.10:9000/ws" });
		expect(out).toContain("192.168.0.10:9000 (LAN)");
	});

	test("an address no code can carry gets the QR only, with the reason", async () => {
		const home = tempHome();
		const { out, status } = await pair(home, "--endpoint", "wss://demo.example/ws");
		expect(status).toBe(0);
		expect(out).toContain("코드를 만들 수 없는 주소라 QR만 표시합니다: ws:// 주소만");
		expect(stored(home)[0]!.code).toBeUndefined();
		expect(out).toContain("gjcm://pair?o=");
		const lan = await pair(tempHome(), "--code-lan", "--endpoint", "ws://100.85.215.116:7787/ws");
		expect(lan.out).toContain("--code-lan을 줬지만");
	});

	test("the demo host (--reusable) makes no code", async () => {
		const home = tempHome();
		const { out } = await pair(home, "--reusable", "--endpoint", "ws://100.85.215.116:7787/ws");
		expect(stored(home)[0]).toMatchObject({ reusable: true });
		expect(stored(home)[0]!.code).toBeUndefined();
		expect(out).not.toContain("페어링 코드");
	});

	test("a new pair retires the previous code but not its QR", async () => {
		const home = tempHome();
		await pair(home, "--endpoint", "ws://100.85.215.116:7787/ws");
		await pair(home, "--endpoint", "ws://100.85.215.116:7787/ws");
		const rows = stored(home);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.code).toBeUndefined();
		expect(rows[1]!.code).toBeDefined();
	});

	test("a held lock ends pair with an error", async () => {
		const home = tempHome();
		fs.writeFileSync(path.join(home, "pairings.lock"), "1\n");
		const { err, status } = await pair(home, "--endpoint", "ws://100.85.215.116:7787/ws");
		expect(status).toBe(1);
		expect(err).toContain("pairings.lock");
	});
});
