/**
 * End-to-end against the real `gjc --mode=acp` (opt-in: GJCM_E2E=1, uses the host's gjc login
 * and spends model tokens). Proves prompt → permission → tool → stream → turn end, an inline
 * image block, and an uploaded file referenced as a resource_link that gjc reads itself.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { BridgeClient } from "../src/client";
import { TURN_END } from "../src/hub";
import { startTestBridge } from "./helpers";

const enabled = process.env.GJCM_E2E === "1";
const gjc = (process.env.GJCM_E2E_GJC ?? "gjc --mode=acp").split(/\s+/);

function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf: Buffer) => {
		let c = 0xffffffff;
		for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, sum]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from("89504e470d0a1a0a", "hex"),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const turnEnd = (sid: string) => (e: { ev: string; p: any }) =>
	e.ev === "session.update" && e.p.sessionId === sid && e.p.update.sessionUpdate === TURN_END;

function agentText(client: BridgeClient, sid: string, fromIndex: number): string {
	return client.events
		.slice(fromIndex)
		.filter(e => e.ev === "session.update" && e.p.sessionId === sid && e.p.update.sessionUpdate === "agent_message_chunk")
		.map(e => e.p.update.content?.text ?? "")
		.join("");
}

describe.skipIf(!enabled)("bridge ↔ real gjc ACP", () => {
	let bridge: Awaited<ReturnType<typeof startTestBridge>>;
	let client: BridgeClient;
	let sid: string;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjcm-e2e-cwd-"));

	beforeAll(async () => {
		bridge = await startTestBridge(gjc, cwd);
		client = (await bridge.pairedClient("e2e")).client;
	});
	afterAll(async () => {
		// The real gjc saves into the host's own session store; do not leave test sessions in the user's /resume list.
		if (sid) await client?.request("session.delete", { sessionId: sid }).catch(() => {});
		client?.close();
		await bridge?.stop();
	});

	test("host info reports the real gjc agent", async () => {
		const info = await client.request("host.info");
		expect(info.agentInfo.name).toBe("gajae-code");
	}, 120_000);

	test("prompt → permission → bash tool → streamed answer → turn end", async () => {
		const opened = await client.request("session.new", { cwd });
		sid = opened.sessionId;
		expect(opened.configOptions.some((c: any) => c.id === "model")).toBe(true);
		const start = client.events.length;
		await client.request("session.prompt", {
			sessionId: sid,
			prompt: [{ type: "text", text: "bash 도구로 `echo gjcm-e2e-ok` 를 정확히 한 번 실행하고, 출력 문자열만 답해." }],
		});
		const perm = await client.waitFor(e => e.ev === "permission.request" && e.p.sessionId === sid, 240_000);
		expect(JSON.stringify(perm.p.toolCall)).toContain("gjcm-e2e-ok");
		await client.request("permission.respond", { requestId: perm.p.requestId, optionId: "allow_once" });
		const end = await client.waitFor(turnEnd(sid), 240_000);
		expect(end.p.update.stopReason).toBe("end_turn");
		const tool = client.events
			.slice(start)
			.find(e => e.ev === "session.update" && e.p.update.sessionUpdate === "tool_call_update" && e.p.update.status === "completed");
		expect(JSON.stringify(tool?.p.update)).toContain("gjcm-e2e-ok");
		expect(agentText(client, sid, start)).toContain("gjcm-e2e-ok");
	}, 300_000);

	test("permission mode allow: the same bash call runs without a permission prompt", async () => {
		const own = (await client.request("session.new", { cwd })).sessionId;
		try {
			expect(await client.request("session.setPermissionMode", { sessionId: own, mode: "allow" })).toEqual({ mode: "allow" });
			const start = client.events.length;
			await client.request("session.prompt", {
				sessionId: own,
				prompt: [{ type: "text", text: "bash 도구로 `echo gjcm-allow-ok` 를 정확히 한 번 실행하고, 출력 문자열만 답해." }],
			});
			const end = await client.waitFor(turnEnd(own), 240_000);
			expect(end.p.update.stopReason).toBe("end_turn");
			const after = client.events.slice(start);
			expect(after.some(e => e.ev === "permission.request" && e.p.sessionId === own)).toBe(false);
			const tool = after.find(
				e => e.ev === "session.update" && e.p.update.sessionUpdate === "tool_call_update" && e.p.update.status === "completed",
			);
			expect(JSON.stringify(tool?.p.update)).toContain("gjcm-allow-ok");
		} finally {
			await client.request("session.delete", { sessionId: own }).catch(() => {});
		}
	}, 300_000);

	test("an inline image block reaches the model", async () => {
		const start = client.events.length;
		await client.request("session.prompt", {
			sessionId: sid,
			prompt: [
				{ type: "text", text: "첨부한 이미지는 단색이다. 그 색의 영어 이름 한 단어만 소문자로 답해. 도구는 쓰지 마." },
				{ type: "image", mimeType: "image/png", data: solidPng(64, 64, [220, 20, 20]).toString("base64") },
			],
		});
		await client.waitFor(e => turnEnd(sid)(e) && client.events.indexOf(e) >= start, 240_000);
		expect(agentText(client, sid, start).toLowerCase()).toContain("red");
	}, 300_000);

	test("an uploaded file is read by gjc through the resource_link", async () => {
		const secret = `gjcm-file-${crypto.randomBytes(4).toString("hex")}`;
		const file = Buffer.from(`이 파일의 암호는 ${secret} 이다.\n`);
		const { uploadId } = await client.request("upload.begin", {
			sessionId: sid,
			name: "메모.txt",
			size: file.length,
			mimeType: "text/plain",
			sha256: crypto.createHash("sha256").update(file).digest("hex"),
		});
		await client.request("upload.chunk", { uploadId, offset: 0, data: file.toString("base64") });
		const stored = await client.request("upload.commit", { uploadId });
		const start = client.events.length;
		await client.request("session.prompt", {
			sessionId: sid,
			prompt: [
				{ type: "text", text: "첨부 파일을 읽고 그 안의 암호 문자열만 답해." },
				{ type: "resource_link", uri: stored.uri, name: stored.name, mimeType: stored.mimeType, size: stored.size },
			],
		});
		// gjc may ask before reading a file outside the session cwd; approve every request.
		const approve = async () => {
			while (true) {
				const perm = await client.waitFor(
					e => (e.ev === "permission.request" && e.p.sessionId === sid && client.events.indexOf(e) >= start && !e.p.__handled) || (turnEnd(sid)(e) && client.events.indexOf(e) >= start),
					240_000,
				);
				if (perm.ev !== "permission.request") return;
				perm.p.__handled = true;
				await client.request("permission.respond", { requestId: perm.p.requestId, optionId: "allow_once" });
			}
		};
		await approve();
		expect(agentText(client, sid, start)).toContain(secret);
	}, 300_000);

	test("saved-session list, SDK context/usage/rename, fork with history, delete", async () => {
		const listed = await client.request("session.list", { cwd });
		expect(listed.sessions[0].sessionId).toBe(sid);
		const ctx = await client.request("sdk.query", { sessionId: sid, op: "context.get" });
		expect(ctx.items[0].usage.contextWindow).toBeGreaterThan(0);
		const usage = await client.request("sdk.query", { sessionId: sid, op: "usage.get" });
		expect(usage.items.length).toBeGreaterThan(0);
		const renamed = await client.request("sdk.control", { sessionId: sid, op: "session.rename", input: { name: "e2e 이름" } });
		expect(renamed.result).toEqual({ renamed: true });
		// gjc persists the rename as a trailing header_patch; the list (and a phone restart) must show it.
		const relisted = await client.request("session.list", { cwd });
		expect(relisted.sessions.find((s: any) => s.sessionId === sid)?.title).toBe("e2e 이름");
		const fork = await client.request("session.fork", { sessionId: sid });
		expect(fork.sessionId).not.toBe(sid);
		expect(fork.updates.some((u: any) => u.update.sessionUpdate === "user_message_chunk")).toBe(true);
		await client.request("session.delete", { sessionId: fork.sessionId });
		const after = await client.request("session.list", { cwd });
		expect(after.sessions.map((s: any) => s.sessionId)).not.toContain(fork.sessionId);
	}, 300_000);
});
