/**
 * WebSocket front door. One connection = one phone.
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
import type { BridgeState } from "./state";
import type { UploadStore } from "./uploads";

export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
/** RPCs slower than this are logged; a resume waits on gjc spawning a session host. */
const SLOW_RPC_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

interface Conn {
	id: string;
	phase: "hello" | "confirming" | "open" | "closed";
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
	demoOffer?: () => string;
}

export function startBridgeServer(options: BridgeServerOptions): Server<Conn> {
	const { state, hub, uploads } = options;
	const log = options.log ?? (() => {});
	const host = state.host();

	const send = (ws: ServerWebSocket<Conn>, message: unknown) => {
		const conn = ws.data;
		if (conn.phase !== "open" || !conn.cipher) return;
		ws.sendBinary(conn.cipher.seal(Buffer.from(JSON.stringify(message))));
	};

	const fail = (ws: ServerWebSocket<Conn>, code: string, message: string) => {
		ws.send(JSON.stringify({ t: "error", code, message }));
		ws.data.phase = "closed";
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

	const onHello = (ws: ServerWebSocket<Conn>, text: string) => {
		let hello: any;
		try {
			hello = JSON.parse(text);
		} catch {
			return fail(ws, "bad_hello", "hello must be JSON");
		}
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
			const pending = state.consumePairing(String(hello.pairing.id ?? ""));
			const proof = Buffer.from(String(hello.pairing.proof ?? ""), "base64url");
			const expected = pending ? pairingProof(b64urlDecode(pending.secret), deviceKey, clientEph) : undefined;
			if (!expected || proof.length !== expected.length || !crypto.timingSafeEqual(proof, expected)) {
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
		const keys = serverKeys(host.keyPair, serverEph, transcript);
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
		// Revocation (`gjcm-bridge revoke`) takes effect on the device's next frame.
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
			send(ws, { id, r: (await dispatch(ws, m, p)) ?? null });
			const ms = Math.round(performance.now() - started);
			if (ms >= SLOW_RPC_MS) log(`slow rpc ${m} ${ms}ms`);
		} catch (error: any) {
			const code = error instanceof AcpError ? error.code : -32603;
			const text = String(error?.message ?? error);
			// Method, code and message only: prompt text and file bytes never reach the log.
			log(`rpc ${m} failed ${code} ${Math.round(performance.now() - started)}ms: ${text.slice(0, 300)}`);
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
				return Response.json({ url: options.demoOffer() }, { headers: { "cache-control": "no-store" } });
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
				const conn = ws.data;
				if (conn.phase === "hello") {
					if (typeof raw !== "string") return fail(ws, "bad_hello", "hello must be a text frame");
					return onHello(ws, raw);
				}
				if (conn.phase === "closed") return;
				if (typeof raw === "string") {
					conn.phase = "closed";
					ws.close(4400, "binary_frames_required");
					return;
				}
				void onFrame(ws, Buffer.from(raw));
			},
			close(ws) {
				clearTimeout(ws.data.timer);
				ws.data.phase = "closed";
				hub.detach(ws.data.id);
				uploads.abortOwner(ws.data.id);
			},
		},
	});
}

function clientFor(ws: ServerWebSocket<Conn>, send: (ws: ServerWebSocket<Conn>, m: unknown) => void): HubClient {
	return { id: ws.data.id, deliver: (ev, p) => send(ws, { ev, p }) };
}
