/**
 * WebSocket front door. One connection = one phone.
 *   0. (device code, #128) text `pake` → `pake.reply`, `pake.confirm` → `pake.ok` with the sealed offer, then close;
 *      the phone dials again with the hello below. See code-pairing.ts and cpace.ts.
 *   1. text frame `hello` → text frame `welcome` (or `error` + close)
 *   2. binary frames only, each sealed with FrameCipher; payloads are JSON:
 *        phone → bridge   { id, m, p }            request
 *        bridge → phone   { id, r } | { id, e }   response
 *        bridge → phone   { ev, p }               event
 * The hub is attached only after the first phone frame decrypts (key confirmation), so
 * nothing about sessions leaves the host before both static keys are proven.
 */
import crypto from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import { AcpError } from "./acp";
import { decideConfirm, decideStart } from "./code-pairing";
import { type CPaceResponderSession, cpaceRespond } from "./cpace";
import {
	b64urlDecode,
	b64urlEncode,
	FrameCipher,
	generateKeyPair,
	type HandshakeTranscript,
	pairingProof,
	randomBytes,
	serverKeys,
} from "./crypto";
import type { HubClient, SessionHub } from "./hub";
import { type BridgeState, PairingsBusyError } from "./state";
import type { UploadStore } from "./uploads";

/** The largest frame either side takes (the apps' iOS `maximumMessageSize` is the same 32 MiB). */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
/** Room for a sealed frame's counter and tag around its JSON. */
const SEAL_OVERHEAD_BYTES = 64;
const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
/** RPCs slower than this are logged; a resume waits on gjc spawning a session host. */
const SLOW_RPC_MS = 5_000;

/** gjc's error discriminators are short identifiers (`unavailable`, `prompt_failed`, …). */
const ERROR_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The log line for a failed phone RPC. gjc reports most agent failures as `-32603 Internal error` with the
 * kind of failure in `data.code`, so that identifier goes into the line. `data.details` stays out: it is free
 * text that can quote user input. Method, codes and message only: prompt text and file bytes never reach the log.
 */
export function rpcFailureLine(method: string, code: number, ms: number, message: string, data: unknown): string {
	const kind = (data as { code?: unknown } | null | undefined)?.code;
	const detail = typeof kind === "string" && ERROR_CODE_RE.test(kind) ? ` (${kind})` : "";
	return `rpc ${method} failed ${code}${detail} ${ms}ms: ${message.slice(0, 300)}`;
}
const HANDSHAKE_TIMEOUT_MS = 15_000;

interface Conn {
	id: string;
	/** `verifying`: a pairing hello waits for pairings.json; `pake`: a device-code session (#128). */
	phase: "hello" | "verifying" | "pake" | "confirming" | "open" | "closed";
	pake?: { pairingId: string; prs: string; session: CPaceResponderSession };
	cipher?: FrameCipher;
	deviceKey?: string;
	deviceName?: string;
	timer?: ReturnType<typeof setTimeout>;
}

export interface BridgeServerOptions {
	hostname: string;
	port: number;
	state: BridgeState;
	hub: SessionHub;
	uploads: UploadStore;
	log?: (line: string) => void;
	/** Review demo host only: `GET /offer` hands out its reusable pairing link (the apps' "데모로 체험");
	 *  `GET /privacy` serves the store listings' privacy policy (bridge/demo/privacy.html). */
	demoOffer?: () => Promise<string>;
}

export function startBridgeServer(options: BridgeServerOptions): Server<Conn> {
	const { state, hub, uploads } = options;
	const log = options.log ?? (() => {});
	const host = state.host();

	/**
	 * A phone drops the connection on a frame over its limit and dials again into the same frame (2026-11-08, pve1: 32
	 * reconnects 0.55s apart). So nothing over it goes out: an event that big is skipped, and an answer that big becomes
	 * a `response_too_large` error (see `onFrame`).
	 */
	const fitsFrame = (body: Buffer) => body.length <= MAX_FRAME_BYTES - SEAL_OVERHEAD_BYTES;
	const sendBody = (ws: ServerWebSocket<Conn>, body: Buffer) => {
		const conn = ws.data;
		if (conn.phase !== "open" || !conn.cipher) return;
		// `gjcm-bridge revoke` runs in another process and rewrites devices.json; check it before anything goes out.
		let paired: boolean;
		try {
			paired = state.findDevice(conn.deviceKey!) !== undefined;
		} catch (error) {
			// An unreadable devices.json must not travel up into the hub's delivery loop: only this connection ends.
			log(`device check failed, closing the connection: ${error instanceof Error ? error.message : String(error)}`);
			conn.phase = "closed";
			ws.close(1011, "internal_error");
			return;
		}
		if (!paired) {
			conn.phase = "closed";
			ws.close(4403, "device_revoked");
			return;
		}
		ws.sendBinary(conn.cipher.seal(body));
	};
	const send = (ws: ServerWebSocket<Conn>, message: { id?: number; e?: unknown; ev?: string; p?: unknown }) => {
		const body = Buffer.from(JSON.stringify(message));
		if (fitsFrame(body)) return sendBody(ws, body);
		const sessionId = (message.p as { sessionId?: unknown } | undefined)?.sessionId;
		const what = message.ev ? `event ${message.ev} session=${String(sessionId ?? "-")}` : `reply id=${message.id}`;
		log(`skipped ${what}: ${body.length} bytes over the ${MAX_FRAME_BYTES}-byte frame limit`);
	};

	/** The connection running a device-code session: one per bridge, as there is one active code (#128). */
	let pakeInFlight: string | undefined;
	/** A finished code session frees the slot at once, so a retyped code does not race the close into `code_busy`. */
	const endPake = (conn: Conn) => {
		conn.pake = undefined;
		if (pakeInFlight === conn.id) pakeInFlight = undefined;
	};

	const fail = (ws: ServerWebSocket<Conn>, code: string, message: string, extra: Record<string, unknown> = {}) => {
		ws.send(JSON.stringify({ t: "error", code, message, ...extra }));
		ws.data.phase = "closed";
		endPake(ws.data);
		ws.close(4401, code);
	};

	const dispatch = async (ws: ServerWebSocket<Conn>, method: string, p: any): Promise<unknown> => {
		const clientId = ws.data.id;
		switch (method) {
			case "host.info":
				return hub.hostInfo();
			case "session.list":
				return hub.listSessions({ cwd: p?.cwd, cursor: p?.cursor, query: p?.query });
			case "session.new":
				return hub.newSession(clientId, { cwd: p?.cwd });
			case "session.open":
				return hub.openSession(clientId, { sessionId: p.sessionId, cwd: p.cwd, afterSeq: p.afterSeq });
			case "session.fork":
				return hub.forkSession(clientId, { sessionId: p.sessionId, cwd: p.cwd });
			case "session.delete":
				return hub.deleteSession({ sessionId: p.sessionId });
			case "session.close":
				hub.closeSession(clientId, p.sessionId);
				return { ok: true };
			case "session.prompt":
				return hub.prompt({ sessionId: p.sessionId, prompt: p.prompt });
			case "session.interrupt":
				return hub.interrupt({ sessionId: p.sessionId });
			case "session.cancel":
				return hub.cancel({ sessionId: p.sessionId });
			case "session.setConfig":
				return hub.setConfig({ sessionId: p.sessionId, configId: p.configId, value: p.value });
			case "session.setPermissionMode":
				return hub.setPermissionMode({ sessionId: p.sessionId, mode: p.mode });
			case "model.roles":
				return hub.modelRoles();
			case "model.setRole":
				return hub.setModelRole({ sessionId: p.sessionId, role: p.role, value: p.value ?? null });
			case "sdk.query":
				return hub.sdk({ sessionId: p.sessionId, kind: "query", op: p.op, input: p.input });
			case "sdk.control":
				return hub.sdk({ sessionId: p.sessionId, kind: "control", op: p.op, input: p.input, confirm: p.confirm === true });
			case "permission.respond":
				return hub.respondPermission({ requestId: p.requestId, optionId: p.optionId });
			case "permission.list":
				return { requests: hub.pendingPermissions() };
			case "upload.begin":
				return uploads.begin(clientId, p);
			case "upload.chunk":
				return uploads.chunk(clientId, p);
			case "upload.commit":
				return uploads.commit(clientId, p);
			case "ping":
				return { pong: Date.now() };
			default:
				throw new AcpError(-32601, `unknown method ${method}`);
		}
	};

	const onHello = async (ws: ServerWebSocket<Conn>, hello: any) => {
		if (hello?.t !== "hello" || hello.v !== 1) return fail(ws, "bad_hello", "expected hello v1");
		let deviceKey: Buffer;
		let clientEph: Buffer;
		let clientNonce: Buffer;
		try {
			deviceKey = b64urlDecode(hello.deviceKey);
			clientEph = b64urlDecode(hello.eph);
			clientNonce = b64urlDecode(hello.nonce);
		} catch {
			return fail(ws, "bad_hello", "malformed keys");
		}
		if (deviceKey.length !== 32 || clientEph.length !== 32 || clientNonce.length !== 16) {
			return fail(ws, "bad_hello", "malformed keys");
		}
		const deviceKeyText = b64urlEncode(deviceKey);
		if (hello.pairing) {
			const proof = Buffer.from(String(hello.pairing.proof ?? ""), "base64url");
			ws.data.phase = "verifying";
			let pending: Awaited<ReturnType<typeof state.consumePairing>>;
			try {
				pending = await state.consumePairing(String(hello.pairing.id ?? ""), candidate => {
					const expected = pairingProof(b64urlDecode(candidate.secret), deviceKey, clientEph);
					return proof.length === expected.length && crypto.timingSafeEqual(proof, expected);
				});
			} catch (error) {
				if (!(error instanceof PairingsBusyError)) throw error;
				log(`pairing busy device=${deviceKeyText.slice(0, 8)}`);
				return fail(ws, "pairing_busy", "the host is busy; try again in a moment");
			}
			if (ws.data.phase !== "verifying") return; // closed meanwhile
			if (!pending) {
				log(`pairing rejected device=${deviceKeyText.slice(0, 8)}`);
				return fail(ws, "pairing_invalid", "pairing code is invalid, used, or expired");
			}
			state.upsertDevice({
				deviceKey: deviceKeyText,
				name: String(hello.name ?? "iPhone").slice(0, 64),
				pairedAt: new Date().toISOString(),
			});
			log(`paired device=${deviceKeyText.slice(0, 8)} name=${hello.name ?? ""}`);
		} else if (!state.findDevice(deviceKeyText)) {
			return fail(ws, "unknown_device", "this device is not paired with the host");
		}
		const serverEph = generateKeyPair();
		const serverNonce = randomBytes(16);
		const transcript: HandshakeTranscript = {
			deviceKey,
			hostKey: host.keyPair.publicKey,
			clientEph,
			serverEph: serverEph.publicKey,
			clientNonce,
			serverNonce,
		};
		let keys: ReturnType<typeof serverKeys>;
		try {
			keys = serverKeys(host.keyPair, serverEph, transcript);
		} catch {
			// A device key is public, so anyone can send an ephemeral key that the key agreement rejects (all zero bytes).
			log(`rejected hello device=${deviceKeyText.slice(0, 8)}: key agreement failed`);
			return fail(ws, "bad_hello", "malformed keys");
		}
		ws.data.cipher = new FrameCipher(keys.s2c, keys.c2s);
		ws.data.deviceKey = deviceKeyText;
		ws.data.deviceName = state.findDevice(deviceKeyText)?.name;
		ws.data.phase = "confirming";
		ws.send(
			JSON.stringify({
				t: "welcome",
				v: 1,
				hostId: host.hostId,
				eph: b64urlEncode(serverEph.publicKey),
				nonce: b64urlEncode(serverNonce),
			}),
		);
	};

	const onPake = async (ws: ServerWebSocket<Conn>, message: any) => {
		const conn = ws.data;
		let sid: Buffer;
		let ya: Buffer;
		try {
			sid = b64urlDecode(String(message.sid ?? ""));
			ya = b64urlDecode(String(message.ya ?? ""));
		} catch {
			return fail(ws, "bad_pake", "malformed pake");
		}
		if (message.v !== 1 || sid.length !== 16 || ya.length !== 32) return fail(ws, "bad_pake", "malformed pake");
		if (pakeInFlight !== undefined) {
			log("pake busy");
			return fail(ws, "code_busy", "another device is using the code");
		}
		pakeInFlight = conn.id;
		conn.phase = "pake";
		let decision: Awaited<ReturnType<typeof decideStart>>["result"];
		try {
			decision = await state.mutatePairings(rows => decideStart(rows));
		} catch (error) {
			if (!(error instanceof PairingsBusyError)) throw error;
			log("pake busy (pairings locked)");
			return fail(ws, "code_busy", "the host is busy; try again in a moment");
		}
		if (conn.phase !== "pake") return; // closed meanwhile; the attempt stays used
		if (decision.kind === "expired") {
			log("pake expired");
			return fail(ws, "code_expired", "no active code, or it expired or was used");
		}
		if (decision.kind === "locked") {
			log("pake locked");
			return fail(ws, "code_locked", "too many wrong attempts; run gjcm-bridge pair again");
		}
		const session = cpaceRespond(Buffer.from(decision.prs), sid, ya);
		if (!session) {
			log(`pake rejected point left=${decision.left}`);
			return fail(ws, "bad_pake", "invalid pake point");
		}
		conn.pake = { pairingId: decision.pairingId, prs: decision.prs, session };
		log(`pake start left=${decision.left}`);
		ws.send(JSON.stringify({ t: "pake.reply", yb: b64urlEncode(session.yb), left: decision.left }));
	};

	const onPakeConfirm = async (ws: ServerWebSocket<Conn>, message: any) => {
		const conn = ws.data;
		const pake = conn.pake;
		if (!pake || message?.t !== "pake.confirm") return fail(ws, "bad_pake", "expected pake.confirm");
		conn.pake = undefined;
		let ta: Buffer;
		try {
			ta = b64urlDecode(String(message.ta ?? ""));
		} catch {
			return fail(ws, "bad_pake", "malformed pake.confirm");
		}
		const confirmed = pake.session.confirm(ta);
		const tagOk = confirmed !== undefined;
		let decision: Awaited<ReturnType<typeof decideConfirm>>["result"];
		try {
			decision = await state.mutatePairings(rows => decideConfirm(rows, pake, tagOk));
		} catch (error) {
			if (!(error instanceof PairingsBusyError)) throw error;
			log("pake busy (pairings locked)");
			return fail(ws, "code_busy", "the host is busy; try again in a moment");
		}
		if (conn.phase !== "pake") return;
		switch (decision.kind) {
			case "expired":
				log("pake expired");
				return fail(ws, "code_expired", "the code expired or was used");
			case "locked":
				log("pake locked");
				return fail(ws, "code_locked", "too many wrong attempts; run gjcm-bridge pair again");
			case "wrong":
				log(`pake wrong left=${decision.left}`);
				return fail(ws, "code_wrong", "wrong code", { left: decision.left });
			case "ok": {
				// Tb and the box exist only because Ta proved the phone knows the code (decideConfirm is ok only then).
				if (!confirmed) throw new Error("pake: ok without a confirmed Ta");
				const box = confirmed.seal(Buffer.from(JSON.stringify(decision.offer)));
				log("pake ok");
				ws.send(JSON.stringify({ t: "pake.ok", tb: b64urlEncode(confirmed.tb), box: b64urlEncode(box) }));
				conn.phase = "closed";
				endPake(conn);
				ws.close(1000, "pake_ok");
				return;
			}
		}
	};

	const onText = async (ws: ServerWebSocket<Conn>, text: string) => {
		const conn = ws.data;
		let message: any;
		try {
			message = JSON.parse(text);
		} catch {
			return fail(ws, conn.phase === "pake" ? "bad_pake" : "bad_hello", "expected JSON");
		}
		if (conn.phase === "pake") return onPakeConfirm(ws, message);
		if (message?.t === "pake") return onPake(ws, message);
		return onHello(ws, message);
	};

	const handleMessage = (ws: ServerWebSocket<Conn>, raw: string | Buffer) => {
		const conn = ws.data;
		if (conn.phase === "hello" || conn.phase === "pake") {
			if (typeof raw !== "string") return fail(ws, conn.phase === "pake" ? "bad_pake" : "bad_hello", "expected a text frame");
			// Async: report a failure on this connection only.
			onText(ws, raw).catch(error => {
				log(`handshake failed: ${error instanceof Error ? error.message : String(error)}`);
				ws.data.phase = "closed";
				ws.close(1011, "internal_error");
			});
			return;
		}
		if (conn.phase === "closed") return;
		if (conn.phase === "verifying") {
			conn.phase = "closed";
			ws.close(4400, "unexpected_frame");
			return;
		}
		if (typeof raw === "string") {
			conn.phase = "closed";
			ws.close(4400, "binary_frames_required");
			return;
		}
		// `onFrame` is async, so the `message` handler's catch does not see what it throws.
		onFrame(ws, Buffer.from(raw)).catch(error => {
			log(`frame handler failed: ${error instanceof Error ? error.message : String(error)}`);
			ws.data.phase = "closed";
			ws.close(1011, "internal_error");
		});
	};

	const onFrame = async (ws: ServerWebSocket<Conn>, frame: Buffer) => {
		const conn = ws.data;
		let message: any;
		try {
			message = JSON.parse(conn.cipher!.open(frame).toString("utf8"));
		} catch {
			conn.phase = "closed";
			ws.close(4400, "decrypt_failed");
			return;
		}
		// Revocation (`gjcm-bridge revoke`) also takes effect on the device's next frame.
		if (!state.findDevice(conn.deviceKey!)) {
			conn.phase = "closed";
			ws.close(4403, "device_revoked");
			return;
		}
		if (conn.phase === "confirming") {
			conn.phase = "open";
			clearTimeout(conn.timer);
			state.touchDevice(conn.deviceKey!);
			hub.attach(clientFor(ws, send));
			log(`connected device=${conn.deviceKey!.slice(0, 8)}`);
		}
		const { id, m, p } = message ?? {};
		if (typeof id !== "number" || typeof m !== "string") return;
		const started = performance.now();
		try {
			const body = Buffer.from(JSON.stringify({ id, r: (await dispatch(ws, m, p)) ?? null }));
			if (!fitsFrame(body))
				throw new AcpError(-32030, `응답이 너무 커서(${mib(body.length)}) 폰으로 보낼 수 없습니다. 한도는 ${mib(MAX_FRAME_BYTES)}입니다.`, {
					code: "response_too_large",
					bytes: body.length,
					limit: MAX_FRAME_BYTES,
				});
			sendBody(ws, body);
			const ms = Math.round(performance.now() - started);
			if (ms >= SLOW_RPC_MS) log(`slow rpc ${m} ${ms}ms`);
		} catch (error: any) {
			const code = error instanceof AcpError ? error.code : -32603;
			const text = String(error?.message ?? error);
			log(rpcFailureLine(m, code, Math.round(performance.now() - started), text, error?.data));
			send(ws, { id, e: { code, message: text, data: error?.data } });
		}
	};

	return Bun.serve<Conn>({
		hostname: options.hostname,
		port: options.port,
		fetch(req, server) {
			const url = new URL(req.url);
			if (url.pathname === "/health") return Response.json({ ok: true, hostId: host.hostId });
			if (url.pathname === "/privacy" && options.demoOffer)
				return new Response(Bun.file(new URL("../demo/privacy.html", import.meta.url)), { headers: { "content-type": "text/html; charset=utf-8" } });
			if (url.pathname === "/offer" && options.demoOffer)
				return options.demoOffer().then(
					offer => Response.json({ url: offer }, { headers: { "cache-control": "no-store" } }),
					error => {
						// A `pair` holding pairings.lock is a moment's wait, not a server error.
						if (!(error instanceof PairingsBusyError)) throw error;
						return Response.json({ error: "pairing_busy" }, { status: 503, headers: { "retry-after": "1", "cache-control": "no-store" } });
					},
				);
			if (url.pathname === "/ws") {
				const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), phase: "hello" } as Conn });
				return upgraded ? undefined : new Response("upgrade required", { status: 426 });
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			maxPayloadLength: MAX_FRAME_BYTES,
			idleTimeout: 240,
			sendPings: true,
			open(ws) {
				ws.data.timer = setTimeout(() => {
					if (ws.data.phase !== "open") ws.close(4408, "handshake_timeout");
				}, HANDSHAKE_TIMEOUT_MS);
			},
			message(ws, raw) {
				try {
					handleMessage(ws, raw);
				} catch (error) {
					// One bad frame must not take the whole bridge down with every other phone's connection.
					log(`message handler failed: ${error instanceof Error ? error.message : String(error)}`);
					ws.data.phase = "closed";
					ws.close(1011, "internal_error");
				}
			},
			close(ws, code, reason) {
				// Who closed tells a drop the app chose (it closes with 1000, e.g. on a frame over its limit) from a lost network
				// (1006) or the bridge's own 44xx (#88).
				// The reason comes from the peer, maybe before it proved its key: quoted so it cannot add a log line.
				if (ws.data.deviceKey) log(`disconnected device=${ws.data.deviceKey.slice(0, 8)} code=${code}${reason ? ` reason=${JSON.stringify(reason)}` : ""}`);
				clearTimeout(ws.data.timer);
				ws.data.phase = "closed";
				endPake(ws.data);
				hub.detach(ws.data.id);
				uploads.abortOwner(ws.data.id);
			},
		},
	});
}

function clientFor(ws: ServerWebSocket<Conn>, send: (ws: ServerWebSocket<Conn>, m: { ev: string; p: unknown }) => void): HubClient {
	return { id: ws.data.id, device: ws.data.deviceKey, deliver: (ev, p) => send(ws, { ev, p }) };
}
