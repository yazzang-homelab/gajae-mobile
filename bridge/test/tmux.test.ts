import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TURN_END } from "../src/hub";
import { TmuxLauncher, tuiCommand } from "../src/tmux";
import { FAKE_AGENT, startTestBridge } from "./helpers";

const hasTmux = Bun.which("tmux") !== null;
const turnEnd = (sid: string) => (e: { ev: string; p: any }) => e.ev === "session.update" && e.p.sessionId === sid && e.p.update.sessionUpdate === TURN_END;
const askCall = (client: { events: { ev: string; p: any }[] }, sid: string) =>
	client.events.find(e => e.ev === "session.update" && e.p.sessionId === sid && e.p.update.toolCallId === "ask1" && e.p.update.sessionUpdate === "tool_call")!.p.update;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tmux(socket: string, ...args: string[]) {
	const proc = Bun.spawnSync(["tmux", "-L", socket, ...args]);
	return { code: proc.exitCode, stdout: proc.stdout.toString().trim() };
}

/** A bridge whose new sessions go to tmux session `gjcm` on a private tmux socket. */
async function tmuxBridge(options: { server: boolean; tui?: string; readyTimeoutMs?: number }) {
	const socket = `gjcm-test-${crypto.randomBytes(4).toString("hex")}`;
	cleanups.push(() => void tmux(socket, "kill-server"));
	// The user's own tmux server, which the bridge only joins.
	if (options.server) expect(tmux(socket, "new-session", "-d", "-s", "keep", "sleep 600").code).toBe(0);
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjcm-tmux-cwd-")));
	cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const command = [...FAKE_AGENT, "--mode=acp", ...(options.tui ? [`--tui=${options.tui}`] : [])];
	const tmuxOptions = { session: "gjcm", socket, ...(options.readyTimeoutMs ? { readyTimeoutMs: options.readyTimeoutMs } : {}) };
	const bridge = await startTestBridge(command, cwd, { GJCM_TEST_TMUX: JSON.stringify(tmuxOptions) });
	cleanups.push(() => bridge.stop());
	const { client } = await bridge.pairedClient();
	const windows = () => {
		const listed = tmux(socket, "list-panes", "-s", "-t", "=gjcm", "-F", "#{pane_start_command}");
		return listed.code === 0 ? listed.stdout.split("\n").filter(Boolean) : [];
	};
	return { socket, cwd, client, windows, home: bridge.home };
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
	test("opens each new session as a window of the gjcm session and drives it from the phone", async () => {
		const { cwd, client, windows, home } = await tmuxBridge({ server: true });
		const first = await client.request("session.new", {});
		expect(first.cwd).toBe(cwd);
		// gjc in the window (which the fake only starts after ACP closed the session) uses the bridge's agent dir.
		const endpoint = JSON.parse(fs.readFileSync(path.join(cwd, ".gjc", "state", "sdk", `${first.sessionId}.json`), "utf8"));
		expect(endpoint.agentDir).toBe(path.join(home, "agent"));
		expect(windows()).toHaveLength(1);
		expect(windows()[0]).toContain(`--resume ${first.sessionId}`);
		expect(windows()[0]).not.toContain("--mode=acp");

		const sid = first.sessionId;
		expect(await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "hello" }] })).toEqual({ accepted: true });
		const end = await client.waitFor(turnEnd(sid));
		expect(end.p.update.stopReason).toBe("end_turn");

		// The second one joins the same tmux session instead of creating another.
		const second = await client.request("session.new", {});
		expect(windows()).toHaveLength(2);
		expect(windows()[1]).toContain(`--resume ${second.sessionId}`);
	});

	test("two phones starting sessions together get one gjcm session with two windows", async () => {
		const { socket, client, windows } = await tmuxBridge({ server: true });
		const [a, b] = await Promise.all([client.request("session.new", {}), client.request("session.new", {})]);
		expect(a.sessionId).not.toBe(b.sessionId);
		expect(tmux(socket, "list-sessions", "-F", "#{session_name}").stdout.split("\n").sort()).toEqual(["gjcm", "keep"]);
		expect(windows()).toHaveLength(2);
	});

	test("does not start a tmux server when the user's goes away between the check and the window", async () => {
		// open() is what runs after unavailable() passed; with no server by then it must fail, not start one.
		const socket = `gjcm-test-${crypto.randomBytes(4).toString("hex")}`;
		cleanups.push(() => void tmux(socket, "kill-server"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjcm-tmux-cwd-"));
		cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const launcher = new TmuxLauncher({ session: "gjcm", socket }, ["sleep", "60"]);
		const failed = await launcher.open("s1", cwd).catch((e: any) => e);
		expect(failed.code).toBe("tmux_failed");
		expect(tmux(socket, "list-sessions").code).not.toBe(0);
	});

	test("opens over ACP when no tmux server runs, without starting one", async () => {
		const { socket, client, windows } = await tmuxBridge({ server: false });
		const sid = (await client.request("session.new", {})).sessionId;
		expect(await client.request("session.prompt", { sessionId: sid, prompt: [{ type: "text", text: "ask me" }] })).toEqual({ accepted: true });
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
