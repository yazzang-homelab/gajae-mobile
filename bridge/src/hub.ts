/**
 * SessionHub owns the single long-lived `gjc --mode=acp` process and multiplexes it to phones.
 *
 * - Every ACP `session/update` is stamped with a per-session monotonically increasing `seq`
 *   and kept in a bounded replay buffer, so a phone that drops off cellular resumes with
 *   `session.open { afterSeq }` instead of reloading history.
 * - Turns are fire-and-forget for the phone: `session.prompt` returns once accepted and the
 *   end of turn arrives as a buffered `x_gjcm_turn_end` update.
 * - `session/request_permission` from gjc is parked until any subscribed phone answers;
 *   it is re-offered on reconnect and resolved as cancelled on `session.cancel`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpError, AcpProcess, type AcpSpawnOptions } from "./acp";
import { hostAskSettled, hostAskToolCall, scanTranscriptAsks } from "./host-asks";
import { SavedSessionIndex } from "./saved-sessions";
import { Throughput } from "./throughput";

export const TURN_END = "x_gjcm_turn_end";

/**
 * SDK operations the phone may call. Every entry has ACP disposition generic_safe in gjc's
 * operation inventory. Operations that start a turn outside session/prompt (retry.*,
 * turn.abort_and_prompt) are left out: the hub would not see their turn end. mode.plan.set is left
 * out because gjc rejects it over ACP ("requires an active host plan-mode lifecycle", measured).
 */
export const SDK_QUERIES = new Set([
	"context.get",
	"usage.get",
	"session.stats",
	"session.metadata",
	"session.last_assistant",
	"todo.list",
	"skill.list/state",
	"models.list/current",
	"queue.messages.list",
	"workflow.gates.list",
	"diff.list_files",
	"diff.list_hunks",
	"diff.read_hunk",
	"goal.list/get",
	"runtime.jobs.list",
	"extensions.list",
	"providers.list/active",
]);
export const SDK_CONTROLS = new Set([
	"turn.steer",
	// Ephemeral /btw side question (gjc local patch 0004): { question, exchanges? } -> { replyText }.
	"turn.btw",
	"turn.follow_up",
	"compaction.run",
	"context.clear",
	"session.rename",
	"session.export_html",
	"mode.goal.operate",
	"model.set",
	"thinking.set",
	"service_tier.set",
	"queue.message.remove",
	"todo.replace",
	"ask.answer",
	"workflow.gate_answer",
	"workflow.plan_approve",
	"extension.set_enabled",
]);
export const AGENT_EXIT = "x_gjcm_agent_exit";
/** Buffered update the bridge emits when a phone changes a session's permission mode. */
export const PERMISSION_MODE_UPDATE = "x_gjcm_permission_mode";

/**
 * gjc's per-session SDK permission policy for guarded tools (bash, eval, delete, move):
 * `prompt` asks the phone, `allow` runs them without asking, `deny` rejects them.
 */
export const PERMISSION_MODES = ["prompt", "allow", "deny"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
const STALE_ATTACHMENT = "SDK session attachment is stale";

export interface BufferedUpdate {
	seq: number;
	update: Record<string, unknown>;
}

export type PermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

export interface PendingPermission {
	requestId: string;
	sessionId: string;
	toolCall: unknown;
	options: Array<{ optionId: string; name: string; kind: string }>;
	resolve(outcome: PermissionOutcome): void;
}

interface SessionState {
	sessionId: string;
	cwd: string;
	seq: number;
	buffer: BufferedUpdate[];
	bufferBytes: number;
	loaded: boolean;
	loading?: Promise<void>;
	running: boolean;
	/** Settles when the bridge-started `session/prompt` in flight resolves or rejects. */
	turn?: Promise<void>;
	/** gjc's own phase flag (session_info_update _meta.running): also true for turns started elsewhere. */
	hostRunning: boolean;
	throughput: Throughput;
	/** In-flight `session.stats` read feeding [throughput]. */
	usageSample?: Promise<void>;
	/** gjc's own message queue while working, wherever the messages came from (this phone, another, the TUI). */
	queued: QueuedMessage[];
	/** In-flight `queue.messages.list` read feeding [queued]. */
	queueSample?: Promise<void>;
	configOptions: unknown[];
	/**
	 * gjc resets a session to `prompt` on every ACP attachment (session/new, session/load), so the bridge
	 * owns the chosen mode and reapplies it whenever it reloads the session.
	 */
	permissionMode: PermissionMode;
	/** Asks of a TUI turn the phone was shown from the transcript (see host-asks.ts), still unanswered. */
	hostAsks: Set<string>;
	/** Transcript path and the size/mtime last scanned for [hostAsks]. */
	hostAskScan?: { file: string; size: number; mtimeMs: number };
}

export interface SessionStatus {
	sessionId: string;
	running: boolean;
	/** Output tokens/s of model time (gjc usage plus a text estimate): this turn while running, the last turn when idle. */
	tokensPerSecond?: number;
	/** gjc's waiting steers and follow-ups, read once a second while the session works; empty when idle. */
	queued: QueuedMessage[];
}

export interface QueuedMessage {
	id: string;
	text: string;
	mode: "steer" | "followUp";
}

const STREAMED_TEXT_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk"]);

export interface HubClient {
	readonly id: string;
	deliver(event: string, payload: unknown): void;
}

export interface HubOptions {
	acp: AcpSpawnOptions;
	defaultCwd: string;
	/** gjc agent dir whose saved transcripts back `session.list` (see saved-sessions.ts). */
	agentDir: string;
	maxBufferedUpdates?: number;
	maxBufferedBytes?: number;
	version: string;
}

export interface OpenSnapshot {
	sessionId: string;
	cwd: string;
	configOptions: unknown[];
	running: boolean;
	seq: number;
	/** true when afterSeq predates the replay buffer: the client must discard its transcript. */
	reset: boolean;
	updates: BufferedUpdate[];
	permissions: Array<Omit<PendingPermission, "resolve">>;
	permissionMode: PermissionMode;
}

export class SessionHub {
	#options: Required<Omit<HubOptions, "acp">> & { acp: AcpSpawnOptions };
	readonly #saved: SavedSessionIndex;
	#acp?: AcpProcess;
	#starting?: Promise<AcpProcess>;
	#agentInfo: unknown;
	#sessions = new Map<string, SessionState>();
	#permissions = new Map<string, PendingPermission>();
	#clients = new Map<string, { client: HubClient; sessions: Set<string> }>();
	#nextPermission = 1;
	#restartDelayMs = 0;
	#recyclePending = false;
	#statusTimer?: ReturnType<typeof setInterval>;

	constructor(options: HubOptions) {
		this.#options = { maxBufferedUpdates: 5000, maxBufferedBytes: 48 * 1024 * 1024, ...options };
		this.#saved = new SavedSessionIndex(options.agentDir);
	}

	// ── clients ──────────────────────────────────────────────────────────────

	attach(client: HubClient): void {
		this.#clients.set(client.id, { client, sessions: new Set() });
	}

	detach(clientId: string): void {
		this.#clients.delete(clientId);
	}

	// ── ACP process lifecycle ────────────────────────────────────────────────

	async agent(): Promise<AcpProcess> {
		if (this.#acp && !this.#acp.closed) return this.#acp;
		this.#starting ??= this.#start().finally(() => {
			this.#starting = undefined;
		});
		return this.#starting;
	}

	async #start(): Promise<AcpProcess> {
		if (this.#restartDelayMs > 0) await Bun.sleep(this.#restartDelayMs);
		const acp = new AcpProcess(this.#options.acp, {
			onNotification: (method, params) => this.#onNotification(method, params),
			onRequest: (method, params) => this.#onRequest(method, params),
			onExit: code => this.#onExit(acp, code),
		});
		try {
			const init = await acp.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: {
					fs: { readTextFile: false, writeTextFile: false },
					terminal: false,
					_meta: { gjc: { permissionHandling: "prompt" } },
				},
				clientInfo: { name: "gjc-mobile-bridge", version: this.#options.version },
			});
			this.#agentInfo = init.agentInfo;
			this.#acp = acp;
			this.#restartDelayMs = 0;
			queueMicrotask(() => this.#maybeRecycle());
			return acp;
		} catch (error) {
			acp.kill();
			this.#restartDelayMs = Math.min(Math.max(this.#restartDelayMs * 2, 1000), 30_000);
			throw error;
		}
	}

	#onExit(acp: AcpProcess, code: number | null): void {
		if (this.#acp !== acp) return;
		this.#acp = undefined;
		// Whatever spawns next resolves the launcher again, so a pending recycle is satisfied.
		this.#recyclePending = false;
		this.#restartDelayMs = Math.min(Math.max(this.#restartDelayMs * 2, 1000), 30_000);
		for (const permission of this.#permissions.values()) permission.resolve({ outcome: "cancelled" });
		this.#permissions.clear();
		for (const state of this.#sessions.values()) {
			state.loaded = false;
			if (state.running) {
				state.running = false;
				this.#append(state, { sessionUpdate: AGENT_EXIT, code, stderrTail: acp.stderrTail.slice(-2000) });
			}
		}
	}

	stop(): void {
		if (this.#statusTimer) clearInterval(this.#statusTimer);
		this.#acp?.kill();
	}

	/**
	 * Observed on gjc 0.18.7: after hours of uptime the ACP process's broker socket can go bad, and
	 * every resume then fails ~10s in with "SDK request outcome is uncertain after the frame was sent"
	 * until the process restarts. When nothing is mid-turn, drop that process so the next request
	 * spawns a fresh one instead of failing forever.
	 */
	#recycleOnBrokerLoss(acp: AcpProcess, error: unknown): void {
		const message = String((error as Error)?.message ?? error);
		if (!message.includes("outcome is uncertain after the frame was sent")) return;
		if ([...this.#sessions.values()].some(s => s.running) || this.#permissions.size > 0) return;
		if (this.#acp !== acp) return;
		// Detach synchronously so the very next request already starts a fresh process.
		this.#onExit(acp, null);
		acp.kill();
	}

	/**
	 * An updater that switches the gjc build the ACP launcher points at sends SIGHUP. Restart
	 * the ACP process so new sessions run that build, but only once no phone-started turn is running
	 * and no permission prompt is waiting; otherwise retry when the last one finishes.
	 */
	recycleWhenIdle(): void {
		this.#recyclePending = true;
		this.#maybeRecycle();
	}

	get recyclePending(): boolean {
		return this.#recyclePending;
	}

	#maybeRecycle(): void {
		if (!this.#recyclePending) return;
		const acp = this.#acp;
		// Not running: the next agent() spawns the new build. Still starting: re-checked once it is up.
		if (!acp) {
			if (!this.#starting) this.#recyclePending = false;
			return;
		}
		if ([...this.#sessions.values()].some(s => s.running) || this.#permissions.size > 0) return;
		this.#onExit(acp, null);
		this.#restartDelayMs = 0;
		acp.kill();
	}

	// ── inbound from gjc ─────────────────────────────────────────────────────

	#onNotification(method: string, params: any): void {
		if (method !== "session/update" || typeof params?.sessionId !== "string") return;
		const state = this.#stateFor(params.sessionId);
		this.#append(state, params.update);
	}

	async #onRequest(method: string, params: any): Promise<unknown> {
		if (method !== "session/request_permission") throw new AcpError(-32601, `Method not supported by gjc-mobile bridge: ${method}`);
		const requestId = `perm-${this.#nextPermission++}`;
		const outcome = await new Promise<PermissionOutcome>(resolve => {
			const pending: PendingPermission = {
				requestId,
				sessionId: params.sessionId,
				toolCall: params.toolCall,
				options: params.options ?? [],
				resolve,
			};
			this.#permissions.set(requestId, pending);
			this.#broadcastAll("permission.request", publicPermission(pending));
		});
		this.#permissions.delete(requestId);
		this.#broadcastAll("permission.resolved", { requestId, sessionId: params.sessionId });
		if (this.#recyclePending) setTimeout(() => this.#maybeRecycle(), 0);
		return { outcome };
	}

	#stateFor(sessionId: string, cwd?: string): SessionState {
		let state = this.#sessions.get(sessionId);
		if (!state) {
			state = {
				sessionId,
				cwd: cwd ?? this.#options.defaultCwd,
				seq: 0,
				buffer: [],
				bufferBytes: 0,
				loaded: false,
				running: false,
				hostRunning: false,
				throughput: new Throughput(),
				queued: [],
				configOptions: [],
				permissionMode: "prompt",
				hostAsks: new Set(),
			};
			this.#sessions.set(sessionId, state);
		} else if (cwd) {
			state.cwd = cwd;
		}
		return state;
	}

	#append(state: SessionState, update: Record<string, unknown>): void {
		if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
			update = { ...update, configOptions: supportedConfigOptions(update.configOptions) };
			state.configOptions = update.configOptions as unknown[];
		}
		this.#track(state, update);
		const entry = { seq: ++state.seq, update };
		state.buffer.push(entry);
		state.bufferBytes += approxBytes(update);
		while (
			state.buffer.length > this.#options.maxBufferedUpdates ||
			(state.bufferBytes > this.#options.maxBufferedBytes && state.buffer.length > 1)
		) {
			const dropped = state.buffer.shift()!;
			state.bufferBytes -= approxBytes(dropped.update);
		}
		for (const { client, sessions } of this.#clients.values()) {
			if (sessions.has(state.sessionId)) client.deliver("session.update", { sessionId: state.sessionId, ...entry });
		}
	}

	/** Feeds the list status (working/idle, tok/s) from the stream every phone sees anyway. */
	#track(state: SessionState, update: Record<string, unknown>): void {
		const kind = update.sessionUpdate;
		// History replayed by session/load arrives as the same updates; Throughput ignores them outside a live turn.
		if (typeof kind === "string" && STREAMED_TEXT_UPDATES.has(kind)) {
			const text = (update.content as { text?: unknown } | undefined)?.text;
			if (typeof text === "string") state.throughput.add(text);
			return;
		}
		if (kind === "tool_call" || kind === "tool_call_update") {
			const id = update.toolCallId;
			if (typeof id !== "string") return;
			if (update.status === "completed" || update.status === "failed") state.throughput.toolEnded(id);
			else if (kind === "tool_call") state.throughput.toolStarted(id);
			return;
		}
		if (kind === "session_info_update") {
			const running = (update._meta as { running?: unknown } | undefined)?.running;
			if (typeof running === "boolean") state.hostRunning = running;
		}
		if (kind === TURN_END || kind === AGENT_EXIT) state.hostRunning = false;
		const active = isActive(state);
		if (active === state.throughput.active) return;
		if (active) {
			state.throughput.start();
			void this.#sampleUsage(state); // baseline before the turn's first message completes
			this.#ensureStatusTimer();
			this.#publishStatus(state);
		} else {
			this.#sampleHostAsks(state, true);
			state.throughput.finish();
			// gjc drains or drops its queue when the turn ends; a follow-up it starts sets the session working again.
			state.queued = [];
			// The last message's tokens land in gjc's usage at turn end; take them before reporting the idle rate.
			void this.#sampleUsage(state).finally(() => this.#publishStatus(state));
		}
	}

	#publishStatus(state: SessionState): void {
		this.#broadcastAll("session.status", sessionStatus(state));
	}

	/**
	 * Reads gjc's cumulative output tokens (`session.stats`) into the session's meter. One request in flight per
	 * session; failures (session not open in this ACP process, older gjc) leave the text estimate in charge.
	 */
	#sampleUsage(state: SessionState): Promise<void> {
		if (!state.loaded) return Promise.resolve();
		state.usageSample ??= this.sdk({ sessionId: state.sessionId, kind: "query", op: "session.stats", internal: true })
			.then(stats => {
				const output = outputTokens(stats);
				if (output !== undefined) state.throughput.usage(output);
			})
			.catch(() => {})
			.finally(() => {
				state.usageSample = undefined;
			});
		return state.usageSample;
	}

	/**
	 * Reads gjc's queue (`queue.messages.list`) into [state.queued]. gjc announces no queue change over ACP, and a
	 * steer typed in the TUI is only visible here (measured 2026-10-26: listed as `steer:1` within 0.1s of Enter).
	 * One request in flight per session; a failed read keeps the last list.
	 */
	#sampleQueue(state: SessionState): Promise<void> {
		if (!state.loaded) return Promise.resolve();
		state.queueSample ??= this.sdk({ sessionId: state.sessionId, kind: "query", op: "queue.messages.list", internal: true })
			.then(result => {
				if (isActive(state)) state.queued = queuedMessages(result);
			})
			.catch(() => {})
			.finally(() => {
				state.queueSample = undefined;
			});
		return state.queueSample;
	}

	/**
	 * Shows the phone the asks a turn typed in the TUI waits on, which gjc never sends over ACP (see host-asks.ts):
	 * a pending `ask` in the transcript becomes a `tool_call` with the id gjc's own replay uses, and its
	 * `toolResult` (the option picked in the terminal) settles it. Turns this bridge started stream their asks
	 * over ACP and are skipped. `final` runs once the turn goes idle and fails asks left without an answer.
	 */
	#sampleHostAsks(state: SessionState, final = false): void {
		if (!state.loaded) return;
		if (final ? state.hostAsks.size === 0 : state.running || !state.hostRunning) return;
		const file = state.hostAskScan?.file ?? this.#saved.transcript(state.sessionId);
		if (!file) return;
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			state.hostAskScan = undefined;
			return;
		}
		const last = state.hostAskScan;
		const changed = !last || last.file !== file || last.size !== stat.size || last.mtimeMs !== stat.mtimeMs;
		state.hostAskScan = { file, size: stat.size, mtimeMs: stat.mtimeMs };
		if (!changed && !final) return;
		const scan = scanTranscriptAsks(file);
		if (!scan) return;
		if (!final) {
			for (const ask of scan.pending) {
				if (state.hostAsks.has(ask.toolCallId)) continue;
				state.hostAsks.add(ask.toolCallId);
				this.#append(state, hostAskToolCall(ask));
			}
		}
		for (const id of state.hostAsks) {
			const result = scan.results.get(id);
			if (!result && !final) continue;
			state.hostAsks.delete(id);
			this.#append(state, hostAskSettled(id, result));
		}
	}

	/** One tick per second while any session is working, so list rows show a live rate and chats gjc's queue. */
	#ensureStatusTimer(): void {
		if (this.#statusTimer) return;
		this.#statusTimer = setInterval(() => {
			const active = [...this.#sessions.values()].filter(isActive);
			for (const state of active) {
				this.#sampleHostAsks(state);
				void Promise.all([this.#sampleUsage(state), this.#sampleQueue(state)]).finally(() => this.#publishStatus(state));
			}
			if (active.length === 0) {
				clearInterval(this.#statusTimer);
				this.#statusTimer = undefined;
			}
		}, 1000);
	}

	#broadcastAll(event: string, payload: unknown): void {
		for (const { client } of this.#clients.values()) client.deliver(event, payload);
	}

	// ── phone-facing operations ──────────────────────────────────────────────

	async hostInfo() {
		await this.agent();
		return {
			hostName: process.env.GJCM_HOST_NAME || os.hostname(),
			agentInfo: this.#agentInfo,
			defaultCwd: this.#options.defaultCwd,
			bridgeVersion: this.#options.version,
		};
	}

	listSessions(params: { cwd?: string; cursor?: string; query?: string }) {
		const page = this.#saved.list(params);
		const listed = new Set(page.sessions.map(s => s.sessionId));
		// Sessions this bridge created but that have not written a transcript yet (no prompt sent).
		const needle = params.query?.trim().toLowerCase();
		const candidates = params.cursor
			? []
			: [...this.#sessions.values()].filter(
					s =>
						s.loaded &&
						!listed.has(s.sessionId) &&
						(!params.cwd || s.cwd === params.cwd) &&
						(!needle || `${s.cwd}\n${s.sessionId}`.toLowerCase().includes(needle)),
				);
		const saved = candidates.length > 0 ? this.#saved.ids() : new Set<string>();
		const fresh = candidates
			.filter(s => !saved.has(s.sessionId))
			.map(s => ({ sessionId: s.sessionId, cwd: s.cwd, updatedAt: new Date().toISOString() }));
		const sessions = [...fresh, ...page.sessions].map(s => {
			const state = this.#sessions.get(s.sessionId);
			return state ? { ...s, ...sessionStatus(state) } : { ...s, running: false };
		});
		return { sessions, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
	}

	async newSession(clientId: string, params: { cwd?: string }): Promise<OpenSnapshot> {
		const acp = await this.agent();
		const cwd = params.cwd || this.#options.defaultCwd;
		// gjc answers a missing cwd with "Lifecycle worktree does not exist" after spawning a session host.
		if (!isDirectory(cwd)) throw new AcpError(-32602, `호스트에 작업 디렉터리가 없습니다: ${cwd}`);
		const result = await acp.request("session/new", { cwd, mcpServers: [] });
		const state = this.#stateFor(result.sessionId, cwd);
		state.loaded = true;
		state.configOptions = supportedConfigOptions(result.configOptions ?? state.configOptions);
		return this.#subscribe(clientId, state, 0);
	}

	async openSession(clientId: string, params: { sessionId: string; cwd?: string; afterSeq?: number }): Promise<OpenSnapshot> {
		const acp = await this.agent();
		const state = this.#stateFor(params.sessionId, params.cwd ?? this.#saved.find(params.sessionId)?.cwd);
		if (!state.loaded) {
			state.loading ??= (async () => {
				// A reload replays the full history again; start the replay buffer from scratch.
				state.buffer = [];
				state.bufferBytes = 0;
				// The replay carries a waiting ask as failed ("ends without a result"); show it again as pending.
				state.hostAsks.clear();
				state.hostAskScan = undefined;
				const result = await acp.request("session/load", {
					sessionId: state.sessionId,
					cwd: state.cwd,
					mcpServers: [],
				});
				state.configOptions = supportedConfigOptions(result?.configOptions ?? state.configOptions);
				if (state.permissionMode !== "prompt") await this.#applyPermissionMode(acp, state.sessionId, state.permissionMode);
				state.loaded = true;
			})()
				.catch(error => {
					this.#recycleOnBrokerLoss(acp, error);
					throw error;
				})
				.finally(() => {
				state.loading = undefined;
			});
			await state.loading;
			return this.#subscribe(clientId, state, 0, true);
		}
		return this.#subscribe(clientId, state, params.afterSeq ?? 0);
	}

	/** Copies a saved session into a new one and opens it (gjc replays the copied history on load). */
	async forkSession(clientId: string, params: { sessionId: string; cwd?: string }): Promise<OpenSnapshot> {
		const acp = await this.agent();
		const cwd = params.cwd ?? this.#sessions.get(params.sessionId)?.cwd ?? this.#saved.find(params.sessionId)?.cwd;
		if (!cwd) throw new AcpError(-32002, `Unknown session ${params.sessionId}`);
		const forked = await acp.request("session/fork", { sessionId: params.sessionId, cwd, mcpServers: [] });
		return this.openSession(clientId, { sessionId: forked.sessionId, cwd });
	}

	/** Deletes a session's transcript and artifacts through gjc. */
	async deleteSession(params: { sessionId: string }): Promise<{ ok: true }> {
		const state = this.#sessions.get(params.sessionId);
		if (state?.running) throw new AcpError(-32003, "Stop the running turn before deleting the session");
		const acp = await this.agent();
		if (!state?.loaded) {
			// gjc resolves delete authority from sessions it knows; a saved-only session is loaded first.
			const cwd = state?.cwd ?? this.#saved.find(params.sessionId)?.cwd;
			if (!cwd) throw new AcpError(-32002, `Unknown session ${params.sessionId}`);
			await acp.request("session/load", { sessionId: params.sessionId, cwd, mcpServers: [] });
		}
		await acp.request("session/delete", { sessionId: params.sessionId });
		this.#sessions.delete(params.sessionId);
		for (const { sessions } of this.#clients.values()) sessions.delete(params.sessionId);
		return { ok: true };
	}

	closeSession(clientId: string, sessionId: string): void {
		this.#clients.get(clientId)?.sessions.delete(sessionId);
	}

	#subscribe(clientId: string, state: SessionState, afterSeq: number, forceReset = false): OpenSnapshot {
		this.#clients.get(clientId)?.sessions.add(state.sessionId);
		const firstSeq = state.buffer[0]?.seq ?? state.seq + 1;
		const reset = forceReset || afterSeq === 0 || afterSeq < firstSeq - 1 || afterSeq > state.seq;
		return {
			sessionId: state.sessionId,
			cwd: state.cwd,
			configOptions: state.configOptions,
			running: state.running,
			seq: state.seq,
			reset,
			updates: reset ? state.buffer.slice() : state.buffer.filter(u => u.seq > afterSeq),
			permissions: [...this.#permissions.values()].filter(p => p.sessionId === state.sessionId).map(publicPermission),
			permissionMode: state.permissionMode,
		};
	}

	/**
	 * The phone's permission-mode switch. Applies the mode through gjc's `permission_mode.set`, remembers it
	 * for reloads, tells every phone through a buffered update, and settles prompts already waiting in this
	 * session the way the new mode would have (`allow` → allow once, `deny` → reject once).
	 */
	async setPermissionMode(params: { sessionId: string; mode: string }): Promise<{ mode: PermissionMode }> {
		const mode = PERMISSION_MODES.find(m => m === params.mode);
		if (!mode) throw new AcpError(-32602, `permission mode must be one of ${PERMISSION_MODES.join(", ")}`);
		const state = this.#sessions.get(params.sessionId);
		if (!state?.loaded) throw new AcpError(-32002, "Session is not open; call session.open first");
		await this.#applyPermissionMode(await this.agent(), state.sessionId, mode, state);
		state.permissionMode = mode;
		this.#append(state, { sessionUpdate: PERMISSION_MODE_UPDATE, mode });
		if (mode !== "prompt") {
			const kind = mode === "allow" ? "allow_once" : "reject_once";
			for (const pending of this.#permissions.values()) {
				if (pending.sessionId !== state.sessionId) continue;
				const option = pending.options.find(o => o.kind === kind);
				if (option) pending.resolve({ outcome: "selected", optionId: option.optionId });
			}
		}
		return { mode };
	}

	async #applyPermissionMode(acp: AcpProcess, sessionId: string, mode: PermissionMode, state?: SessionState): Promise<void> {
		const response = await acp.request("_gjc/sdk/control", { sessionId, operation: "permission_mode.set", input: { mode } });
		if (response?.ok !== false) return;
		const message = String(response.error?.message ?? "permission_mode.set failed");
		if (state && message.includes(STALE_ATTACHMENT)) {
			state.loaded = false;
			throw new AcpError(-32002, "Session is not open; call session.open first", { code: "session_reload_required" });
		}
		throw new AcpError(-32020, message, { code: response.error?.code ?? "internal" });
	}

	async prompt(params: { sessionId: string; prompt: unknown[] }): Promise<{ accepted: true }> {
		const acp = await this.agent();
		const state = this.#sessions.get(params.sessionId);
		if (!state?.loaded) throw new AcpError(-32002, "Session is not open; call session.open first");
		if (state.running) throw new AcpError(-32003, "A turn is already running in this session");
		if (!Array.isArray(params.prompt) || params.prompt.length === 0) throw new AcpError(-32602, "prompt must be a non-empty block array");
		state.running = true;
		this.#track(state, { sessionUpdate: "x_gjcm_turn_start" });
		state.turn = acp.request("session/prompt", { sessionId: params.sessionId, prompt: params.prompt }).then(
			result => {
				state.running = false;
				this.#append(state, { sessionUpdate: TURN_END, stopReason: result?.stopReason ?? "end_turn" });
				this.#maybeRecycle();
			},
			error => {
				state.running = false;
				if (String(error?.message ?? error).includes(STALE_ATTACHMENT)) state.loaded = false;
				this.#append(state, { sessionUpdate: TURN_END, stopReason: "error", error: String(error?.message ?? error) });
				this.#maybeRecycle();
			},
		);
		return { accepted: true };
	}

	async cancel(params: { sessionId: string }): Promise<{ ok: true }> {
		for (const permission of this.#permissions.values()) {
			if (permission.sessionId === params.sessionId) permission.resolve({ outcome: "cancelled" });
		}
		(await this.agent()).notify("session/cancel", { sessionId: params.sessionId });
		return { ok: true };
	}

	/**
	 * The phone's "끼어들기" for steers still waiting on a busy turn (the TUI's Esc with a queued steer): stop
	 * the turn now and start a new one with the waiting steers. gjc's own queue (`queue.messages.list`) is the
	 * source of truth — a steer the model already took is gone from it, so nothing is sent twice.
	 *
	 * Measured on gjc dev 2026-10-23 with a steer queued mid-stream: `session/cancel` settles the turn as
	 * `cancelled` in ~0.1s and drops the steer from the queue, and a fresh `session/prompt` answers it once.
	 * The SDK routes are worse: `turn.abort` (gjc's steer-on-interrupt) answers `uncertain_after_send` and
	 * leaves the ACP prompt pending ~80s, and `turn.abort_and_prompt` fails the old prompt as an error and its
	 * replacement turn produced no output within 28s.
	 *
	 * A turn can reach its own step boundary before the cancel lands; gjc then hands the steer to the model and
	 * the steer leaves the queue the same way a dropped one does (measured 2026-10-26 with a TUI turn: the bridge
	 * re-sent it and the model answered it twice). A steer whose text shows up as a user message after the cancel
	 * was delivered and is not sent again.
	 *
	 * A turn this bridge did not start (typed in the TUI) cannot be stopped from here: gjc lets a client abort only
	 * the run it owns. Measured 2026-10-26 on a TUI turn: `session/cancel` had no effect (10s, then -32004),
	 * `turn.abort` answered `no_active_turn`, `turn.abort{mode:"terminal"}` `terminal_no_effect`, and the operator
	 * variant is reserved to gjc's Broker route. Such a turn is refused at once instead.
	 */
	async interrupt(params: { sessionId: string }): Promise<{ accepted: true; text: string }> {
		const state = this.#sessions.get(params.sessionId);
		if (!state?.loaded) throw new AcpError(-32002, "Session is not open; call session.open first");
		const steers = await this.#queuedSteers(params.sessionId);
		if (steers.length === 0) throw noPendingSteer();
		if (!state.running && state.hostRunning)
			throw new AcpError(-32004, "터미널에서 시작한 턴은 앱에서 멈출 수 없습니다. 지시는 대기열에 있고 턴의 다음 단계에서 전달됩니다.", {
				code: "host_turn",
			});
		const mark = state.seq;
		if (isActive(state)) {
			await this.cancel({ sessionId: params.sessionId });
			if (!(await this.#settled(state, INTERRUPT_SETTLE_TIMEOUT_MS)))
				throw new AcpError(-32004, "진행 중인 턴이 중단되지 않았습니다. 잠시 후 다시 시도하세요.");
		}
		// If gjc kept a steer through the cancel it would replay into the new turn as well; take it out.
		for (const left of await this.#queuedSteers(params.sessionId)) {
			if (steers.some(s => s.id === left.id))
				await this.sdk({ sessionId: params.sessionId, kind: "control", op: "queue.message.remove", input: { id: left.id } });
		}
		const delivered = state.buffer
			.filter(entry => entry.seq > mark && entry.update.sessionUpdate === "user_message_chunk")
			.map(entry => (entry.update.content as { text?: unknown } | undefined)?.text)
			.filter((text): text is string => typeof text === "string")
			.join("\n");
		const waiting = steers.filter(s => !delivered.includes(s.text));
		if (waiting.length === 0) throw noPendingSteer();
		const text = waiting.map(s => s.text).join("\n\n");
		await this.prompt({ sessionId: params.sessionId, prompt: [{ type: "text", text }] });
		return { accepted: true, text };
	}

	async #queuedSteers(sessionId: string): Promise<{ id: string; text: string }[]> {
		const result = await this.sdk({ sessionId, kind: "query", op: "queue.messages.list" });
		return queuedMessages(result).filter(m => m.mode === "steer" && m.text);
	}

	/** Waits for the bridge's own turn to resolve and gjc's phase to go idle (turns started on the host). */
	async #settled(state: SessionState, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		if (state.running && state.turn) {
			const done = await Promise.race([state.turn.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
			if (!done) return false;
		}
		while (isActive(state)) {
			if (Date.now() > deadline) return false;
			await Bun.sleep(50);
		}
		return true;
	}

	async setConfig(params: { sessionId: string; configId: string; value: string | boolean }) {
		const state = this.#sessions.get(params.sessionId);
		// A restarted ACP process (gjc build switch, crash) knows no session until session/load and answers
		// "Unknown session" (-32603); -32002 makes the phone reopen the session and retry.
		if (!state?.loaded) throw new AcpError(-32002, "Session is not open; call session.open first");
		if (params.configId === "thinking" && typeof params.value === "string") return this.#setThinking(state, params.value);
		const acp = await this.agent();
		const body =
			typeof params.value === "boolean"
				? { sessionId: params.sessionId, configId: params.configId, type: "boolean", value: params.value }
				: { sessionId: params.sessionId, configId: params.configId, value: params.value };
		const result = await acp.request("session/set_config_option", body);
		const configOptions = Array.isArray(result?.configOptions) ? supportedConfigOptions(result.configOptions) : undefined;
		if (configOptions) state.configOptions = configOptions;
		return { configOptions: configOptions ?? state.configOptions };
	}

	/**
	 * gjc's `session/set_config_option` for `thinking` rebuilds the whole model catalog three times
	 * (`#sessionState` before, after and for the reply; ~1.3s each with ~1080 models), so an effort change
	 * took ~4.1s measured. The SDK `thinking.set` it wraps answers in ~20ms; the bridge applies the level
	 * there and reports the new value itself, the same way gjc's `config_option_update` would.
	 */
	async #setThinking(state: SessionState, level: string): Promise<{ configOptions: unknown[] }> {
		const option = state.configOptions.find(o => (o as { id?: unknown }).id === "thinking") as
			| { options?: { value?: unknown }[] }
			| undefined;
		if (!option?.options?.some(o => o.value === level)) throw new AcpError(-32602, `Unsupported thinking level: ${level}`);
		await this.sdk({ sessionId: state.sessionId, kind: "control", op: "thinking.set", input: { level } });
		const configOptions = state.configOptions.map(o =>
			(o as { id?: unknown }).id === "thinking" ? { ...(o as object), currentValue: level } : o,
		);
		this.#append(state, { sessionUpdate: "config_option_update", configOptions });
		return { configOptions: state.configOptions };
	}

	/**
	 * Per-role model assignments, as gjc's `/model` writes them: `modelRoles.<role>` for the main agent and
	 * image generation, `task.agentModelOverrides.<role>` for subagents. Values are gjc model selectors
	 * (`provider/model[:thinking]`). Read from the agent's global config.yml; ACP has no config query
	 * ("config.get is not installed for this session", measured on dev 2026-10-23).
	 */
	modelRoles(): { roles: ModelRoleAssignment[]; profile?: string } {
		const config = readAgentConfig(this.#options.agentDir);
		const profile = activeModelProfile(config);
		return {
			roles: MODEL_ROLE_TARGETS.map(target => {
				const value = target.settingsPath === "modelRoles" ? config.modelRoles?.[target.id] : config.task?.agentModelOverrides?.[target.id];
				return { id: target.id, name: target.name, ...(typeof value === "string" && value ? { value } : {}) };
			}),
			...(profile ? { profile } : {}),
		};
	}

	/**
	 * Assigns a role through gjc's own `config.patch` (persisted to config.yml and applied to the running
	 * gjc). Like `/model`, new sessions and subagents pick it up; the open session's model stays as set by
	 * `session.setConfig`. `value: null` removes the assignment so the role falls back to gjc's default.
	 *
	 * gjc runs `config.patch` through `withSdkControlMutation`, which first waits for the carrying session's turn
	 * to end; on a busy session the SDK request timed out after ~40s as `uncertain_after_send` (measured
	 * 2026-10-26: idle 78ms, busy session blocked until its turn ended). The settings are process-global and
	 * synced through config.yml, so the patch rides on an idle open session instead.
	 */
	async setModelRole(params: { sessionId: string; role: string; value: string | null }) {
		const target = MODEL_ROLE_TARGETS.find(t => t.id === params.role);
		if (!target) throw new AcpError(-32602, `unknown model role ${params.role}`);
		if (params.value !== null && (typeof params.value !== "string" || !MODEL_SELECTOR.test(params.value)))
			throw new AcpError(-32602, `invalid model selector ${String(params.value)}`);
		const config = readAgentConfig(this.#options.agentDir);
		const profile = activeModelProfile(config);
		// With a model profile active gjc's `/model` writes into the profile, which config.patch cannot reach;
		// a global write would be shadowed by the profile's bindings and silently do nothing.
		if (profile) throw new AcpError(-32020, `모델 프로필 '${profile}'이 켜져 있어 역할 모델은 호스트의 /model에서 바꿔야 합니다.`, { code: "profile_active" });
		const current: Record<string, unknown> = {
			...(target.settingsPath === "modelRoles" ? config.modelRoles : config.task?.agentModelOverrides),
		};
		if (params.value === null) delete current[target.id];
		else current[target.id] = params.value;
		const carrier = this.#idleCarrier(params.sessionId);
		await this.sdk({ sessionId: carrier, kind: "control", op: "config.patch", input: { patch: { [target.settingsPath]: current } }, internal: true });
		// gjc answers config.patch before its debounced save reaches config.yml (measured: the next read
		// still had the old value). Wait for the write so the answer, and the merge base of the next
		// setModelRole, include this change instead of clobbering it.
		const deadline = Date.now() + CONFIG_FLUSH_TIMEOUT_MS;
		for (;;) {
			const roles = this.modelRoles();
			if ((roles.roles.find(r => r.id === target.id)?.value ?? null) === params.value) return roles;
			if (Date.now() > deadline)
				throw new AcpError(-32020, "gjc가 설정을 받았지만 config.yml에 아직 저장하지 않았습니다. 잠시 후 다시 확인하세요.", { code: "config_not_flushed" });
			await Bun.sleep(100);
		}
	}

	/** The requested session if it is idle, otherwise another open idle session; fails fast when every one is busy. */
	#idleCarrier(sessionId: string): string {
		const own = this.#sessions.get(sessionId);
		if (!own?.loaded) throw new AcpError(-32002, "Session is not open; call session.open first");
		if (!isActive(own)) return sessionId;
		for (const state of this.#sessions.values()) {
			if (state.loaded && !isActive(state)) return state.sessionId;
		}
		throw new AcpError(-32020, "gjc가 작업 중이라 지금은 역할 모델을 바꿀 수 없습니다. 턴이 끝난 뒤 다시 시도하세요.", {
			code: "session_busy",
		});
	}

	/**
	 * gjc's builtin slash commands (/context, /compact, /model, ...) are not intercepted over ACP — the
	 * agent forwards them to the model as plain text (measured on gjc 0.18.7). The same features are
	 * reachable as `_gjc/sdk/query` and `_gjc/sdk/control` operations whose ACP disposition is
	 * generic_safe, so the phone drives them natively through this allowlisted passthrough.
	 */
	async sdk(params: {
		sessionId: string;
		kind: "query" | "control";
		op: string;
		input?: Record<string, unknown>;
		confirm?: boolean;
		/** Bridge-composed call (setModelRole); never set from a phone request. */
		internal?: boolean;
	}) {
		const allowed = params.kind === "query" ? SDK_QUERIES : params.kind === "control" ? SDK_CONTROLS : undefined;
		if (!params.internal && !allowed?.has(params.op)) throw new AcpError(-32601, `sdk ${params.kind} ${params.op} is not exposed to the phone`);
		const state = this.#sessions.get(params.sessionId);
		if (!state?.loaded) throw new AcpError(-32002, "Session is not open; call session.open first");
		const acp = await this.agent();
		const input = params.input ?? {};
		const response =
			params.kind === "query"
				? await acp.request("_gjc/sdk/query", { sessionId: params.sessionId, query: params.op, input })
				: await acp.request("_gjc/sdk/control", {
						sessionId: params.sessionId,
						operation: params.op,
						input,
						...(params.confirm ? { confirm: true } : {}),
					});
		if (response?.ok === false) {
			const error = response.error ?? {};
			const message = String(error.message ?? "sdk operation failed");
			if (message.includes(STALE_ATTACHMENT)) {
				// gjc re-attached the session elsewhere (its session host restarted or a terminal took it over);
				// this ACP process's attachment is dead until session/load. Make the phone reopen it.
				state.loaded = false;
				throw new AcpError(-32002, "Session is not open; call session.open first", { code: "session_reload_required" });
			}
			if (error.code === "unknown_operation") {
				// The operation is in the bridge allowlist but the gjc hosting this session lacks it: either the gjc build
				// never had it (turn.btw is not in any official gjc release) or the session host started before it was added.
				// A restart only helps in the second case, so the message does not promise it.
				throw new AcpError(
					-32020,
					`이 세션의 gjc가 ${params.op}을(를) 지원하지 않습니다. 공식 gjc 릴리스에 없는 기능이거나, 그 기능이 들어가기 전에 시작된 세션입니다.`,
					{ code: "host_outdated" },
				);
			}
			throw new AcpError(-32020, message, { code: error.code ?? "internal" });
		}
		if (params.kind === "query") {
			const items: unknown[] = response?.page?.items ?? [];
			return { items: params.op === "context.get" ? items.map(withoutSystemPrompt) : items, complete: response?.page?.complete !== false };
		}
		// Measured shapes: most operations answer with the bare result ({renamed:true}, {path}, …);
		// some (mode.goal.operate) answer with the control envelope instead.
		if (response?.type === "control_response") return { result: response.result ?? null };
		return { result: response ?? null };
	}

	respondPermission(params: { requestId: string; optionId?: string | null }): { ok: boolean } {
		const pending = this.#permissions.get(params.requestId);
		if (!pending) return { ok: false };
		if (params.optionId && !pending.options.some(o => o.optionId === params.optionId)) {
			throw new AcpError(-32602, `Unknown permission option ${params.optionId}`);
		}
		pending.resolve(params.optionId ? { outcome: "selected", optionId: params.optionId } : { outcome: "cancelled" });
		return { ok: true };
	}

	pendingPermissions() {
		return [...this.#permissions.values()].map(publicPermission);
	}
}

export interface ModelRoleAssignment {
	id: string;
	name: string;
	value?: string;
}

/** gjc's GJC_MODEL_ASSIGNMENT_TARGETS (config/model-registry.ts) minus `image`, which takes image models. */
export const MODEL_ROLE_TARGETS = [
	{ id: "default", name: "기본", settingsPath: "modelRoles" },
	{ id: "executor", name: "Executor", settingsPath: "task.agentModelOverrides" },
	{ id: "architect", name: "Architect", settingsPath: "task.agentModelOverrides" },
	{ id: "planner", name: "Planner", settingsPath: "task.agentModelOverrides" },
	{ id: "critic", name: "Critic", settingsPath: "task.agentModelOverrides" },
] as const;
const CONFIG_FLUSH_TIMEOUT_MS = 5000;
const INTERRUPT_SETTLE_TIMEOUT_MS = 10_000;
const MODEL_SELECTOR = /^[\w.@-]+(\/[\w.@:+-]+)+$/;

interface AgentConfig {
	modelRoles?: Record<string, unknown>;
	task?: { agentModelOverrides?: Record<string, unknown> };
	modelProfile?: { default?: unknown };
}

function readAgentConfig(agentDir: string): AgentConfig {
	let text: string;
	try {
		text = fs.readFileSync(path.join(agentDir, "config.yml"), "utf8");
	} catch {
		return {};
	}
	const parsed = Bun.YAML.parse(text);
	return parsed && typeof parsed === "object" ? (parsed as AgentConfig) : {};
}

function activeModelProfile(config: AgentConfig): string | undefined {
	const name = config.modelProfile?.default;
	return typeof name === "string" && name ? name : undefined;
}

function publicPermission(p: PendingPermission): Omit<PendingPermission, "resolve"> {
	return { requestId: p.requestId, sessionId: p.sessionId, toolCall: p.toolCall, options: p.options };
}

/** context.get carries the whole system prompt (~40KB measured); the phone only needs its size. */
function withoutSystemPrompt(item: unknown): unknown {
	if (!item || typeof item !== "object" || !("systemPrompt" in item)) return item;
	const { systemPrompt, ...rest } = item as Record<string, unknown>;
	const chars = Array.isArray(systemPrompt) ? systemPrompt.reduce((n: number, s) => n + String(s).length, 0) : String(systemPrompt ?? "").length;
	return { ...rest, systemPromptChars: chars };
}

/**
 * gjc 0.18 advertises a "plan" choice in the ACP `mode` option but rejects selecting it ("ACP plan mode is
 * not available because this ACP session has no host plan-mode lifecycle"). Drop the choice, and the whole
 * option once only one choice is left, so the phone never offers a selection that always fails.
 */
export function supportedConfigOptions(options: unknown[]): unknown[] {
	return options.flatMap(option => {
		const o = option as { id?: unknown; options?: unknown };
		if (o?.id !== "mode" || !Array.isArray(o.options)) return [option];
		const choices = o.options.filter(choice => (choice as { value?: unknown })?.value !== "plan");
		return choices.length > 1 ? [{ ...o, options: choices }] : [];
	});
}

function noPendingSteer(): AcpError {
	return new AcpError(-32005, "대기 중인 끼어들기 메시지가 없습니다. 이미 전달됐습니다.", { code: "no_pending_steer" });
}

function isActive(state: SessionState): boolean {
	return state.running || state.hostRunning;
}

/** Sums `output` over the `session.stats` items (measured shape: `{items:[{input, output, cacheRead, ...}]}`). */
export function outputTokens(stats: unknown): number | undefined {
	const items = (stats as { items?: unknown } | undefined)?.items;
	if (!Array.isArray(items)) return undefined;
	let total: number | undefined;
	for (const item of items) {
		const output = (item as { output?: unknown } | null)?.output;
		if (typeof output === "number" && Number.isFinite(output)) total = (total ?? 0) + output;
	}
	return total;
}

function sessionStatus(state: SessionState): SessionStatus {
	const tokensPerSecond = state.throughput.rate();
	return {
		sessionId: state.sessionId,
		running: isActive(state),
		...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
		queued: state.queued,
	};
}

/** `queue.messages.list` items (measured shape: `{items:[{id, text, mode: "steer"|"followUp", label}]}`). */
function queuedMessages(result: unknown): QueuedMessage[] {
	const items = (result as { items?: unknown } | undefined)?.items;
	if (!Array.isArray(items)) return [];
	return items.flatMap(item => {
		const m = item as { id?: unknown; text?: unknown; mode?: unknown };
		return typeof m.id === "string" && typeof m.text === "string" && (m.mode === "steer" || m.mode === "followUp")
			? [{ id: m.id, text: m.text, mode: m.mode }]
			: [];
	});
}

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function approxBytes(value: unknown): number {
	return JSON.stringify(value).length;
}

function stripUndefined<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== "")) as T;
}
