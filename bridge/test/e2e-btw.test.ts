/**
 * Real-gjc check for the /btw side chat (`sdk.control` → `turn.btw`, gjc local patch 0004).
 * Opt-in like e2e-gjc: GJCM_E2E=1 [GJCM_E2E_GJC="gjc --mode=acp"] bun test test/e2e-btw.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BridgeClient } from "../src/client";
import { startTestBridge } from "./helpers";

const enabled = process.env.GJCM_E2E === "1";
const gjc = (process.env.GJCM_E2E_GJC ?? "gjc --mode=acp").split(/\s+/);
const TURN_END = "x_gjcm_turn_end";

describe.skipIf(!enabled)("bridge ↔ real gjc /btw", () => {
	let bridge: Awaited<ReturnType<typeof startTestBridge>>;
	let client: BridgeClient;
	let sid = "";
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjcm-btw-"));
	type Event = { ev: string; p: any };
	const update = (kind: string) => (e: Event) =>
		e.ev === "session.update" && e.p.sessionId === sid && e.p.update.sessionUpdate === kind;
	/** waitFor also matches already-buffered events; only accept ones after `from`. */
	const after = (from: number, match: (e: Event) => boolean) => (e: Event) => client.events.indexOf(e) >= from && match(e);
	const btw = async (question: string, exchanges?: { question: string; answer: string }[]) =>
		(await client.request("sdk.control", { sessionId: sid, op: "turn.btw", input: { question, exchanges } })).result.replyText as string;

	beforeAll(async () => {
		bridge = await startTestBridge(gjc, cwd);
		client = (await bridge.pairedClient("e2e-btw")).client;
		sid = (await client.request("session.new", { cwd })).sessionId;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "내 비밀단어는 KIWI다. '알겠다'라고만 답해." }] });
		await client.waitFor(update(TURN_END), 240_000);
	}, 300_000);
	afterAll(async () => {
		if (sid) await client?.request("session.delete", { sessionId: sid }).catch(() => {});
		client?.close();
		await bridge?.stop();
	});

	test("answers from the visible context, follows up via exchanges, never touches the transcript", async () => {
		const first = await btw("내 비밀단어가 뭐였지? 단어만.");
		expect(first).toContain("KIWI");
		const second = await btw("방금 네 대답을 거꾸로 써. 단어만.", [{ question: "내 비밀단어가 뭐였지? 단어만.", answer: first }]);
		expect(second).toContain("IWIK");
		const context = JSON.stringify(await client.request("sdk.query", { sessionId: sid, op: "context.get", input: {} }));
		expect(context).not.toContain("거꾸로");
	}, 240_000);

	test("answers only the side question while the main turn is still running", async () => {
		const seen = client.events.length;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "1부터 200까지 쉼표로 써라. 도구 금지." }] });
		await client.waitFor(after(seen, update("agent_message_chunk")), 240_000);
		const reply = await btw("2+3은? 숫자만.");
		// Measured before the pending-request placeholder: the side reply re-ran the whole count.
		expect(reply.trim()).toBe("5");
		await client.waitFor(after(seen, update(TURN_END)), 240_000);
	}, 300_000);

	test("rejects an empty question", async () => {
		await expect(btw("   ")).rejects.toThrow("non-empty question");
	});
});
