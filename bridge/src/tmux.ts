/**
 * Opens a phone-started session as a window of one dedicated tmux session (gm#58), so the terminal shows the
 * same TUI the phone drives. The window runs plain `gjc`, which starts a new session itself; the bridge learns its
 * id from the SDK endpoint that process publishes and attaches with ACP `session/load`, which reaches a live host
 * through the broker before any transcript exists (measured on 0.19.3 and 0.20.0). gjc writes the endpoint first and
 * registers the session with the broker after it, without waiting (`session-runtime.ts`: `runtime.start()`, then
 * `registerBroker()`); until then the load answers `not_found`, so the hub tries it again while the window lives. One
 * gjc start instead of creating the session over ACP first and resuming it in the window: bridge `session.new`
 * measured 2026-11-09 in /root/tmp, pve3 22–27s → 14–15s, lab 8.3s → 5.3–7.4s.
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
	/** How long gjc in the window may take to publish its SDK endpoint (measured 2026-11-09 in /root/tmp: lab 3.6–3.8s, pve3 10–11s, pve1 7.7–8.3s). */
	readyTimeoutMs?: number;
	/**
	 * How long the hub tries `session/load` while gjc in the window registers its session with the broker, which waits on
	 * the broker and its session index lock: a busy host may take seconds.
	 */
	attachTimeoutMs?: number;
}

/**
 * Why a window did not become the session's host; the bridge passes it to the phone as -32021 `data.code`.
 * `tmux_attach_failed` is the hub's: the window's gjc published its endpoint, but `session/load` never attached.
 */
export type TmuxFailure = "tmux_failed" | "tmux_window_exited" | "tmux_ready_timeout" | "tmux_attach_failed";

export class TmuxError extends Error {
	constructor(
		readonly code: TmuxFailure,
		message: string,
	) {
		super(message);
	}
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_ATTACH_TIMEOUT_MS = 15_000;
const POLL_MS = 200;
/** tmux turns `.` and `:` in session names into `_`, so such a name would never be found again. */
const SESSION_NAME = /^[A-Za-z0-9_-]+$/;
/** The window option naming the session a window was opened for: only windows the bridge opened carry it. */
const SESSION_TAG = "@gjcm_session";
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

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

const PROCFS = fs.existsSync("/proc/self/stat");

function parentPid(pid: number): number | undefined {
	try {
		if (PROCFS) {
			// /proc/<pid>/stat: "pid (comm) state ppid …"; comm may hold spaces and parentheses.
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		}
		// No procfs (macOS): ask ps.
		const parent = Number(Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]).stdout.toString().trim());
		return Number.isInteger(parent) && parent > 0 ? parent : undefined;
	} catch {
		// The process is gone (or ps is missing).
		return undefined;
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

	get attachTimeoutMs(): number {
		return this.#options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
	}

	/** Why a new session cannot go to tmux now (no tmux, no server running), or undefined when it can. */
	async unavailable(): Promise<string | undefined> {
		const listed = await this.#run(["list-sessions", "-F", "#{session_name}"]);
		if (listed.code === 0) return undefined;
		return listed.stderr || `tmux list-sessions exited ${listed.code}`;
	}

	/**
	 * Starts gjc in a new window of the dedicated session, waits until that process publishes the SDK endpoint of the
	 * session it started, and returns that session's id with the window's pane. Removes the window and throws a
	 * TmuxError when it does not.
	 */
	async open(cwd: string): Promise<{ sessionId: string; pane: string }> {
		const dir = path.join(cwd, ".gjc", "state", "sdk");
		// Endpoints already there are other processes'. One may name a pid that comes around again as the window's gjc;
		// gjc writes each endpoint to a new file (temp file, then rename), so the window's has an inode not seen here.
		const existing = this.#endpoints(dir);
		// Window creation runs one at a time, so two phones starting sessions together do not both create the
		// tmux session; waiting for gjc does not hold the next phone up.
		const created = this.#creating.then(() => this.#create(cwd));
		this.#creating = created.catch(() => {});
		const { panePid, pane } = await created;
		try {
			const sessionId = await this.#waitReady(dir, panePid, existing);
			// Untagged, the window would not be found again: its tool approvals would reach no phone.
			const tagged = await this.#run(["set-option", "-w", "-t", pane, SESSION_TAG, sessionId]);
			if (tagged.code !== 0) throw new TmuxError("tmux_failed", `tmux 창에 세션 표시를 못 달았습니다: ${tagged.stderr || `exit ${tagged.code}`}`);
			return { sessionId, pane };
		} catch (error) {
			await this.close(pane);
			throw error;
		}
	}

	/** Removes a window `open` made (tmux sends its gjc SIGHUP). */
	async close(pane: string): Promise<void> {
		await this.#run(["kill-pane", "-t", pane]);
	}

	/**
	 * Whether a window of the dedicated session hosts `sessionId` now: the bridge opened it for `sessionId` and the
	 * session's SDK endpoint names a process in it. Recognizes the bridge's windows again after a bridge restart; a
	 * `gjc --resume` the user started in that tmux session is theirs and keeps its own approvals.
	 */
	async hosts(sessionId: string, cwd: string): Promise<boolean> {
		const pid = this.#endpointPid(path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`));
		if (pid === undefined) return false;
		return (await this.#panes()).some(pane => pane.sessionId === sessionId && descendsFrom(pid, pane.panePid));
	}

	/**
	 * The sessions the bridge opened the dedicated session's windows for, with each window's working directory: what
	 * to load again after a bridge or ACP restart. `hosts` confirms each one.
	 */
	async hostedSessions(): Promise<Array<{ sessionId: string; cwd: string }>> {
		return (await this.#panes()).map(({ sessionId, cwd }) => ({ sessionId, cwd }));
	}

	async #panes(): Promise<Array<{ panePid: number; sessionId: string; cwd: string }>> {
		const listed = await this.#run(["list-panes", "-s", "-t", `=${this.#options.session}`, "-F", `#{pane_pid}\t#{pane_current_path}\t#{${SESSION_TAG}}`]);
		if (listed.code !== 0) return [];
		return listed.stdout.split("\n").flatMap(line => {
			const [pidText = "", cwd = "", sessionId = ""] = line.split("\t");
			const panePid = Number(pidText);
			return SESSION_ID.test(sessionId) && Number.isInteger(panePid) ? [{ panePid, sessionId, cwd }] : [];
		});
	}

	async #create(cwd: string): Promise<{ panePid: number; pane: string }> {
		const { session } = this.#options;
		const env = Object.entries(this.#env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
		// tmux expands formats in -c; a literal `#` in the path is written `##`.
		const start = ["-c", cwd.replaceAll("#", "##"), ...env, "-P", "-F", "#{pane_pid} #{pane_id}"];
		const exists = (await this.#run(["has-session", "-t", `=${session}`])).code === 0;
		const created = exists
			? await this.#run(["new-window", "-d", "-t", `=${session}:`, ...start, ...this.#tui])
			: await this.#run(["new-session", "-d", "-s", session, ...start, ...this.#tui]);
		const verb = exists ? "new-window" : "new-session";
		if (created.code !== 0) throw new TmuxError("tmux_failed", `tmux ${verb} 실패: ${created.stderr || `exit ${created.code}`}`);
		const [pidText, pane] = created.stdout.split(" ");
		const panePid = Number(pidText);
		if (!Number.isInteger(panePid) || !pane) throw new TmuxError("tmux_failed", `tmux ${verb}가 창 정보를 주지 않았습니다: ${created.stdout}`);
		return { panePid, pane };
	}

	/**
	 * The id of the session gjc in the window started: the one whose SDK endpoint names that process. Endpoints in
	 * `existing` are skipped; others name a pid outside the window (or a gone one), and each is read once.
	 */
	async #waitReady(dir: string, panePid: number, existing: Map<string, bigint>): Promise<string> {
		const { session } = this.#options;
		const timeoutMs = this.#options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		const deadline = Date.now() + timeoutMs;
		const foreign = new Set<string>();
		while (Date.now() < deadline) {
			if (!alive(panePid)) throw new TmuxError("tmux_window_exited", `tmux 세션 ${session}의 새 창에서 gjc가 바로 끝났습니다`);
			for (const [sessionId, inode] of this.#endpoints(dir)) {
				if (existing.get(sessionId) === inode) continue;
				const pid = this.#endpointPid(path.join(dir, `${sessionId}.json`));
				if (pid === undefined) continue;
				const key = `${sessionId}\t${pid}`;
				if (foreign.has(key)) continue;
				if (alive(pid) && descendsFrom(pid, panePid)) return sessionId;
				foreign.add(key);
			}
			await Bun.sleep(POLL_MS);
		}
		throw new TmuxError("tmux_ready_timeout", `tmux 세션 ${session}의 새 창에서 gjc가 ${Math.round(timeoutMs / 1000)}초 안에 준비되지 않았습니다`);
	}

	/** The SDK endpoint files (`<id>.json`) in `dir`: session id → inode. */
	#endpoints(dir: string): Map<string, bigint> {
		const endpoints = new Map<string, bigint>();
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return endpoints;
		}
		for (const name of names) {
			const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
			if (!SESSION_ID.test(id)) continue;
			try {
				endpoints.set(id, fs.statSync(path.join(dir, name), { bigint: true }).ino);
			} catch {
				// Gone since the listing, or unreadable: nothing to take.
			}
		}
		return endpoints;
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
