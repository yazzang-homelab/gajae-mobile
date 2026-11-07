/**
 * Opens a phone-started session as a window of one dedicated tmux session (gm#58), so the terminal shows the
 * same TUI the phone drives. The window runs `gjc --resume <id>`: gjc writes the transcript only after the first
 * answer for a TUI-started session, and ACP `session/load` resolves a session through that transcript, so the
 * bridge creates the session over ACP (which writes it at once), lets go of it, and hands it to the TUI.
 *
 * The bridge never starts a tmux server: a server started from the bridge's systemd unit would live in the
 * bridge's cgroup and die with every bridge restart, taking the phone's sessions with it. Every tmux call carries
 * `-N` (tmux 3.2+), so a server that goes away between the check and the window is not started again.
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

/** Why a window did not become the session's host; the bridge passes it to the phone as -32021 `data.code`. */
export type TmuxFailure = "tmux_failed" | "tmux_window_exited" | "tmux_ready_timeout";

export class TmuxError extends Error {
	constructor(
		readonly code: TmuxFailure,
		message: string,
	) {
		super(message);
	}
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const POLL_MS = 200;
/** tmux turns `.` and `:` in session names into `_`, so such a name would never be found again. */
const SESSION_NAME = /^[A-Za-z0-9_-]+$/;

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

function parentPid(pid: number): number | undefined {
	try {
		// /proc/<pid>/stat: "pid (comm) state ppid …"; comm may hold spaces and parentheses.
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
	} catch {
		// No procfs (macOS): ask ps.
		const ps = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]);
		const parent = Number(ps.stdout.toString().trim());
		return Number.isInteger(parent) && parent > 0 ? parent : undefined;
	}
}

/** Whether `pid` is `ancestor` or runs below it (the launcher may be a wrapper that starts gjc as a child). */
function descendsFrom(pid: number, ancestor: number): boolean {
	let current: number | undefined = pid;
	for (let depth = 0; depth < 16 && current !== undefined && current > 1; depth++) {
		if (current === ancestor) return true;
		current = parentPid(current);
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
	readonly #env: Record<string, string>;
	#creating: Promise<unknown> = Promise.resolve();

	/** `env` goes into the window: tmux gives it the server's environment, not the bridge's. */
	constructor(options: TmuxOptions, tui: string[], env: Record<string, string> = {}) {
		if (!SESSION_NAME.test(options.session)) throw new Error(`tmux session name must match ${SESSION_NAME}: ${options.session}`);
		this.#options = options;
		this.#tui = tui;
		this.#env = env;
	}

	async #run(args: string[]): Promise<Run> {
		const argv = ["tmux", "-N", ...(this.#options.socket ? ["-L", this.#options.socket] : []), ...args];
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
	 * publishes the session's SDK endpoint. Removes the window and throws a TmuxError when it does not.
	 */
	async open(sessionId: string, cwd: string): Promise<void> {
		// Window creation runs one at a time, so two phones starting sessions together do not both create the
		// tmux session; waiting for gjc does not hold the next phone up.
		const created = this.#creating.then(() => this.#create(sessionId, cwd));
		this.#creating = created.catch(() => {});
		const { panePid, pane } = await created;
		try {
			await this.#waitReady(sessionId, cwd, panePid);
		} catch (error) {
			await this.#run(["kill-pane", "-t", pane]);
			throw error;
		}
	}

	/**
	 * Whether a window of the dedicated session hosts `sessionId` now: it was started as `--resume <sessionId>` and
	 * the session's SDK endpoint names a process in it. Recognizes the bridge's windows again after a bridge restart.
	 */
	async hosts(sessionId: string, cwd: string): Promise<boolean> {
		const pid = this.#endpointPid(path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`));
		if (pid === undefined) return false;
		return (await this.#panes()).some(pane => pane.sessionId === sessionId && descendsFrom(pid, pane.panePid));
	}

	/**
	 * The sessions the dedicated session's windows were started for (`--resume <id>`), with each window's working
	 * directory: what to load again after a bridge or ACP restart. `hosts` confirms each one.
	 */
	async hostedSessions(): Promise<Array<{ sessionId: string; cwd: string }>> {
		return (await this.#panes()).map(({ sessionId, cwd }) => ({ sessionId, cwd }));
	}

	async #panes(): Promise<Array<{ panePid: number; sessionId: string; cwd: string }>> {
		const listed = await this.#run(["list-panes", "-s", "-t", `=${this.#options.session}`, "-F", "#{pane_pid}\t#{pane_current_path}\t#{pane_start_command}"]);
		if (listed.code !== 0) return [];
		return listed.stdout.split("\n").flatMap(line => {
			const [pidText = "", cwd = "", command = ""] = line.split("\t");
			const panePid = Number(pidText);
			const words = command.split(/\s+/);
			const at = words.indexOf("--resume");
			const sessionId = at >= 0 ? words[at + 1] : undefined;
			return sessionId && Number.isInteger(panePid) ? [{ panePid, sessionId, cwd }] : [];
		});
	}

	async #create(sessionId: string, cwd: string): Promise<{ panePid: number; pane: string }> {
		const { session } = this.#options;
		const env = Object.entries(this.#env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
		// tmux expands formats in -c; a literal `#` in the path is written `##`.
		const start = ["-c", cwd.replaceAll("#", "##"), ...env, "-P", "-F", "#{pane_pid} #{pane_id}"];
		const command = [...this.#tui, "--resume", sessionId];
		const exists = (await this.#run(["has-session", "-t", `=${session}`])).code === 0;
		const created = exists
			? await this.#run(["new-window", "-d", "-t", `=${session}:`, ...start, ...command])
			: await this.#run(["new-session", "-d", "-s", session, ...start, ...command]);
		const verb = exists ? "new-window" : "new-session";
		if (created.code !== 0) throw new TmuxError("tmux_failed", `tmux ${verb} 실패: ${created.stderr || `exit ${created.code}`}`);
		const [pidText, pane] = created.stdout.split(" ");
		const panePid = Number(pidText);
		if (!Number.isInteger(panePid) || !pane) throw new TmuxError("tmux_failed", `tmux ${verb}가 창 정보를 주지 않았습니다: ${created.stdout}`);
		return { panePid, pane };
	}

	async #waitReady(sessionId: string, cwd: string, panePid: number): Promise<void> {
		const { session } = this.#options;
		const endpoint = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
		const timeoutMs = this.#options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		const deadline = Date.now() + timeoutMs;
		// The endpoint the ACP host left behind names a process outside the window; check each pid once.
		const foreign = new Set<number>();
		while (Date.now() < deadline) {
			if (!alive(panePid)) throw new TmuxError("tmux_window_exited", `tmux 세션 ${session}의 새 창에서 gjc가 바로 끝났습니다`);
			const pid = this.#endpointPid(endpoint);
			if (pid !== undefined && !foreign.has(pid)) {
				if (descendsFrom(pid, panePid)) return;
				foreign.add(pid);
			}
			await Bun.sleep(POLL_MS);
		}
		throw new TmuxError("tmux_ready_timeout", `tmux 세션 ${session}의 새 창에서 gjc가 ${Math.round(timeoutMs / 1000)}초 안에 준비되지 않았습니다`);
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
