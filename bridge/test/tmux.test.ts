import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeClient } from "../src/client";
import { AGENT_EXIT, TURN_END } from "../src/hub";
import { TmuxLauncher, tuiCommand } from "../src/tmux";
import { FAKE_AGENT, startTestBridge } from "./helpers";

const hasTmux = Bun.which("tmux") !== null;
const hasProcfs = fs.existsSync("/proc/self/stat");
const turnEnd = (sid: string) => (e: { ev: string; p: any }) => e.ev === "session.update" && e.p.sessionId === sid && e.p.update.sessionUpdate === TURN_END;
const askCall = (client: { events: { ev: string; p: any }[] }, sid: string) =>
	client.events.find(e => e.ev === "session.update" && e.p.sessionId === sid && e.p.update.toolCallId === "ask1" && e.p.update.sessionUpdate === "tool_call")!.p.update;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(check: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
		await Bun.sleep(50);
	}
}

function tmux(socket: string, ...args: string[]) {
	const proc = Bun.spawnSync(["tmux", "-L", socket, ...args]);
	return { code: proc.exitCode, stdout: proc.stdout.toString().trim() };
}

/** A bridge whose new sessions go to tmux session `gjcm` on a private tmux socket. */
async function tmuxBridge(options: { server: boolean; tui?: string; readyTimeoutMs?: number; attachTimeoutMs?: number; env?: Record<string, string> }) {
	const socket = `gjcm-test-${crypto.randomBytes(4).toString("hex")}`;
	cleanups.push(() => void tmux(socket, "kill-server"));
	// The user's own tmux server, which the bridge only joins.
	if (options.server) expect(tmux(socket, "new-session", "-d", "-s", "keep", "sleep 600").code).toBe(0);
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjcm-tmux-cwd-")));
	cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const command = [...FAKE_AGENT, "--mode=acp", `--tui=${options.tui ?? "run"}`];
	const tmuxOptions = {
		session: "gjcm",
		socket,
		...(options.readyTimeoutMs ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
		...(options.attachTimeoutMs ? { attachTimeoutMs: options.attachTimeoutMs } : {}),
	};
	const bridge = await startTestBridge(command, cwd, { GJCM_TEST_TMUX: JSON.stringify(tmuxOptions), ...options.env });
	cleanups.push(() => bridge.stop());
	const { client, identity } = await bridge.pairedClient();
	const windows = () => {
		const listed = tmux(socket, "list-panes", "-s", "-t", "=gjcm", "-F", "#{pane_start_command}");
		return listed.code === 0 ? listed.stdout.split("\n").filter(Boolean) : [];
	};
	/** The session each window was opened for (the window option the bridge sets). */
	const tags = () => {
		const listed = tmux(socket, "list-windows", "-t", "=gjcm", "-F", "#{@gjcm_session}");
		return listed.code === 0 ? listed.stdout.split("\n").filter(Boolean) : [];
	};
	/** The same phone connecting again (a new connection of the paired device). */
	const reconnect = async () => {
		const again = await BridgeClient.connect(bridge.endpoint, identity);
		cleanups.push(() => again.close());
		return again;
	};
	/** The bridge's gjc ACP processes (none until a request needs one, or the bridge restarts one on its own). */
	const acpProcesses = () =>
		fs.readdirSync("/proc").filter(pid => {
			try {
				const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
				const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
				return parent === bridge.pid && fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("--mode=acp");
			} catch {
				return false;
			}
		});
	/**
	 * Kills the bridge's gjc ACP and tells whether the bridge started another by itself (it waits 1s first after a
	 * death). One it started is given a second to come up: killed while starting, it is not restarted.
	 */
	const killAcp = async () => {
		const [acp] = acpProcesses();
		if (!acp) throw new Error("no gjc ACP process to kill");
		process.kill(Number(acp), "SIGKILL");
		const deadline = Date.now() + 2500;
		while (Date.now() < deadline) {
			await Bun.sleep(50);
			if (acpProcesses().some(pid => pid !== acp)) {
				await Bun.sleep(1000);
				return true;
			}
		}
		return false;
	};
	return { socket, cwd, client, windows, tags, reconnect, killAcp, home: bridge.home };
}

describe("tuiCommand", () => {
	test("refuses a session name tmux would rewrite", () => {
		expect(() => new TmuxLauncher({ session: "gjc.m" }, ["gjc"])).toThrow();
		expect(() => new TmuxLauncher({ session: "a:b" }, ["gjc"])).toThrow();
		expect(() => new TmuxLauncher({ session: "gjcm_2-x" }, ["gjc"])).not.toThrow();
	});

	test("drops the ACP mode flag in either spelling and keeps the rest", () => {
		expect(tuiCommand(["gjc", "--mode=acp"])).toEqual(["gjc"]);
		expect(tuiCommand(["/root/.local/bin/gjc", "--mode", "acp", "--model", "x"])).toEqual(["/root/.local/bin/gjc", "--model", "x"]);
		expect(tuiCommand(["gjc", "--mode", "rpc"])).toEqual(["gjc", "--mode", "rpc"]);
	});
});

describe.skipIf(!hasTmux)("new sessions as tmux windows (gm#58)", () => {
	test("opens each new session as a window whose gjc starts it, and drives it from the phone", async () => {
		const { cwd, client, windows, tags, home } = await tmuxBridge({ server: true });
		const first = await client.request("session.new", {});
		expect(first.cwd).toBe(cwd);
		// The session is the one gjc in the window started (the fake TUI's id), not one ACP created for it to resume:
		// one gjc start per new session. That gjc uses the bridge's agent dir.
		expect(first.sessionId).toMatch(/^tui-\d+$/);
		const endpoint = JSON.parse(fs.readFileSync(path.join(cwd, ".gjc", "state", "sdk", `${first.sessionId}.json`), "utf8"));
		expect(endpoint.agentDir).toBe(path.join(home, "agent"));
		expect(windows()).toHaveLength(1);
		expect(windows()[0]).not.toContain("--resume");
		expect(windows()[0]).not.toContain("--mode=acp");
		expect(tags()).toEqual([first.sessionId]);

		const sid = first.sessionId;
		expect(await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "hello" }] })).toEqual({ accepted: true, turnId: expect.any(String) });
		const end = await client.waitFor(turnEnd(sid));
		expect(end.p.update.stopReason).toBe("end_turn");

		// The second one joins the same tmux session instead of creating another.
		const second = await client.request("session.new", {});
		expect(second.sessionId).not.toBe(first.sessionId);
		expect(windows()).toHaveLength(2);
		expect(tags()).toEqual([first.sessionId, second.sessionId]);
	});

	test("takes the session gjc in the new window started, not an endpoint another process left in the directory", async () => {
		const { socket, cwd, client, tags } = await tmuxBridge({ server: false });
		// Opened over ACP while no tmux server ran: its session host leaves an endpoint in the same directory.
		const overAcp = (await client.request("session.new", {})).sessionId;
		expect(fs.existsSync(path.join(cwd, ".gjc", "state", "sdk", `${overAcp}.json`))).toBe(true);
		expect(tmux(socket, "new-session", "-d", "-s", "keep", "sleep 600").code).toBe(0);
		const inWindow = (await client.request("session.new", {})).sessionId;
		expect(inWindow).toMatch(/^tui-\d+$/);
		expect(tags()).toEqual([inWindow]);
	});

	test("two phones starting sessions together get one gjcm session with two windows", async () => {
		const { socket, client, windows } = await tmuxBridge({ server: true });
		const [a, b] = await Promise.all([client.request("session.new", {}), client.request("session.new", {})]);
		expect(a.sessionId).not.toBe(b.sessionId);
		expect(tmux(socket, "list-sessions", "-F", "#{session_name}").stdout.split("\n").sort()).toEqual(["gjcm", "keep"]);
		expect(windows()).toHaveLength(2);
		// Each window is tagged with the session its own gjc started (the fake names it after its pid), not the other's.
		const panes = tmux(socket, "list-panes", "-s", "-t", "=gjcm", "-F", "#{pane_pid} #{@gjcm_session}").stdout.split("\n");
		expect(panes.map(line => line.split(" ")[1]).sort()).toEqual([a.sessionId, b.sessionId].sort());
		for (const line of panes) expect(line.split(" ")[1]).toBe(`tui-${line.split(" ")[0]}`);
	});

	test.skipIf(!hasProcfs)("removes the window and tells the phone why when gjc never registers its session with the broker", async () => {
		// gjc writes the endpoint first and registers after it; the load answers not_found until then.
		const { client, windows, killAcp } = await tmuxBridge({ server: true, tui: "unregistered", attachTimeoutMs: 1500 });
		const failed = await client.request("session.new", {}).catch((e: any) => e);
		expect(failed.code).toBe(-32021);
		expect(failed.data).toEqual({ code: "tmux_attach_failed" });
		expect(failed.message).toContain("Saved ACP session does not exist");
		expect(windows()).toEqual([]);
		expect((await client.request("session.list", {})).sessions).toEqual([]);
		// The bridge keeps nothing of it: gjc ACP ending is no reason to start it again to attach that session.
		expect(await killAcp()).toBe(false);
	});

	test.skipIf(!hasProcfs)("stops restarting gjc ACP for a window closed before its first answer once it cannot attach again", async () => {
		const { socket, cwd, client, killAcp } = await tmuxBridge({ server: true });
		const sid = (await client.request("session.new", {})).sessionId;
		expect(sid).toMatch(/^tui-\d+$/);
		// The user closes the window unused: its gjc leaves and nothing was saved.
		expect(tmux(socket, "kill-session", "-t", "=gjcm").code).toBe(0);
		const registration = path.join(cwd, ".gjc", "state", "sdk", `${sid}.tui`);
		for (let i = 0; i < 100 && fs.existsSync(registration); i++) await Bun.sleep(20);
		expect(fs.existsSync(registration)).toBe(false);
		// The bridge cannot tell the window is gone: a death of gjc ACP still starts it again to attach the session. That
		// fails with no window left, and from then on gjc ACP stays down until a phone needs it.
		let restarts = 0;
		while (restarts < 5 && (await killAcp())) restarts++;
		expect(restarts).toBeGreaterThanOrEqual(1);
		expect(restarts).toBeLessThan(5);
	}, 30_000);

	test("does not start a tmux server when the user's goes away between the check and the window", async () => {
		// open() is what runs after unavailable() passed; with no server by then it must fail, not start one.
		const socket = `gjcm-test-${crypto.randomBytes(4).toString("hex")}`;
		cleanups.push(() => void tmux(socket, "kill-server"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjcm-tmux-cwd-"));
		cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const launcher = new TmuxLauncher({ session: "gjcm", socket }, ["sleep", "60"]);
		const failed = await launcher.open(cwd).catch((e: any) => e);
		expect(failed.code).toBe("tmux_failed");
		expect(tmux(socket, "list-sessions").code).not.toBe(0);
	});

	test("reports a TUI command that cannot start as the window's gjc exiting", async () => {
		const socket = `gjcm-test-${crypto.randomBytes(4).toString("hex")}`;
		cleanups.push(() => void tmux(socket, "kill-server"));
		expect(tmux(socket, "new-session", "-d", "-s", "keep", "sleep 600").code).toBe(0);
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjcm-tmux-cwd-"));
		cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const launcher = new TmuxLauncher({ session: "gjcm", socket }, [path.join(cwd, "no-such-gjc")]);
		for (let attempt = 0; attempt < 3; attempt++) expect((await launcher.open(cwd).catch((e: any) => e)).code).toBe("tmux_window_exited");
	});

	test("opens over ACP when no tmux server runs, without starting one", async () => {
		const { socket, client, windows } = await tmuxBridge({ server: false });
		const sid = (await client.request("session.new", {})).sessionId;
		expect(await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "ask me" }] })).toEqual({ accepted: true, turnId: expect.any(String) });
		await client.waitFor(turnEnd(sid));
		expect(windows()).toEqual([]);
		expect(tmux(socket, "list-sessions").code).not.toBe(0);
		// gjc answers this session's asks over ACP itself; the bridge leaves them alone.
		expect(askCall(client, sid).content).toBeUndefined();
	});

	test("tells the phone to answer an ask of its own turn in the terminal", async () => {
		const { client } = await tmuxBridge({ server: true });
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "ask me" }] });
		await client.waitFor(turnEnd(sid));
		const text = askCall(client, sid).content[0].content.text;
		expect(text).toContain("사과와 배 중 하나를 고르세요\n  • 사과\n  • 배");
		expect(text).toContain("터미널(gjc TUI)에서 답을 기다리는 질문입니다");
	});

	test("removes the window and tells the phone why when gjc ends at once", async () => {
		const { client, windows } = await tmuxBridge({ server: true, tui: "exit" });
		const failed = await client.request("session.new", {}).catch((e: any) => e);
		expect(failed.code).toBe(-32021);
		expect(failed.data).toEqual({ code: "tmux_window_exited" });
		expect(failed.message).toContain("gjc가 바로 끝났습니다");
		expect(windows()).toEqual([]);
	});

	test("removes the window when gjc never publishes its endpoint in time", async () => {
		const { client, windows } = await tmuxBridge({ server: true, tui: "silent", readyTimeoutMs: 2000 });
		const failed = await client.request("session.new", {}).catch((e: any) => e);
		expect(failed.code).toBe(-32021);
		expect(failed.data).toEqual({ code: "tmux_ready_timeout" });
		expect(failed.message).toContain("2초 안에 준비되지 않았습니다");
		expect(windows()).toEqual([]);
	});
});

describe.skipIf(!hasTmux)("tool approvals of a tmux session reach the phone (gm#58)", () => {
	const permissionFor = (sid: string) => (e: { ev: string; p: any }) => e.ev === "permission.request" && e.p.sessionId === sid;
	const toolEnd = (sid: string, id: string) => (e: { ev: string; p: any }) =>
		e.ev === "session.update" && e.p.sessionId === sid && e.p.update.toolCallId === id && ["completed", "failed"].includes(e.p.update.status);

	test("shows a phone turn's approval as a card and answers it through gjc's permission channel", async () => {
		// Measured 2026-11-07 on pve3 (gjc 0.19.3): the TUI host sends no session/request_permission over ACP, the
		// channel is prohibited over ACP, and through `gjc sdk session raw` it lists and settles the approval.
		const { client, cwd } = await tmuxBridge({ server: true });
		const sid = (await client.request("session.new", {})).sessionId;
		expect(fs.existsSync(path.join(cwd, ".gjc", "state", "sdk", `${sid}.channel`))).toBe(true);
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "tool please" }] });
		const card = await client.waitFor(permissionFor(sid), 10_000);
		expect(card.p.toolCall).toMatchObject({ toolCallId: "t1", toolName: "bash", rawInput: { command: "echo hi" } });
		expect(card.p.options.map((o: any) => o.kind)).toEqual(["allow_once", "reject_once"]);
		// A phone opening the chat now gets the card in its snapshot too.
		const snap = await client.request("session.open", { sessionId: sid, afterSeq: 0 });
		expect(snap.permissions.map((p: any) => p.requestId)).toEqual([card.p.requestId]);

		await client.request("permission.respond", { requestId: card.p.requestId, optionId: "allow_once" });
		expect((await client.waitFor(toolEnd(sid, "t1"), 10_000)).p.update.status).toBe("completed");
		expect((await client.waitFor(turnEnd(sid))).p.update.stopReason).toBe("end_turn");
		expect(client.events.some(e => e.ev === "permission.resolved" && e.p.requestId === card.p.requestId)).toBe(true);
		expect(await client.request("permission.list", {})).toEqual({ requests: [] });
	});

	test("a rejection reaches gjc as the offered reject option", async () => {
		const { client } = await tmuxBridge({ server: true });
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "tool please" }] });
		const card = await client.waitFor(permissionFor(sid), 10_000);
		// A dismissal (no option) is sent as the rejection gjc offered.
		await client.request("permission.respond", { requestId: card.p.requestId });
		expect((await client.waitFor(toolEnd(sid, "t1"), 10_000)).p.update.status).toBe("failed");
	});

	test("brings a terminal turn's approval too, and drops the card of one that expired unanswered", async () => {
		const { client } = await tmuxBridge({ server: true });
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "terminal turn" } });
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "terminal tool" } });
		const card = await client.waitFor(permissionFor(sid), 10_000);
		expect(card.p.toolCall.toolCallId).toBe("tt1");
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "expire" } });
		await client.waitFor(toolEnd(sid, "tt1"), 5000);
		const gone = await client.waitFor(e => e.ev === "permission.resolved" && e.p.requestId === card.p.requestId, 3000);
		expect(gone.p.sessionId).toBe(sid);
		expect(await client.request("permission.list", {})).toEqual({ requests: [] });
	});

	test("shows the card again when the answer did not reach gjc, and not once gjc no longer has the request", async () => {
		const { client, cwd } = await tmuxBridge({ server: true });
		const sid = (await client.request("session.new", {})).sessionId;
		const sdk = path.join(cwd, ".gjc", "state", "sdk");
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "terminal tool" } });
		const card = await client.waitFor(permissionFor(sid), 10_000);
		// The call fails before gjc: the request still waits, so the phone gets it again and can answer it.
		fs.writeFileSync(path.join(sdk, `${sid}.respond-fail`), "");
		await client.request("permission.respond", { requestId: card.p.requestId, optionId: "allow_once" });
		const again = await client.waitFor(e => permissionFor(sid)(e) && e.p.requestId !== card.p.requestId, 10_000);
		expect(again.p.toolCall.toolCallId).toBe("tt1");
		// gjc dropped the request before the answer came (it expired between two reads): gjc refuses it, no card again.
		const listed = path.join(sdk, `${sid}.requests.json`);
		fs.rmSync(listed);
		await client.request("permission.respond", { requestId: again.p.requestId, optionId: "allow_once" });
		await Bun.sleep(3000);
		expect(client.events.filter(permissionFor(sid))).toHaveLength(2);
		expect(fs.existsSync(path.join(sdk, `${sid}.answer.json`))).toBe(false);
		expect(await client.request("permission.list", {})).toEqual({ requests: [] });
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "expire" } });
		expect((await client.waitFor(toolEnd(sid, "tt1"), 5000)).p.update.status).toBe("failed");
	}, 30_000);

	test("the phone's deny mode still decides without asking once the channel is on", async () => {
		const { client } = await tmuxBridge({ server: true });
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("session.setPermissionMode", { sessionId: sid, mode: "deny" });
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "tool please" }] });
		expect((await client.waitFor(toolEnd(sid, "t1"), 10_000)).p.update.status).toBe("failed");
		await Bun.sleep(300);
		expect(client.events.some(permissionFor(sid))).toBe(false);
	});

	test("a session whose channel cannot be turned on is shown as allow, which it is, and refuses prompt", async () => {
		// Measured 2026-11-07 on pve3: without the channel the TUI host ran bash unasked while the phone showed prompt.
		const { client, cwd } = await tmuxBridge({ server: true, env: { FAKE_CLI_FAIL: "1" } });
		const opened = await client.request("session.new", {});
		const sid = opened.sessionId;
		expect(fs.existsSync(path.join(cwd, ".gjc", "state", "sdk", `${sid}.channel`))).toBe(false);
		expect(opened.permissionMode).toBe("allow");
		const failed = await client.request("session.setPermissionMode", { sessionId: sid, mode: "prompt" }).catch((e: any) => e);
		expect(failed.code).toBe(-32020);
		expect(failed.data).toEqual({ code: "approval_channel_unavailable" });
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "tool please" }] });
		expect((await client.waitFor(toolEnd(sid, "t1"), 10_000)).p.update.status).toBe("completed");
		expect(client.events.some(permissionFor(sid))).toBe(false);
	});

	test("after gjc ACP dies, attaches the tmux session again by itself and shows the approval the TUI still waits on", async () => {
		const { client, cwd, reconnect } = await tmuxBridge({ server: true });
		const sid = (await client.request("session.new", {})).sessionId;
		const answer = path.join(cwd, ".gjc", "state", "sdk", `${sid}.answer.json`);
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "hello" }] });
		await client.waitFor(turnEnd(sid));
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "terminal tool" } });
		const before = await client.waitFor(permissionFor(sid), 10_000);
		const updates = () => client.events.filter(e => e.ev === "session.update" && e.p.sessionId === sid);
		const hellos = () => updates().filter(e => e.p.update.sessionUpdate === "user_message_chunk" && e.p.update.content?.text === "hello").length;
		const hellosBefore = hellos();

		// The ACP process dies (a crash; a recycle restarts it the same way) and no phone opens the chat again.
		await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "crash" }] }).catch(() => {});
		await client.waitFor(e => e.ev === "permission.resolved" && e.p.requestId === before.p.requestId, 5000);
		await client.waitFor(e => e.ev === "session.update" && e.p.sessionId === sid && e.p.update.sessionUpdate === AGENT_EXIT, 5000);
		const again = await client.waitFor(e => permissionFor(sid)(e) && e.p.requestId !== before.p.requestId, 20_000);
		expect(again.p.toolCall.toolCallId).toBe("tt1");
		// Taken down, never answered: the bridge did not reject what the TUI waits on.
		expect(fs.existsSync(answer)).toBe(false);
		// The reload's replay is not news to the phone showing the chat; a phone that saw up to before gets a full snapshot.
		expect(hellos()).toBe(hellosBefore);
		// That phone lacks what the terminal did while ACP was gone, and live updates after the reload hide the gap from
		// afterSeq: its next open, here over a new connection of the same device, is a full snapshot, once.
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "terminal turn" } });
		const live = await client.waitFor(e => e.ev === "session.update" && e.p.sessionId === sid && e.p.update._meta?.gjcPhase === "working", 5000);
		const phone = await reconnect();
		const resynced = await phone.request("session.open", { sessionId: sid, afterSeq: live.p.seq });
		expect(resynced.reset).toBe(true);
		expect(resynced.updates.some((u: any) => u.update.sessionUpdate === "user_message_chunk" && u.update.content?.text === "hello")).toBe(true);
		expect((await phone.request("session.open", { sessionId: sid, afterSeq: resynced.seq })).reset).toBe(false);
		const { updates: replay } = await client.request("session.open", { sessionId: sid, afterSeq: Number.MAX_SAFE_INTEGER });
		// A phone that saw everything right up to the replay.
		const snap = await client.request("session.open", { sessionId: sid, afterSeq: replay[0].seq - 1 });
		expect(snap.reset).toBe(true);
		expect(snap.permissions.map((p: any) => p.requestId)).toEqual([again.p.requestId]);

		await client.request("permission.respond", { requestId: again.p.requestId, optionId: "allow_once" });
		await until(() => fs.existsSync(answer), 10_000);
		expect(JSON.parse(fs.readFileSync(answer, "utf8"))).toMatchObject({ sessionId: sid, optionId: "allow_once" });
	}, 40_000);

	test("switching to allow while a terminal approval waits allows it instead of letting gjc cancel it", async () => {
		const { client } = await tmuxBridge({ server: true });
		const sid = (await client.request("session.new", {})).sessionId;
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "terminal tool" } });
		const card = await client.waitFor(permissionFor(sid), 10_000);
		// gjc cancels the channel's waiting requests when the mode changes.
		await client.request("session.setPermissionMode", { sessionId: sid, mode: "allow" });
		expect((await client.waitFor(toolEnd(sid, "tt1"), 10_000)).p.update.status).toBe("completed");
		expect(client.events.some(e => e.ev === "permission.resolved" && e.p.requestId === card.p.requestId)).toBe(true);
	}, 20_000);

	test("turns the channel on again when the host lost it (a TUI restarted under the same id)", async () => {
		const { client, cwd } = await tmuxBridge({ server: true });
		const sid = (await client.request("session.new", {})).sessionId;
		const channel = path.join(cwd, ".gjc", "state", "sdk", `${sid}.channel`);
		fs.rmSync(channel);
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "terminal tool" } });
		await until(() => fs.existsSync(channel), 10_000);
	}, 20_000);

	test("never shows an answered request again when a read that started before it settled still lists it", async () => {
		const { client, cwd } = await tmuxBridge({ server: true });
		const sid = (await client.request("session.new", {})).sessionId;
		const requests = path.join(cwd, ".gjc", "state", "sdk", `${sid}.requests.json`);
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "terminal tool" } });
		const card = await client.waitFor(permissionFor(sid), 10_000);
		const listed = fs.readFileSync(requests, "utf8");
		await client.request("permission.respond", { requestId: card.p.requestId, optionId: "allow_once" });
		await client.waitFor(toolEnd(sid, "tt1"), 10_000);
		// A stale listing of the answered request, read when the next pending tool call arrives.
		fs.writeFileSync(requests, listed);
		await client.request("sdk.control", { sessionId: sid, op: "turn.steer", input: { text: "terminal tool" } });
		const next = await client.waitFor(e => permissionFor(sid)(e) && e.p.requestId !== card.p.requestId, 10_000);
		expect(client.events.filter(permissionFor(sid)).map(e => e.p.requestId)).toEqual([card.p.requestId, next.p.requestId]);
		// The card shown is the new request's: answering it lets the second call run.
		await client.request("permission.respond", { requestId: next.p.requestId, optionId: "allow_once" });
		await until(() => client.events.filter(toolEnd(sid, "tt1")).length === 2, 10_000);
	}, 20_000);
});

describe.skipIf(!hasTmux)("TmuxLauncher.hosts", () => {
	test("does not take an endpoint that was there before the window, even when the pid it names is now the window's gjc", async () => {
		const socket = `gjcm-test-${crypto.randomBytes(4).toString("hex")}`;
		cleanups.push(() => void tmux(socket, "kill-server"));
		expect(tmux(socket, "new-session", "-d", "-s", "keep", "sleep 600").code).toBe(0);
		const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjcm-tmux-hosts-")));
		cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const sdk = path.join(cwd, ".gjc", "state", "sdk");
		fs.mkdirSync(sdk, { recursive: true });
		// An old session's endpoint, left behind by a process that is gone.
		const stale = path.join(sdk, "stale.json");
		fs.writeFileSync(stale, JSON.stringify({ version: 1, sessionId: "stale", pid: Bun.spawnSync(["true"]).pid }));
		const launcher = new TmuxLauncher({ session: "gjcm", socket }, [...FAKE_AGENT, "--tui=late"]);
		const opening = launcher.open(cwd);
		let panePid = "";
		for (let i = 0; i < 100 && !panePid; i++) {
			await Bun.sleep(10);
			const listed = tmux(socket, "list-panes", "-s", "-t", "=gjcm", "-F", "#{pane_pid}");
			if (listed.code === 0) panePid = listed.stdout.trim();
		}
		// Pids come around again: the one it names is now the window's gjc's. Written in place, the file is the same one.
		const inode = fs.statSync(stale).ino;
		fs.writeFileSync(stale, JSON.stringify({ version: 1, sessionId: "stale", pid: Number(panePid) }));
		expect(fs.statSync(stale).ino).toBe(inode);
		expect((await opening).sessionId).toBe(`tui-${panePid}`);
	});

	test("recognizes the window that hosts a session, and no longer once it is gone", async () => {
		const socket = `gjcm-test-${crypto.randomBytes(4).toString("hex")}`;
		cleanups.push(() => void tmux(socket, "kill-server"));
		expect(tmux(socket, "new-session", "-d", "-s", "keep", "sleep 600").code).toBe(0);
		const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjcm-tmux-hosts-")));
		cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const sdk = path.join(cwd, ".gjc", "state", "sdk");
		fs.mkdirSync(sdk, { recursive: true });
		// Endpoints that show up while gjc in the window starts, naming a live process outside the window or a gone one,
		// are not the new window's session.
		const gone = Bun.spawnSync(["true"]).pid;
		const launcher = new TmuxLauncher({ session: "gjcm", socket }, [...FAKE_AGENT, "--tui=run"]);
		const opening = launcher.open(cwd);
		fs.writeFileSync(path.join(sdk, "left.json"), JSON.stringify({ version: 1, sessionId: "left", pid: process.pid }));
		fs.writeFileSync(path.join(sdk, "dead.json"), JSON.stringify({ version: 1, sessionId: "dead", pid: gone }));
		const { sessionId: sid } = await opening;
		expect(sid).toMatch(/^tui-\d+$/);
		expect(await launcher.hosts(sid, cwd)).toBe(true);
		expect(await launcher.hosts("left", cwd)).toBe(false);
		// What a restarted bridge loads again: the window's session and its directory.
		expect(await launcher.hostedSessions()).toEqual([{ sessionId: sid, cwd }]);
		// A `gjc --resume` the user started in that tmux session is not the bridge's.
		expect(tmux(socket, "new-window", "-d", "-t", "=gjcm:", "sh", "-c", "sleep 600", "--resume", "mine").code).toBe(0);
		expect(await launcher.hostedSessions()).toEqual([{ sessionId: sid, cwd }]);
		expect(await launcher.hosts(`${sid}x`, cwd)).toBe(false);
		// Another session's endpoint naming this window's gjc is not hosted here: the window was opened for `sid`.
		fs.copyFileSync(path.join(sdk, `${sid}.json`), path.join(sdk, "xyz.json"));
		expect(await launcher.hosts("xyz", cwd)).toBe(false);
		// Once its endpoint names a process outside the window, the window no longer hosts it.
		fs.writeFileSync(path.join(sdk, `${sid}.json`), JSON.stringify({ version: 1, sessionId: sid, pid: process.pid }));
		expect(await launcher.hosts(sid, cwd)).toBe(false);
	});
});
