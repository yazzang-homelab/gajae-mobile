import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BridgeClient } from "../src/client";
import { generateKeyPair } from "../src/crypto";
import { buildOffer, parseOfferUrl } from "../src/offer";
import { DEMO_AGENT, startTestBridge } from "./helpers";

const TURN_END = "x_gjcm_turn_end";
let bridges: Awaited<ReturnType<typeof startTestBridge>>[] = [];
afterEach(async () => {
	for (const b of bridges) await b.stop();
	bridges = [];
});
async function demoBridge() {
	const b = await startTestBridge(DEMO_AGENT);
	bridges.push(b);
	return b;
}
const updates = (client: BridgeClient, sid: string, kind: string) =>
	client.events.filter(e => e.ev === "session.update" && e.p.sessionId === sid && e.p.update.sessionUpdate === kind);

describe("review demo host", () => {
	test("one reusable pairing code enrolls several reviewer devices until it expires", async () => {
		const b = await demoBridge();
		const offer = buildOffer(b.state.host(), b.state.createPairing(60_000, true), [b.endpoint]);
		for (const name of ["App Review iPhone", "Play review Pixel"]) {
			const identity = BridgeClient.identityFromOffer(offer, generateKeyPair());
			const client = await BridgeClient.connect(b.endpoint, identity, { pairing: { id: offer.pairingId, secret: offer.secret }, name });
			expect((await client.request("host.info")).agentInfo.name).toBe("gjc-demo");
			client.close();
		}
		expect(b.state.devices().map(d => d.name)).toEqual(["App Review iPhone", "Play review Pixel"]);
		// A normal code is still single use.
		const once = buildOffer(b.state.host(), b.state.createPairing(), [b.endpoint]);
		const first = await BridgeClient.connect(b.endpoint, BridgeClient.identityFromOffer(once, generateKeyPair()), { pairing: { id: once.pairingId, secret: once.secret } });
		first.close();
		await expect(
			BridgeClient.connect(b.endpoint, BridgeClient.identityFromOffer(once, generateKeyPair()), { pairing: { id: once.pairingId, secret: once.secret } }),
		).rejects.toMatchObject({ code: "pairing_invalid" });
	});

	test("GET /offer hands out the same reusable link for the public endpoint until it nears expiry", async () => {
		const b = await demoBridge();
		const http = b.endpoint.replace("ws://", "http://").replace(/\/ws$/, "/offer");
		const first = (await (await fetch(http)).json()).url;
		const second = (await (await fetch(http)).json()).url;
		expect(first).toBe(second);
		const privacy = await fetch(http.replace(/\/offer$/, "/privacy"));
		expect(privacy.headers.get("content-type")).toContain("text/html");
		expect(await privacy.text()).toContain("개인정보처리방침");
		const offer = parseOfferUrl(first);
		expect(offer.endpoints).toEqual(["wss://demo.example/ws"]);
		// The link pairs a device over the real endpoint and keeps working for the next one.
		for (const name of ["a", "b"]) {
			const c = await BridgeClient.connect(b.endpoint, BridgeClient.identityFromOffer(offer, generateKeyPair()), { pairing: { id: offer.pairingId, secret: offer.secret }, name });
			c.close();
		}
		expect(b.state.devices()).toHaveLength(2);
	});

	test("a reviewer can chat, approve a command, change effort and steer — all scripted, nothing executed", async () => {
		const b = await demoBridge();
		const { client } = await b.pairedClient();
		const created = await client.request("session.new", {});
		const sid = created.sessionId;
		expect(created.configOptions.map((c: any) => c.id)).toEqual(["model", "thinking"]);

		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "파일 목록 보여줘" }] });
		const permission = await client.waitFor(e => e.ev === "permission.request");
		await client.request("permission.respond", { requestId: permission.p.requestId, optionId: "allow_once" });
		await client.waitFor(() => updates(client, sid, TURN_END).length >= 1);
		expect(updates(client, sid, TURN_END)[0].p.update.stopReason).toBe("end_turn");
		expect(updates(client, sid, "agent_thought_chunk").length).toBeGreaterThan(0);
		expect(updates(client, sid, "tool_call_update").at(-1)?.p.update.status).toBe("completed");

		const effort = await client.request("session.setConfig", { sessionId: sid, configId: "thinking", value: "off" });
		expect(effort.configOptions.find((c: any) => c.id === "thinking").currentValue).toBe("off");

		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "안녕" }] });
		await client.waitFor(() => updates(client, sid, "agent_message_chunk").length > 0 && updates(client, sid, TURN_END).length === 1);
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "짧게" } });
		await client.waitFor(() => updates(client, sid, TURN_END).length >= 2);
		const text = updates(client, sid, "agent_message_chunk").map(e => e.p.update.content.text).join("");
		expect(text).toContain("끼어든 지시를 반영합니다: “짧게”");

		const list = await client.request("session.list", {});
		expect(list.sessions.map((s: any) => s.sessionId)).toContain(sid);
	});

	test("the menu's permission-mode switch: with allow the demo command runs without asking", async () => {
		const b = await demoBridge();
		const { client } = await b.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("session.setConfig", { sessionId: sid, configId: "thinking", value: "off" });
		await client.request("session.setPermissionMode", { sessionId: sid, mode: "allow" });
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "파일 목록 보여줘" }] });
		await client.waitFor(() => updates(client, sid, TURN_END).length >= 1);
		expect(client.events.some(e => e.ev === "permission.request")).toBe(false);
		expect(updates(client, sid, "tool_call_update").at(-1)?.p.update.status).toBe("completed");
	}, 15_000);

	test("끼어들기 against the demo host stops the turn and runs the waiting steer", async () => {
		const b = await demoBridge();
		const { client } = await b.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		// Slow chunks keep the turn busy; the steer is taken at a chunk boundary unless 끼어들기 wins first.
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "긴 답변" }] });
		await client.waitFor(() => updates(client, sid, "agent_thought_chunk").length > 0);
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "이거 먼저" } });
		const res = await client.request("session.interrupt", { sessionId: sid }).catch((e: any) => e);
		await client.waitFor(() => updates(client, sid, TURN_END).length >= (res.code === -32005 ? 1 : 2));
		if (res.code !== -32005) {
			expect(res.text).toBe("이거 먼저");
			expect(updates(client, sid, TURN_END).map(e => e.p.update.stopReason)).toEqual(["cancelled", "end_turn"]);
		}
	});

	test("every info sheet and menu action the apps offer answers on the demo host instead of an error", async () => {
		const b = await demoBridge();
		const { client } = await b.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		const query = async (op: string) => (await client.request("sdk.query", { sessionId: sid, op })).items;
		const control = async (op: string, input: Record<string, unknown> = {}) =>
			(await client.request("sdk.control", { sessionId: sid, op, input })).result;

		// Fresh session: sheets open empty, not with an error.
		expect(await query("todo.list")).toEqual([]);
		expect((await query("goal.list/get"))[0]).toMatchObject({ enabled: false });
		expect((await query("runtime.jobs.list"))[0]).toEqual({ running: [], recent: [], delivery: { queued: 0 } });

		await client.request("session.setPermissionMode", { sessionId: sid, mode: "allow" });
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "파일 목록 보여줘" }] });
		await client.waitFor(() => updates(client, sid, TURN_END).length >= 1);

		const usage = (await query("usage.get"))[0];
		expect(usage.input).toBeGreaterThan(0);
		expect(usage.output).toBeGreaterThan(0);
		expect((await query("session.stats"))[0]).toEqual(usage);
		expect((await query("session.metadata"))[0]).toMatchObject({ sessionId: sid, kind: "demo" });
		const todos = await query("todo.list");
		expect(todos[0].tasks.map((t: any) => t.status)).toEqual(["completed", "completed", "completed"]);
		expect((await query("runtime.jobs.list"))[0].recent).toEqual([
			{ id: expect.any(String), label: "ls -la ~/demo-project", status: "completed" },
		]);

		await control("mode.goal.operate", { op: "create", objective: "테스트 통과시키기" });
		expect((await query("goal.list/get"))[0]).toMatchObject({ enabled: true, goal: { objective: "테스트 통과시키기", status: "active" } });
		await control("mode.goal.operate", { op: "pause" });
		expect((await query("goal.list/get"))[0].goal.status).toBe("paused");
		await control("mode.goal.operate", { op: "drop" });
		expect((await query("goal.list/get"))[0].enabled).toBe(false);

		const before = (await query("context.get"))[0].usage.tokens;
		expect((await control("compaction.run")).tokensBefore).toBe(before);
		expect((await control("session.export_html")).path).toEndWith(`${sid}.html`);
		await control("context.clear");
		expect((await query("context.get"))[0].usage.tokens).toBeLessThan(before);
		await control("service_tier.set", { tier: "priority" });

		// Every other query the bridge exposes answers (possibly empty) rather than failing.
		for (const op of ["session.last_assistant", "skill.list/state", "models.list/current", "workflow.gates.list", "extensions.list", "providers.list/active"])
			expect(Array.isArray(await query(op))).toBe(true);
	});

	test("a session id that walks out of the demo directory never reaches the filesystem", async () => {
		const b = await demoBridge();
		const { client } = await b.pairedClient();
		const agentDir = path.join(b.home, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		const outside = path.join(agentDir, "victim.jsonl");
		fs.writeFileSync(outside, `${JSON.stringify({ type: "session", id: "x", cwd: "/", title: "t" })}\n`);
		await expect(client.request("session.open", { sessionId: "../../victim" })).rejects.toThrow();
		await client.request("session.delete", { sessionId: "../../victim" }).catch(() => {});
		expect(fs.existsSync(outside)).toBe(true);
	});

	test("a follow-up sent during a turn is answered when that turn's reply ends", async () => {
		const b = await demoBridge();
		const { client } = await b.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "긴 답변" }] });
		await client.waitFor(() => updates(client, sid, "agent_thought_chunk").length > 0);
		await client.request("sdk.control", { sessionId: sid, op: "turn.follow_up", input: { text: "그다음엔 이것" } });
		const queued = (await client.request("sdk.query", { sessionId: sid, op: "queue.messages.list" })).items;
		expect(queued).toEqual([{ id: expect.any(String), text: "그다음엔 이것", mode: "followUp", label: "Follow-up" }]);
		await client.waitFor(() => updates(client, sid, TURN_END).length >= 1);
		const text = updates(client, sid, "agent_message_chunk").map(e => e.p.update.content.text).join("");
		expect(text).toContain("이어서 받은 메시지: “그다음엔 이것”");
		expect((await client.request("sdk.query", { sessionId: sid, op: "queue.messages.list" })).items).toEqual([]);
	});

	test("a follow-up sent while one is being answered is answered too, and stop ends that tail", async () => {
		const b = await demoBridge();
		const { client } = await b.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		const said = () => updates(client, sid, "agent_message_chunk").map(e => e.p.update.content.text).join("");
		const followUp = (text: string) => client.request("sdk.control", { sessionId: sid, op: "turn.follow_up", input: { text } });

		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "첫 번째" }] });
		await client.waitFor(() => updates(client, sid, "agent_thought_chunk").length > 0);
		await followUp("하나");
		await client.waitFor(() => said().includes("이어서 받은 메시지: “하나”"));
		await followUp("둘");
		await client.waitFor(() => updates(client, sid, TURN_END).length >= 1);
		expect(updates(client, sid, TURN_END)[0].p.update.stopReason).toBe("end_turn");
		expect(said()).toContain("이어서 받은 메시지: “둘”");
		expect((await client.request("sdk.query", { sessionId: sid, op: "queue.messages.list" })).items).toEqual([]);

		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "두 번째" }] });
		await client.waitFor(() => updates(client, sid, "agent_thought_chunk").length > 0 && updates(client, sid, TURN_END).length === 1);
		await followUp("셋");
		await client.waitFor(() => said().includes("이어서 받은 메시지: “셋”"));
		await client.request("session.cancel", { sessionId: sid });
		await client.waitFor(() => updates(client, sid, TURN_END).length >= 2);
		expect(updates(client, sid, TURN_END)[1].p.update.stopReason).toBe("cancelled");
		expect(said().split("이 메시지로 다음 턴을 시작합니다.").length - 1).toBe(2);
	});

	test("/btw side chat answers on the demo host without touching the session", async () => {
		const b = await demoBridge();
		const { client } = await b.pairedClient();
		const sid = (await client.request("session.new", {})).sessionId;
		const first = await client.request("sdk.control", { sessionId: sid, op: "turn.btw", input: { question: "이건 뭐야?" } });
		expect(first.result.replyText).toContain("1번째 질문");
		const next = await client.request("sdk.control", {
			sessionId: sid,
			op: "turn.btw",
			input: { question: "더 자세히", exchanges: [{ question: "이건 뭐야?", answer: first.result.replyText }] },
		});
		expect(next.result.replyText).toContain("2번째 질문");
		await expect(client.request("sdk.control", { sessionId: sid, op: "turn.btw", input: { question: " " } })).rejects.toThrow("non-empty");
		expect(updates(client, sid, "agent_message_chunk")).toHaveLength(0);
	});
});
