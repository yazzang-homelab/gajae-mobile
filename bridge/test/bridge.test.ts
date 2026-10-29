import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BridgeClient, BridgeClientError } from "../src/client";
import { generateKeyPair } from "../src/crypto";
import { AGENT_EXIT, PERMISSION_MODE_UPDATE, TURN_END, supportedConfigOptions } from "../src/hub";
import { parseOfferUrl, offerUrl } from "../src/offer";
import { rpcFailureLine } from "../src/server";
import { CHUNK_BYTES } from "../src/uploads";
import { startTestBridge } from "./helpers";

const running: Array<Awaited<ReturnType<typeof startTestBridge>>> = [];
afterEach(async () => {
	await Promise.all(running.splice(0).map(b => b.stop()));
});
async function useBridge() {
	const bridge = await startTestBridge();
	running.push(bridge);
	return bridge;
}

const turnEnd = (sessionId: string) => (e: { ev: string; p: any }) =>
	e.ev === "session.update" && e.p.sessionId === sessionId && e.p.update.sessionUpdate === TURN_END;

describe("pairing and authentication", () => {
	test("offer URL round-trips", async () => {
		const bridge = await useBridge();
		const offer = bridge.offer();
		expect(parseOfferUrl(offerUrl(offer))).toEqual(offer);
	});

	test("pairing enrolls the device once; reconnect works without the secret", async () => {
		const bridge = await useBridge();
		const { client, identity } = await bridge.pairedClient("내 아이폰");
		expect((await client.request("ping")).pong).toBeNumber();
		client.close();
		expect(bridge.state.devices().map(d => d.name)).toEqual(["내 아이폰"]);
		const again = await BridgeClient.connect(bridge.endpoint, identity);
		expect((await again.request("host.info")).agentInfo.name).toBe("fake-gjc");
		again.close();
	});

	test("a used or forged pairing secret is rejected", async () => {
		const bridge = await useBridge();
		const offer = bridge.offer();
		const first = await BridgeClient.connect(bridge.endpoint, BridgeClient.identityFromOffer(offer), {
			pairing: { id: offer.pairingId, secret: offer.secret },
		});
		first.close();
		const reuse = BridgeClient.connect(bridge.endpoint, BridgeClient.identityFromOffer(offer), {
			pairing: { id: offer.pairingId, secret: offer.secret },
		});
		await expect(reuse).rejects.toMatchObject({ code: "pairing_invalid" });
		const o2 = bridge.offer();
		const forged = BridgeClient.connect(bridge.endpoint, BridgeClient.identityFromOffer(o2), {
			pairing: { id: o2.pairingId, secret: Buffer.alloc(32).toString("base64url") },
		});
		await expect(forged).rejects.toMatchObject({ code: "pairing_invalid" });
		expect(bridge.state.devices()).toHaveLength(1);
	});

	test("unknown devices are refused and wrong host keys never get a response", async () => {
		const bridge = await useBridge();
		const offer = bridge.offer();
		await expect(BridgeClient.connect(bridge.endpoint, BridgeClient.identityFromOffer(offer))).rejects.toMatchObject({
			code: "unknown_device",
		});
		const { identity } = await bridge.pairedClient();
		const impostorView = { device: identity.device, hostKey: generateKeyPair().publicKey };
		const client = await BridgeClient.connect(bridge.endpoint, impostorView);
		const request = client.request("host.info");
		await expect(request).rejects.toBeInstanceOf(BridgeClientError);
		expect((await client.closed).reason).toBe("decrypt_failed");
	});

	test("revoked devices are disconnected on their next frame", async () => {
		const bridge = await useBridge();
		const { client, identity } = await bridge.pairedClient("old phone");
		await client.request("ping");
		bridge.state.revokeDevice("old phone");
		await expect(client.request("ping")).rejects.toBeInstanceOf(BridgeClientError);
		expect((await client.closed).reason).toBe("device_revoked");
		await expect(BridgeClient.connect(bridge.endpoint, identity)).rejects.toMatchObject({ code: "unknown_device" });
	});
});

describe("gjc ACP process failures", () => {
	test("a gjc that dies before answering initialize reports its exit code and stderr", async () => {
		const dying = [
			process.execPath,
			"-e",
			"console.error('starting'); console.error('\\x1b[31mError: No models available.\\x1b[39m'); process.exit(3)",
		];
		const bridge = await startTestBridge(dying);
		running.push(bridge);
		const { client } = await bridge.pairedClient();
		const failure = await client.request("host.info").catch(error => error);
		expect(failure).toBeInstanceOf(BridgeClientError);
		expect(failure.code).toBe(-32000);
		expect(failure.message).toBe("gjc ACP process exited (code 3): starting | Error: No models available.");
	});

	test("a failed rpc log line names gjc's error kind but never its free-text details", () => {
		const data = { code: "prompt_failed", details: "model rejected: <the user's prompt text>" };
		expect(rpcFailureLine("session.new", -32603, 2552, "Internal error", data)).toBe(
			"rpc session.new failed -32603 (prompt_failed) 2552ms: Internal error",
		);
		// A code that is not a plain identifier is free text too.
		expect(rpcFailureLine("session.new", -32603, 1, "Internal error", { code: "see: my secret prompt" })).toBe(
			"rpc session.new failed -32603 1ms: Internal error",
		);
		expect(rpcFailureLine("host.info", -32000, 5, "gjc ACP process exited", undefined)).toBe(
			"rpc host.info failed -32000 5ms: gjc ACP process exited",
		);
	});
});

describe("sessions over the bridge", () => {
	test("new session, prompt with permission approval, streamed updates, turn end", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const opened = await client.request("session.new", { cwd: "/tmp" });
		expect(opened.configOptions.map((c: any) => c.id)).toEqual(["model", "thinking"]);
		const sid = opened.sessionId;
		expect(await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "run a tool" }] })).toEqual({ accepted: true });
		const perm = await client.waitFor(e => e.ev === "permission.request");
		expect(perm.p.sessionId).toBe(sid);
		expect(perm.p.options.map((o: any) => o.optionId)).toEqual(["allow_once", "reject_once"]);
		await expect(client.request("permission.respond", { requestId: perm.p.requestId, optionId: "nope" })).rejects.toBeInstanceOf(BridgeClientError);
		expect(await client.request("permission.respond", { requestId: perm.p.requestId, optionId: "allow_once" })).toEqual({ ok: true });
		const end = await client.waitFor(turnEnd(sid));
		expect(end.p.update.stopReason).toBe("end_turn");
		// gjc emits session_info_update right after the session/new reply, so it may land in the
		// snapshot or arrive live; the phone merges both by seq, so check the union.
		const live = client.events.filter(e => e.ev === "session.update").map(e => e.p);
		const all = [...opened.updates, ...live];
		const seqs = all.map((u: any) => u.seq);
		expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
		const kinds = all.map((u: any) => u.update.sessionUpdate).filter((k: string) => k !== "session_info_update");
		expect(kinds).toEqual(["user_message_chunk", "tool_call", "tool_call_update", "agent_message_chunk", "agent_message_chunk", TURN_END]);
		expect(client.events.some(e => e.ev === "permission.resolved")).toBe(true);
	});

	test("reconnecting with afterSeq gets only the missed updates; pending permission is re-offered", async () => {
		const bridge = await useBridge();
		const { client, identity } = await bridge.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "hello" }] });
		await client.waitFor(turnEnd(sid));
		const lastSeq = Math.max(...client.events.filter(e => e.ev === "session.update").map(e => e.p.seq));
		client.close();

		const second = await BridgeClient.connect(bridge.endpoint, identity);
		const resumed = await second.request("session.open", { sessionId: sid, afterSeq: lastSeq });
		expect(resumed.reset).toBe(false);
		expect(resumed.updates).toEqual([]);
		await second.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "tool please" }] });
		await second.waitFor(e => e.ev === "permission.request");
		second.close();

		const third = await BridgeClient.connect(bridge.endpoint, identity);
		// A phone that reconnects without opening the chat (widget refresh) still learns what is waiting.
		const pending = await third.request("permission.list", {});
		expect(pending.requests.map((r: any) => r.sessionId)).toEqual([sid]);
		const snap = await third.request("session.open", { sessionId: sid, afterSeq: lastSeq });
		expect(snap.running).toBe(true);
		expect(snap.permissions).toHaveLength(1);
		expect(snap.updates[0].seq).toBe(lastSeq + 1);
		await third.request("permission.respond", { requestId: snap.permissions[0].requestId, optionId: "reject_once" });
		const end = await third.waitFor(turnEnd(sid));
		expect(end.p.update.stopReason).toBe("cancelled");
		const fresh = await third.request("session.open", { sessionId: sid, afterSeq: 0 });
		expect(fresh.reset).toBe(true);
		expect(fresh.updates[0].seq).toBe(1);
	});

	test("a second turn is refused while one is running; cancel resolves the parked permission", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "tool" }] });
		await client.waitFor(e => e.ev === "permission.request");
		await expect(client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "x" }] })).rejects.toMatchObject({ code: -32003 });
		await client.request("session.cancel", { sessionId: sid });
		expect((await client.waitFor(turnEnd(sid))).p.update.stopReason).toBe("cancelled");
	});

	test("session.open on a session not loaded in this process replays history via session/load", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "기억해" }] });
		await client.waitFor(turnEnd(sid));
		const listed = await client.request("session.list", {});
		expect(listed.sessions.map((s: any) => s.sessionId)).toContain(sid);
		// The agent dies mid-turn: the turn ends with an error, and the next open must reload
		// history from gjc's own session store instead of serving the dead process's buffer.
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "crash" }] });
		const died = await client.waitFor(e => turnEnd(sid)(e) && e.p.update.stopReason === "error");
		expect(client.events.some(e => e.ev === "session.update" && e.p.update.sessionUpdate === AGENT_EXIT)).toBe(true);
		expect(died.p.update.error).toContain("exited");
		const reopened = await client.request("session.open", { sessionId: sid, afterSeq: 3 });
		expect(reopened.reset).toBe(true);
		expect(reopened.updates.map((u: any) => u.update.content?.text)).toEqual(["기억해", "crash"]);
	});

	test("config changes go through session/set_config_option", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		const res = await client.request("session.setConfig", { sessionId: sid, configId: "model", value: "fake/model-b" });
		expect(res.configOptions.find((c: any) => c.id === "model").currentValue).toBe("fake/model-b");
	});

	test("an effort change uses gjc's thinking.set, not the catalog-rebuilding set_config_option, and tells every client", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		const started = Date.now();
		const res = await client.request("session.setConfig", { sessionId: sid, configId: "thinking", value: "high" });
		expect(Date.now() - started).toBeLessThan(1000);
		expect(res.configOptions.find((c: any) => c.id === "thinking").currentValue).toBe("high");
		const update = await client.waitFor(e => e.ev === "session.update" && e.p.update.sessionUpdate === "config_option_update");
		expect(update.p.update.configOptions.find((c: any) => c.id === "thinking").currentValue).toBe("high");
		const bad = await client.request("session.setConfig", { sessionId: sid, configId: "thinking", value: "ultra" }).catch((e: any) => e);
		expect(bad.code).toBe(-32602);
	});

	test("permission mode: allow skips the prompt, deny rejects, and the mode survives an ACP restart", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const opened = await client.request("session.new", {});
		const sid = opened.sessionId;
		expect(opened.permissionMode).toBe("prompt");
		const bad = await client.request("session.setPermissionMode", { sessionId: sid, mode: "yolo" }).catch((e: any) => e);
		expect(bad.code).toBe(-32602);
		// Not a raw passthrough any more: the bridge must see every change to reapply it after a reload.
		const raw = await client.request("sdk.control", { sessionId: sid, op: "permission_mode.set", input: { mode: "allow" } }).catch((e: any) => e);
		expect(raw.code).toBe(-32601);

		expect(await client.request("session.setPermissionMode", { sessionId: sid, mode: "allow" })).toEqual({ mode: "allow" });
		const changed = await client.waitFor(e => e.ev === "session.update" && e.p.update.sessionUpdate === PERMISSION_MODE_UPDATE);
		expect(changed.p.update.mode).toBe("allow");
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "tool" }] });
		expect((await client.waitFor(turnEnd(sid))).p.update.stopReason).toBe("end_turn");
		expect(client.events.some(e => e.ev === "permission.request")).toBe(false);

		// gjc resets the mode on every attachment; after the ACP process dies the reload must reapply it.
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "crash" }] });
		await client.waitFor(e => turnEnd(sid)(e) && e.p.update.stopReason === "error");
		const reopened = await client.request("session.open", { sessionId: sid, afterSeq: 0 });
		expect(reopened.permissionMode).toBe("allow");
		client.events.length = 0;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "tool" }] });
		expect((await client.waitFor(turnEnd(sid))).p.update.stopReason).toBe("end_turn");
		expect(client.events.some(e => e.ev === "permission.request")).toBe(false);

		await client.request("session.setPermissionMode", { sessionId: sid, mode: "deny" });
		client.events.length = 0;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "tool" }] });
		expect((await client.waitFor(turnEnd(sid))).p.update.stopReason).toBe("cancelled");
		expect(client.events.some(e => e.ev === "permission.request")).toBe(false);
	});

	test("switching to allow settles a prompt that is already waiting", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "tool" }] });
		await client.waitFor(e => e.ev === "permission.request");
		await client.request("session.setPermissionMode", { sessionId: sid, mode: "allow" });
		expect((await client.waitFor(turnEnd(sid))).p.update.stopReason).toBe("end_turn");
		expect(client.events.some(e => e.ev === "permission.resolved")).toBe(true);
	});

	test("a config change after an ACP restart asks the phone to reopen instead of failing with Unknown session", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		const before = (await client.request("host.info", {})).agentInfo.version;
		bridge.hangup();
		await Bun.sleep(200);
		expect((await client.request("host.info", {})).agentInfo.version).not.toBe(before);
		const stale = await client.request("session.setConfig", { sessionId: sid, configId: "model", value: "fake/model-b" }).catch((e: any) => e);
		expect(stale.code).toBe(-32002);
		await client.request("session.open", { sessionId: sid });
		const res = await client.request("session.setConfig", { sessionId: sid, configId: "model", value: "fake/model-b" });
		expect(res.configOptions.find((c: any) => c.id === "model").currentValue).toBe("fake/model-b");
	});

	test("per-role models are read from config.yml and written through gjc's config.patch", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const configFile = path.join(bridge.home, "agent", "config.yml");
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(
			configFile,
			"modelRoles:\n  default: fake/model-a:medium\ntask:\n  agentModelOverrides:\n    executor: fake/model-b:high\n    critic: fake/model-a:xhigh\ntheme:\n  dark: x\n",
		);
		const read = await client.request("model.roles", {});
		expect(read.roles.map((r: any) => [r.id, r.value ?? null])).toEqual([
			["default", "fake/model-a:medium"],
			["executor", "fake/model-b:high"],
			["architect", null],
			["planner", null],
			["critic", "fake/model-a:xhigh"],
		]);
		const sid = (await client.request("session.new", {})).sessionId;
		const set = await client.request("model.setRole", { sessionId: sid, role: "planner", value: "fake/model-b:low" });
		expect(set.roles.find((r: any) => r.id === "planner").value).toBe("fake/model-b:low");
		await client.request("model.setRole", { sessionId: sid, role: "executor", value: null });
		const written = Bun.YAML.parse(fs.readFileSync(configFile, "utf8")) as any;
		// Other roles and unrelated settings survive; the cleared role falls back to gjc's default.
		expect(written.task.agentModelOverrides).toEqual({ critic: "fake/model-a:xhigh", planner: "fake/model-b:low" });
		expect(written.modelRoles).toEqual({ default: "fake/model-a:medium" });
		expect(written.theme).toEqual({ dark: "x" });

		const bad = await client.request("model.setRole", { sessionId: sid, role: "image", value: "fake/model-a" }).catch((e: any) => e);
		expect(bad.code).toBe(-32602);
		const junk = await client.request("model.setRole", { sessionId: sid, role: "critic", value: "x; rm -rf /" }).catch((e: any) => e);
		expect(junk.code).toBe(-32602);
		// The generic passthrough still refuses config.patch from the phone.
		const raw = await client.request("sdk.control", { sessionId: sid, op: "config.patch", input: { patch: {} } }).catch((e: any) => e);
		expect(raw.code).toBe(-32601);

		fs.appendFileSync(configFile, "modelProfile:\n  default: ox-luna\n");
		expect((await client.request("model.roles", {})).profile).toBe("ox-luna");
		const shadowed = await client.request("model.setRole", { sessionId: sid, role: "critic", value: "fake/model-b" }).catch((e: any) => e);
		expect(shadowed.code).toBe(-32020);
		expect(shadowed.message).toContain("ox-luna");
	});

	test("a role change while the open session is busy rides on an idle session, or fails fast when all are busy", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const configFile = path.join(bridge.home, "agent", "config.yml");
		const busy = (await client.request("session.new", {})).sessionId;
		const idle = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: busy, prompt: [{ type: "text", text: "slow" }] });
		await client.waitFor(e => e.ev === "session.status" && e.p.sessionId === busy && e.p.running);

		const set = await client.request("model.setRole", { sessionId: busy, role: "planner", value: "fake/model-b:low" });
		expect(set.roles.find((r: any) => r.id === "planner").value).toBe("fake/model-b:low");
		expect((Bun.YAML.parse(fs.readFileSync(configFile, "utf8")) as any).task.agentModelOverrides.planner).toBe("fake/model-b:low");

		await client.request("session.prompt", { sessionId: idle, prompt: [{ type: "text", text: "slow" }] });
		await client.waitFor(e => e.ev === "session.status" && e.p.sessionId === idle && e.p.running);
		const started = Date.now();
		const refused = await client.request("model.setRole", { sessionId: busy, role: "critic", value: "fake/model-a" }).catch((e: any) => e);
		expect(refused.code).toBe(-32020);
		expect(refused.message).toContain("턴이 끝난 뒤");
		expect(Date.now() - started).toBeLessThan(2000);
		for (const sessionId of [busy, idle]) await client.request("session.cancel", { sessionId });
	});

	test("gjc's unselectable plan mode is not offered, so the mode option with one choice disappears", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const created = await client.request("session.new", {});
		expect(created.configOptions.map((c: any) => c.id)).toEqual(["model", "thinking"]);
		const res = await client.request("session.setConfig", { sessionId: created.sessionId, configId: "model", value: "fake/model-a" });
		expect(res.configOptions.map((c: any) => c.id)).toEqual(["model", "thinking"]);
		expect(supportedConfigOptions([{ id: "mode", options: [{ value: "default" }, { value: "plan" }, { value: "auto" }] }])).toEqual([
			{ id: "mode", options: [{ value: "default" }, { value: "auto" }] },
		]);
	});

	test("session.new refuses a cwd missing on the host before gjc spawns a session host", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const missing = await client.request("session.new", { cwd: "/nonexistent/gjcm" }).catch((e: any) => e);
		expect(missing.code).toBe(-32602);
		expect(missing.message).toContain("/nonexistent/gjcm");
	});

	test("a stale SDK attachment asks the phone to reopen, and the reopened session works", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "하나" }] });
		await client.waitFor(turnEnd(sid));
		const stale = await client.request("sdk.query", { sessionId: sid, op: "usage.get" }).catch((e: any) => e);
		expect(stale.code).toBe(-32002);
		const notOpen = await client.request("sdk.query", { sessionId: sid, op: "context.get" }).catch((e: any) => e);
		expect(notOpen.code).toBe(-32002);
		await client.request("session.open", { sessionId: sid, afterSeq: 0 });
		const ctx = await client.request("sdk.query", { sessionId: sid, op: "context.get" });
		expect(ctx.items[0].usage.contextWindow).toBe(100000);
	});

	test("a rename shows in the session list (gjc writes it as a trailing header_patch)", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "하나" }] });
		await client.waitFor(turnEnd(sid));
		expect((await client.request("session.list", {})).sessions[0].title).toBe(`title ${sid}`);
		await client.request("sdk.control", { sessionId: sid, op: "session.rename", input: { name: "새 이름" } });
		expect((await client.request("session.list", {})).sessions[0]).toMatchObject({ sessionId: sid, title: "새 이름" });
	});

	test("session.list comes from saved transcripts newest first, plus this bridge's unprompted sessions", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const first = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: first, prompt: [{ type: "text", text: "하나" }] });
		await client.waitFor(turnEnd(first));
		const fresh = (await client.request("session.new", {})).sessionId;
		const listed = await client.request("session.list", {});
		expect(listed.sessions.map((s: any) => s.sessionId)).toEqual([fresh, first]);
		expect(listed.sessions[1].title).toBe(`title ${first}`);
		const found = await client.request("session.list", { query: first });
		expect(found.sessions.map((s: any) => s.sessionId)).toEqual([first]);
	});

	test("fork opens a copy with the source history; delete removes it from the list", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const source = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: source, prompt: [{ type: "text", text: "원본" }] });
		await client.waitFor(turnEnd(source));
		const fork = await client.request("session.fork", { sessionId: source });
		expect(fork.sessionId).not.toBe(source);
		expect(fork.reset).toBe(true);
		expect(fork.updates.map((u: any) => u.update.content?.text)).toEqual(["원본"]);
		const listed = await client.request("session.list", {});
		expect(listed.sessions.map((s: any) => s.sessionId)).toContain(fork.sessionId);
		await client.request("session.delete", { sessionId: fork.sessionId });
		const after = await client.request("session.list", {});
		expect(after.sessions.map((s: any) => s.sessionId)).not.toContain(fork.sessionId);
		expect(after.sessions.map((s: any) => s.sessionId)).toContain(source);
		const running = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: running, prompt: [{ type: "text", text: "tool" }] });
		await client.waitFor(e => e.ev === "permission.request");
		const refused = await client.request("session.delete", { sessionId: running }).catch((e: any) => e);
		expect(refused.code).toBe(-32003);
		await client.request("session.cancel", { sessionId: running });
	});

	test("a resume lost to a dead broker socket recycles the idle gjc process", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const before = (await client.request("host.info", {})).agentInfo.version;
		const lost = await client.request("session.open", { sessionId: "broker-lost", cwd: "/tmp" }).catch((e: any) => e);
		expect(lost.message).toContain("outcome is uncertain");
		const after = (await client.request("host.info", {})).agentInfo.version;
		expect(after).not.toBe(before);
		expect((await client.request("session.new", {})).sessionId).toBeString();
	});

	test("session.status reports working/idle and an output rate to every phone", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const { client: watcher } = await bridge.pairedClient("watcher");
		await watcher.request("ping"); // the hub attaches a phone on its first decrypted frame
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "hello" }] });
		const started = await watcher.waitFor(e => e.ev === "session.status" && e.p.sessionId === sid && e.p.running);
		expect(started.p.running).toBe(true);
		await watcher.waitFor(e => e.ev === "session.status" && e.p.sessionId === sid && !e.p.running);
		const row = (await client.request("session.list", {})).sessions.find((s: any) => s.sessionId === sid);
		expect(row.running).toBe(false);
		expect(row.tokensPerSecond).toBeGreaterThan(0);
	});

	test("session.interrupt stops the busy turn and runs the waiting steers as the next turn (TUI Esc with a queued steer)", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "slow count" }] });
		await client.waitFor(e => e.ev === "session.update" && e.p.update.sessionUpdate === "agent_message_chunk");
		const none = await client.request("session.interrupt", { sessionId: sid }).catch((e: any) => e);
		expect(none.code).toBe(-32005);
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "이거 먼저" } });
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "taken" } });
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "그리고 이것도" } });
		const res = await client.request("session.interrupt", { sessionId: sid });
		expect(res.text).toBe("이거 먼저\n\n그리고 이것도");
		const ended = (n: number) => () => client.events.filter(turnEnd(sid)).length >= n;
		await client.waitFor(ended(2));
		expect(client.events.filter(turnEnd(sid)).map(e => e.p.update.stopReason)).toEqual(["cancelled", "end_turn"]);
		const users = client.events
			.filter(e => e.ev === "session.update" && e.p.sessionId === sid && e.p.update.sessionUpdate === "user_message_chunk")
			.map(e => e.p.update.content.text);
		expect(users).toEqual(["slow count", "이거 먼저\n\n그리고 이것도"]);
		// The steers the cancel left queued were removed, so they cannot replay into a later turn.
		expect((await client.request("sdk.query", { sessionId: sid, op: "queue.messages.list" })).items).toEqual([]);
	});

	test("session.interrupt does not resend a steer gjc delivered itself before the cancel landed", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		const users = () =>
			client.events
				.filter(e => e.ev === "session.update" && e.p.sessionId === sid && e.p.update.sessionUpdate === "user_message_chunk")
				.map(e => e.p.update.content.text);

		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "slow count" }] });
		await client.waitFor(e => e.ev === "session.update" && e.p.update.sessionUpdate === "agent_message_chunk");
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "boundary KIWI" } });
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "이것도" } });
		const res = await client.request("session.interrupt", { sessionId: sid });
		expect(res.text).toBe("이것도");
		await client.waitFor(() => client.events.filter(turnEnd(sid)).length >= 2);
		expect(users()).toEqual(["slow count", "boundary KIWI", "이것도"]);

		// Every waiting steer was delivered by gjc itself: nothing is re-prompted.
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "slow again" }] });
		await client.waitFor(e => e.ev === "session.update" && e.p.sessionId === sid && e.p.update.content?.text === "slow again");
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "boundary only" } });
		const none = await client.request("session.interrupt", { sessionId: sid }).catch((e: any) => e);
		expect(none.code).toBe(-32005);
		await Bun.sleep(200);
		expect(client.events.filter(turnEnd(sid)).length).toBe(3);
		expect(users().filter(t => t === "boundary only")).toHaveLength(1);
	});

	test("session.interrupt refuses a turn typed in the TUI at once: gjc lets only the turn's owner stop it", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "terminal turn" } });
		await client.waitFor(e => e.ev === "session.status" && e.p.sessionId === sid && e.p.running);
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "대기 중" } });
		const started = Date.now();
		const refused = await client.request("session.interrupt", { sessionId: sid }).catch((e: any) => e);
		expect(refused.code).toBe(-32004);
		expect(refused.message).toContain("터미널에서 시작한 턴");
		expect(Date.now() - started).toBeLessThan(1000);
		// The steer stays queued for gjc to deliver at the turn's next step.
		expect((await client.request("sdk.query", { sessionId: sid, op: "queue.messages.list" })).items.map((m: any) => m.text)).toEqual(["대기 중"]);
	});

	test("session.status carries gjc's queue while the session works, whoever queued the message", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "slow count" }] });
		await client.waitFor(e => e.ev === "session.update" && e.p.update.sessionUpdate === "agent_message_chunk");
		// Another client stands for the TUI: this phone never sent the steer.
		const { client: other } = await bridge.pairedClient("tui");
		await other.request("session.open", { sessionId: sid });
		await other.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "TUI에서 넣음" } });
		const status = await client.waitFor(e => e.ev === "session.status" && e.p.sessionId === sid && e.p.queued?.length > 0, 3000);
		expect(status.p.queued).toEqual([{ id: expect.any(String), text: "TUI에서 넣음", mode: "steer" }]);
		expect(status.p.running).toBe(true);

		await client.request("session.cancel", { sessionId: sid });
		const idle = await client.waitFor(e => e.ev === "session.status" && e.p.sessionId === sid && !e.p.running, 3000);
		expect(idle.p.queued).toEqual([]);
		other.close();
	});

	test("SIGHUP after a gjc build switch restarts ACP only once the running turn is done", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const before = (await client.request("host.info", {})).agentInfo.version;
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "run a tool" }] });
		const perm = await client.waitFor(e => e.ev === "permission.request");
		bridge.hangup();
		await Bun.sleep(200);
		// Mid-turn with a permission prompt open: the old process must keep serving it.
		expect((await client.request("host.info", {})).agentInfo.version).toBe(before);
		await client.request("permission.respond", { requestId: perm.p.requestId, optionId: "allow_once" });
		expect((await client.waitFor(turnEnd(sid))).p.update.stopReason).toBe("end_turn");
		await Bun.sleep(200);
		const after = (await client.request("host.info", {})).agentInfo.version;
		expect(after).not.toBe(before);
		const reopened = await client.request("session.open", { sessionId: sid });
		expect(reopened.sessionId).toBe(sid);
		// Idle: a second switch takes effect immediately.
		bridge.hangup();
		await Bun.sleep(200);
		expect((await client.request("host.info", {})).agentInfo.version).not.toBe(after);
	});

	test("gjc SDK query/control pass through an allowlist with typed failures", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		const ctx = await client.request("sdk.query", { sessionId: sid, op: "context.get" });
		expect(ctx.items[0].usage.contextWindow).toBe(100000);
		expect(ctx.items[0].systemPrompt).toBeUndefined();
		expect(ctx.items[0].systemPromptChars).toBe(5);
		const goal = await client.request("sdk.control", { sessionId: sid, op: "mode.goal.operate", input: { op: "pause" } });
		expect(goal).toEqual({ result: null });
		const renamed = await client.request("sdk.control", { sessionId: sid, op: "session.rename", input: { name: "새 이름" } });
		expect(renamed.result).toEqual({ renamed: true });
		const compact = await client.request("sdk.control", { sessionId: sid, op: "compaction.run" }).catch((e: any) => e);
		expect(compact.code).toBe(-32020);
		expect(compact.message).toContain("Nothing to compact");
		const outdated = await client.request("sdk.control", { sessionId: sid, op: "turn.btw", input: { question: "q" } }).catch((e: any) => e);
		expect(outdated.code).toBe(-32020);
		expect(outdated.message).toContain("gjc --resume");
		const blocked = await client.request("sdk.control", { sessionId: sid, op: "bash.execute", input: { cmd: "id" } }).catch((e: any) => e);
		expect(blocked.code).toBe(-32601);
		const unopened = await client.request("sdk.query", { sessionId: "nope", op: "context.get" }).catch((e: any) => e);
		expect(unopened.code).toBe(-32002);
	});
});

describe("attachments", () => {
	test("image blocks pass through and files upload in verified chunks to a resource_link", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		const file = crypto.randomBytes(CHUNK_BYTES + 1234);
		const sha256 = crypto.createHash("sha256").update(file).digest("hex");
		const { uploadId, chunkBytes } = await client.request("upload.begin", { sessionId: sid, name: "../보고서 v2.pdf", size: file.length, mimeType: "application/pdf", sha256 });
		for (let offset = 0; offset < file.length; offset += chunkBytes) {
			await client.request("upload.chunk", { uploadId, offset, data: file.subarray(offset, offset + chunkBytes).toString("base64") });
		}
		const stored = await client.request("upload.commit", { uploadId });
		expect(stored.path.startsWith(bridge.state.uploadsDir)).toBe(true);
		expect(stored.path.endsWith("-보고서 v2.pdf")).toBe(true);
		expect(fs.readFileSync(stored.path).equals(file)).toBe(true);
		expect((fs.statSync(stored.path).mode & 0o777).toString(8)).toBe("600");

		const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
		await client.request("session.prompt", {
			sessionId: sid,
			prompt: [
				{ type: "text", text: "첨부 확인" },
				{ type: "image", mimeType: "image/png", data: png },
				{ type: "resource_link", uri: stored.uri, name: stored.name, mimeType: stored.mimeType, size: stored.size },
			],
		});
		await client.waitFor(turnEnd(sid));
		const chunks = client.events.filter(e => e.ev === "session.update" && e.p.update.sessionUpdate === "agent_message_chunk");
		expect(chunks.map(e => e.p.update.content.text).join("")).toBe("받은 블록: text,image,resource_link");
	});

	test("uploads reject a bad hash, a wrong offset, oversize files and foreign owners", async () => {
		const bridge = await useBridge();
		const { client } = await bridge.pairedClient("a");
		const { client: other } = await bridge.pairedClient("b");
		const sid = (await client.request("session.new", {})).sessionId;
		const data = Buffer.from("hello");
		await expect(client.request("upload.begin", { sessionId: sid, name: "big", size: 26 * 1024 * 1024, sha256: "0".repeat(64) })).rejects.toMatchObject({ code: -32010 });
		await expect(client.request("upload.begin", { sessionId: "../x", name: "a", size: 5, sha256: "0".repeat(64) })).rejects.toMatchObject({ code: -32602 });
		const { uploadId } = await client.request("upload.begin", { sessionId: sid, name: "a.txt", size: 5, sha256: "0".repeat(64) });
		await expect(other.request("upload.chunk", { uploadId, offset: 0, data: data.toString("base64") })).rejects.toMatchObject({ code: -32014 });
		await expect(client.request("upload.chunk", { uploadId, offset: 3, data: data.toString("base64") })).rejects.toMatchObject({ code: -32011 });
		await client.request("upload.chunk", { uploadId, offset: 0, data: data.toString("base64") });
		await expect(client.request("upload.commit", { uploadId })).rejects.toMatchObject({ code: -32013 });
		expect(fs.readdirSync(`${bridge.state.uploadsDir}/${sid}`)).toEqual([]);
	});
});
