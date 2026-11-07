/**
 * Opens a phone-started session as a window of one dedicated tmux session (gm#58), so the terminal shows the
 * same TUI the phone drives. The window runs `gjc --resume <id>`: gjc writes the transcript only after the first
 * answer for a TUI-started session, and ACP `session/load` resolves a session through that transcript, so the
 * bridge creates the session over ACP (which writes it at once), lets go of it, and hands it to the TUI.
 *
 * The bridge never starts a tmux server: a server started from the bridge's systemd unit would live in the
 * bridge's cgroup and die with every bridge restart, taking the phone's sessions with it.
 */
import fs from "node:fs";
import path from "node:path";

export interface TmuxOptions {
	/** tmux session that collects the windows; created on the first window. */
	session: string;
	/** `tmux -L` socket name; the user's default server when absent. */
	socket?: string;
	/** How long gjc in the window may take to publish its SDK endpoint (measured 5.6–6.6s on pve3). */
	readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const POLL_MS = 200;

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

/** The TUI launcher from the bridge's ACP command: the same gjc without `--mode=acp`. */
export function tuiCommand(acpCommand: string[]): string[] {
	const argv: string[] = [];
	for (let i = 0; i < acpCommand.length; i++) {
		const arg = acpCommand[i]!;
		if (arg === "--mode=acp") continue;
		if (arg === "--mode" && acpCommand[i + 1] === "acp") {
			i++;
			continue;
		}
		argv.push(arg);
	}
	return argv;
}

/** Whether `pid` is `ancestor` or runs below it (the launcher may be a wrapper that starts gjc as a child). */
function descendsFrom(pid: number, ancestor: number): boolean {
	let current = pid;
	for (let depth = 0; depth < 16 && current > 1; depth++) {
		if (current === ancestor) return true;
		const ps = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(current)]);
		const parent = Number(ps.stdout.toString().trim());
		if (!Number.isInteger(parent) || parent <= 0) return false;
		current = parent;
	}
	return false;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export class TmuxLauncher {
	readonly #options: TmuxOptions;
	readonly #tui: string[];
	#queue: Promise<unknown> = Promise.resolve();

	constructor(options: TmuxOptions, tui: string[]) {
		this.#options = options;
		this.#tui = tui;
	}

	get session(): string {
		return this.#options.session;
	}

	async #run(args: string[]): Promise<Run> {
		const argv = ["tmux", ...(this.#options.socket ? ["-L", this.#options.socket] : []), ...args];
		try {
			const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
			return { code, stdout: stdout.trim(), stderr: stderr.trim() };
		} catch (error) {
			return { code: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Why a new session cannot go to tmux now (no tmux, no server running), or undefined when it can. */
	async unavailable(): Promise<string | undefined> {
		const listed = await this.#run(["list-sessions", "-F", "#{session_name}"]);
		if (listed.code === 0) return undefined;
		return listed.stderr || `tmux list-sessions exited ${listed.code}`;
	}

	/**
	 * Starts `gjc --resume <sessionId>` in a new window of the dedicated session and waits until that process
	 * publishes the session's SDK endpoint. Removes the window and throws when it does not.
	 */
	open(sessionId: string, cwd: string): Promise<void> {
		// One window at a time, so two phones starting sessions together do not both create the tmux session.
		const opened = this.#queue.then(() => this.#open(sessionId, cwd));
		this.#queue = opened.catch(() => {});
		return opened;
	}

	async #open(sessionId: string, cwd: string): Promise<void> {
		const { session } = this.#options;
		const command = [...this.#tui, "--resume", sessionId];
		const format = ["-P", "-F", "#{pane_pid} #{pane_id}"];
		const exists = (await this.#run(["has-session", "-t", `=${session}`])).code === 0;
		const created = exists
			? await this.#run(["new-window", "-d", "-t", `=${session}:`, "-c", cwd, ...format, ...command])
			: await this.#run(["new-session", "-d", "-s", session, "-c", cwd, ...format, ...command]);
		if (created.code !== 0) throw new Error(`tmux ${exists ? "new-window" : "new-session"} failed: ${created.stderr || created.code}`);
		const [pidText, pane] = created.stdout.split(" ");
		const panePid = Number(pidText);
		if (!Number.isInteger(panePid) || !pane) throw new Error(`tmux returned no pane: ${created.stdout}`);

		const endpoint = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
		const timeoutMs = this.#options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		const deadline = Date.now() + timeoutMs;
		let reason = `gjc가 ${Math.round(timeoutMs / 1000)}초 안에 준비되지 않았습니다`;
		while (Date.now() < deadline) {
			if (!alive(panePid)) {
				reason = "gjc가 창에서 바로 끝났습니다";
				break;
			}
			const pid = this.#endpointPid(endpoint);
			// A stale endpoint of the ACP host that created the session names another process.
			if (pid !== undefined && descendsFrom(pid, panePid)) return;
			await Bun.sleep(POLL_MS);
		}
		await this.#run(["kill-pane", "-t", pane]);
		throw new Error(`tmux 창(${session})에서 ${reason}`);
	}

	#endpointPid(file: string): number | undefined {
		try {
			const pid = JSON.parse(fs.readFileSync(file, "utf8"))?.pid;
			return Number.isInteger(pid) ? pid : undefined;
		} catch {
			return undefined;
		}
	}
}
