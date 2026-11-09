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
import {
	hostAskSettled,
	hostAskToolCall,
	type RemoteAskCard,
	remoteAskCard,
	remoteAskRequests,
	scanTranscriptAsks,
	terminalAsk,
} from "./host-asks";
import { SavedSessionIndex } from "./saved-sessions";
import { Throughput } from "./throughput";
import { SdkCli } from "./sdk-cli";
import { TmuxError, TmuxLauncher, type TmuxOptions, tuiCommand } from "./tmux";

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
	// Ephemeral /btw side question: { question, exchanges? } -> { replyText }. The hub routes it to official btw.ask or to
	// turn.btw (local patch 0004) by the session host's runtime.capabilities; see #sideQuestion.
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
/**
 * How gjc fails a prompt stopped before it ran (0.19.3 and 0.20.0, a session a terminal hosts): `session/prompt` fails with
 * this instead of settling as cancelled, and the prompt never reaches the transcript (measured 2026-11-08, stop 0ms
 * after a photo prompt; 800ms later it settled as cancelled and was kept).
 */
const PREFLIGHT_CANCELLED = "Prompt preflight was cancelled before execution";

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
	resolve(outcome: PermissionOutcome): void | Promise<void>;
	/** A TUI ask answered through `ask.answer` (see `SessionHub.#syncRemoteAsks`), not a guarded tool: no mode answers it. */
	hostAsk?: boolean;
	/** Shown from a tmux session's approval channel rather than asked over ACP (see `SessionHub.#enableChannel`). */
	fromChannel?: boolean;
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
	/** That turn's id, given to the phone that sent it (`session.prompt` reply) and repeated on its turn end. */
	turnId?: string;
	/**
	 * Whether that prompt went in while a turn started elsewhere (the TUI) was running. gjc then queues it as a
	 * steer of that turn instead of starting a turn the bridge owns. Held until the prompt settles: gjc 0.19.3
	 * reports no `running: false` while an ACP prompt waits (acp-agent phase owner), so the bridge cannot see
	 * when a TUI turn that ended without taking it promotes it to a run of its own; 끼어들기 is refused there too.
	 */
	turnBehindHost?: boolean;
	/** The text of that prompt when it carries attachments: still listed by gjc's queue means it waits there. */
	turnAttachmentText?: string;
	/** That prompt's own message while it waits in gjc's queue (see `#holdEcho`). */
	echoHold?: EchoHold;
	/** The last `gjcPhase` gjc reported for the session (`session_info_update`). */
	hostPhase?: string;
	/** Watch for a turn gjc ACP never ends (`#watchStuckTurn`): when the host was last asked, the `seq` it answered idle at. */
	stuckCheck?: { at: number; idleSeq?: number; asking?: boolean };
	/** In-flight `#releaseTurn`. */
	releasing?: Promise<void>;
	/**
	 * Set by `interrupt()` from its cancel until its replacement prompt has started. Another prompt in that window
	 * (a phone sending a held photo message as the cancelled turn ends) would take the turn the waiting steers are
	 * meant for, and the replacement would fail -32003 after gjc's queue had already been emptied of them.
	 */
	interrupting?: boolean;
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
	/** Cards for those asks by gjc's `ask.requests.list` id (see `#syncRemoteAsks`). */
	remoteAsks: Map<string, PendingPermission>;
	/** Ids answered or dismissed on a phone: never shown again, though a listing taken before may still carry them. */
	remoteAsksDone: Set<string>;
	/** Questions (`questionId`) dismissed on a phone: left to the terminal, also once a terminal toggle gives them a new id. */
	remoteAsksDismissed: Set<string>;
	/** `ask.answer` calls in flight; a pending recycle waits for them. */
	remoteAskAnswers: number;
	/** The last `ask.requests.list` failure logged, so a lasting one is logged once. */
	remoteAskError?: string;
	/** In-flight `ask.requests.list` read; `again` when another was asked for meanwhile. */
	remoteAskSync?: { again: boolean };
	/** The session host has no `ask.requests.list` (gjc 0.19.3 and older): asks stay answerable in the terminal only. */
	remoteAsksUnsupported?: boolean;
	/** Opened by this bridge in a tmux window, so gjc in the terminal hosts it (asks show only there). */
	inTmux?: boolean;
	/** That window's permission approval channel, which brings its tool approvals to the phones (see `#readChannel`). */
	channel?: ApprovalChannel;
	/** While `session/load` replays the history: no channel reads for replayed tool calls. */
	replaying?: boolean;
	/** `seq` once the last load's replay ended: a phone that last saw less gets a full snapshot, never the replay as news. */
	historySeq: number;
	/** The permission mode last announced to the phones (`shownPermissionMode`). */
	shownMode?: PermissionMode;
	/** A reload the bridge started on its own (`#reattach`): its replay is kept from phones already showing the chat. */
	quietReplay?: boolean;
	/**
	 * Phones (`HubClient.device`) that showed the chat during a quiet replay: they lack what the terminal did while gjc ACP
	 * was gone, and their later live updates hide that from `afterSeq`, so their next open gets a full snapshot.
	 */
	resync: Set<string>;
}

export interface SessionStatus {
	sessionId: string;
	running: boolean;
	/** Output tokens/s of model time (gjc usage plus a text estimate): this turn while running, the last turn when idle. */
	tokensPerSecond?: number;
	/** gjc's waiting steers and follow-ups, read once a second while the session works; empty when idle. */
	queued: QueuedMessage[];
}

/** A tmux session's permission approval channel as the bridge follows it (see `SessionHub.#enableChannel`). */
interface ApprovalChannel {
	/** Requests shown to the phones, by gjc's request id. */
	requests: Map<string, { requestId: string; toolCallId: string }>;
	/** Tool calls that arrived pending and are not listed in the channel yet. */
	waitingTools: Set<string>;
	/** Requests answered or taken down, never shown again. */
	settled: Set<string>;
	reading?: Promise<void>;
	/** Another read was asked for while one ran. */
	again?: boolean;
}

/** `permission.requests.list` item (gjc external-permissions.ts). */
interface ChannelRequest {
	id: string;
	toolCallId: string;
	toolCall: unknown;
	options: PendingPermission["options"];
}

/**
 * The permission mode a phone is shown. A session gjc hosts in a tmux window runs guarded tools unasked unless its
 * approval channel is on (measured on gjc 0.19.3), so `prompt` without the channel is shown as what happens: `allow`.
 */
function shownPermissionMode(state: SessionState): PermissionMode {
	return state.inTmux && !state.channel && state.permissionMode === "prompt" ? "allow" : state.permissionMode;
}

/** Reads per trigger at most, and the wait between them while a pending tool call is not listed yet. */
const CHANNEL_READS = 4;
const CHANNEL_RETRY_MS = 1000;

/** `permission.requests.list` result (`{sessionId, enabled, requests:[{id, sessionId, expiresAt, options, toolCall}]}`). */
function channelRequests(result: unknown): { enabled: boolean; requests: ChannelRequest[] } {
	const { enabled, requests } = (result ?? {}) as { enabled?: unknown; requests?: unknown };
	return { enabled: enabled !== false, requests: Array.isArray(requests) ? channelRequestItems(requests) : [] };
}

function channelRequestItems(requests: unknown[]): ChannelRequest[] {
	return requests.flatMap(item => {
		const r = item as { id?: unknown; options?: unknown; toolCall?: { toolCallId?: unknown } };
		if (typeof r.id !== "string" || !Array.isArray(r.options) || typeof r.toolCall?.toolCallId !== "string") return [];
		const options = r.options.filter(
			(o): o is PendingPermission["options"][number] =>
				typeof o?.optionId === "string" && typeof o?.name === "string" && typeof o?.kind === "string",
		);
		return [{ id: r.id, toolCallId: r.toolCall.toolCallId, toolCall: r.toolCall, options }];
	});
}

/** The echo of a phone prompt queued behind a TUI turn, held until gjc hands the prompt to the model. */
interface EchoHold {
	/** Echo blocks still to arrive (see `echoedBlocks`); only chunks matching them are held. */
	blocks: EchoBlock[];
	updates: Record<string, unknown>[];
	/** The prompt's text as gjc's queue lists it (see `queueText`). */
	text: string;
	/** Queue ids already listed when the prompt went in, so an older message with the same text is not taken for it. */
	before: Set<string>;
	/** The prompt's id in gjc's queue once a read listed it. */
	queueId?: string;
	echoedAt?: number;
	/** When `#lookForHandOver` last started a queue read. */
	lookedAt?: number;
}

type EchoBlock = { type: "text"; text: string } | { type: "image"; data: string };

/** How often a streaming turn may trigger a queue read while a held echo waits to be handed over. */
const ECHO_LOOK_MS = 300;

/** How long after the echo a queue read must start for the prompt's absence to mean gjc already took it. */
const ECHO_QUEUE_GRACE_MS = 1500;

export interface QueuedMessage {
	id: string;
	text: string;
	mode: "steer" | "followUp";
}

const STREAMED_TEXT_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk"]);

export interface HubClient {
	readonly id: string;
	/** The paired device behind this connection, which a reconnecting phone keeps (`id` is per connection). */
	readonly device?: string;
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
	/** Opt-in: open new sessions as windows of this tmux session (see tmux.ts). */
	tmux?: TmuxOptions;
	/** How often a phone turn gjc ACP may never end is checked against the host (see `#watchStuckTurn`). */
	stuckTurnCheckMs?: number;
	log?: (line: string) => void;
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
	#options: Required<Omit<HubOptions, "acp" | "tmux" | "log">> & Pick<HubOptions, "acp" | "log">;
	readonly #saved: SavedSessionIndex;
	readonly #tmux?: TmuxLauncher;
	readonly #sdkCli?: SdkCli;
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
	#stopped = false;

	constructor(options: HubOptions) {
		this.#options = { maxBufferedUpdates: 5000, maxBufferedBytes: MAX_BUFFERED_BYTES, stuckTurnCheckMs: STUCK_TURN_CHECK_MS, ...options };
		this.#saved = new SavedSessionIndex(options.agentDir);
		// The window gets the tmux server's environment; point gjc there at the agent dir the ACP side uses.
		if (options.tmux) {
			this.#tmux = new TmuxLauncher(options.tmux, tuiCommand(options.acp.command), { GJC_CODING_AGENT_DIR: options.agentDir });
			this.#sdkCli = new SdkCli({ command: tuiCommand(options.acp.command), agentDir: options.agentDir });
		}
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
			queueMicrotask(() => void this.#reattach());
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
		// An approval asked over ACP dies with the process. One from a tmux session's channel lives on in the TUI host:
		// its card is only taken down, and the reload below lists it again.
		for (const permission of this.#permissions.values()) if (!permission.fromChannel) permission.resolve({ outcome: "cancelled" });
		for (const permission of [...this.#permissions.values()]) {
			this.#permissions.delete(permission.requestId);
			if (permission.fromChannel) this.#broadcastAll("permission.resolved", { requestId: permission.requestId, sessionId: permission.sessionId });
		}
		for (const state of this.#sessions.values()) {
			state.loaded = false;
			state.channel = undefined;
			if (state.running) {
				state.running = false;
				this.#append(state, { sessionUpdate: AGENT_EXIT, code, stderrTail: acp.stderrTail.slice(-2000) });
			}
		}
		// The TUI in a tmux window waits on the bridge for its tool approvals: attach again without waiting for a phone.
		if (!this.#stopped && [...this.#sessions.values()].some(s => s.inTmux)) {
			setTimeout(() => void this.agent().catch(error => this.#options.log?.(`gjc ACP restart failed: ${error?.message ?? error}`)), 0);
		}
	}

	stop(): void {
		this.#stopped = true;
		if (this.#statusTimer) clearInterval(this.#statusTimer);
		this.#acp?.kill();
	}

	/**
	 * Loads every session a tmux window of the bridge hosts, after the ACP process (re)started: on bridge start, after a
	 * recycle or a crash. Until then nothing would watch its approval channel, and a tool typed in the terminal would wait
	 * 60s for an answer only the phone can give, then be rejected.
	 */
	async #reattach(): Promise<void> {
		if (!this.#tmux || this.#stopped) return;
		const windows = new Map((await this.#tmux.hostedSessions()).map(w => [w.sessionId, w.cwd]));
		for (const state of this.#sessions.values()) if (state.inTmux && !windows.has(state.sessionId)) windows.set(state.sessionId, state.cwd);
		for (const [sessionId, windowCwd] of windows) {
			const known = this.#sessions.get(sessionId);
			if (known?.loaded || this.#stopped) continue;
			const cwd = known?.cwd ?? (windowCwd || this.#saved.find(sessionId)?.cwd);
			if (!cwd) continue;
			await this.#load(this.#stateFor(sessionId, cwd), true).catch(error =>
				this.#options.log?.(`reattach ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`),
			);
		}
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
		if ([...this.#sessions.values()].some(s => s.running || s.remoteAskAnswers > 0) || this.#permissions.size > 0) return;
		this.#onExit(acp, null);
		this.#restartDelayMs = 0;
		acp.kill();
	}

	// ── inbound from gjc ─────────────────────────────────────────────────────

	#onNotification(method: string, params: any): void {
		if (method !== "session/update" || typeof params?.sessionId !== "string") return;
		const state = this.#stateFor(params.sessionId);
		if (this.#holdEcho(state, params.update)) return;
		this.#append(state, state.inTmux ? terminalAsk(params.update) : params.update);
		this.#lookForHandOver(state, params.update);
		if (state.channel && !state.replaying) this.#watchChannel(state, params.update);
	}

	/**
	 * Keeps back the echo of a phone prompt queued behind a TUI turn until gjc hands it to the model. gjc echoes a
	 * prompt's text and image blocks as `user_message_chunk` the moment it receives it, before the prompt waits in
	 * its queue (measured 2026-11-07 on pve3, gjc 0.19.3: echoed at once, listed as `steer:1` for 25s until the TUI
	 * turn's tool ended, then answered; nothing announced the hand-over). Shown at once, the message sat in the
	 * middle of the TUI turn's output while the phone also listed it as waiting; the TUI shows it only once
	 * delivered. The echo is released when the queue no longer lists it (`#settleEchoHold`) or the prompt ends.
	 */
	#holdEcho(state: SessionState, update: any): boolean {
		const hold = state.echoHold;
		if (!hold || update?.sessionUpdate !== "user_message_chunk" || !sameBlock(hold.blocks[0], update.content)) return false;
		hold.blocks.shift();
		hold.updates.push(update);
		if (hold.blocks.length === 0) hold.echoedAt = Date.now();
		return true;
	}

	/**
	 * gjc hands a queued message over at a step boundary: when a tool ends, or when the model's answer goes on.
	 * Looks at once on a tool end and at most every [ECHO_LOOK_MS] while the turn streams, instead of waiting for
	 * the once-a-second read. A read already in flight may predate the hand-over, so the look starts after it.
	 */
	#lookForHandOver(state: SessionState, update: any): void {
		const hold = state.echoHold;
		if (hold?.queueId === undefined) return;
		const now = Date.now();
		const toolEnded = update?.status === "completed" || update?.status === "failed";
		if (!toolEnded && now - (hold.lookedAt ?? 0) < ECHO_LOOK_MS) return;
		hold.lookedAt = now;
		void (state.queueSample ?? Promise.resolve()).then(() => this.#sampleQueue(state));
	}

	/** Releases the held echo once gjc's queue (read at [sampledAt]) shows the prompt left it. */
	#settleEchoHold(state: SessionState, queue: QueuedMessage[], sampledAt: number): void {
		const hold = state.echoHold;
		if (!hold || hold.echoedAt === undefined) return;
		if (hold.queueId === undefined) {
			// gjc lists it as a steer, or as a follow-up when one already waits ahead of it. Matched by text only: a
			// steer typed in the TUI meanwhile is new to [before] too, and taking it for this prompt would hold the
			// message until that one goes.
			const listed = queue.find(m => !hold.before.has(m.id) && m.text.trim() === hold.text);
			if (listed) {
				hold.queueId = listed.id;
				return;
			}
			// Never listed: taken straight away (the TUI turn was at a step boundary or had just ended). A read started
			// right after the echo may predate the queueing, so only a later one counts.
			if (sampledAt - hold.echoedAt < ECHO_QUEUE_GRACE_MS) return;
		} else if (queue.some(m => m.id === hold.queueId)) {
			return;
		}
		this.#releaseEcho(state);
	}

	#releaseEcho(state: SessionState): void {
		const hold = state.echoHold;
		state.echoHold = undefined;
		for (const update of hold?.updates ?? []) this.#append(state, update);
	}

	/**
	 * Turns on the permission approval channel of a session gjc hosts in a tmux window. gjc sends a TUI host's tool
	 * approvals to no ACP client, and gjc 0.19.3 prohibits the channel over ACP, so the bridge goes through the
	 * session CLI (see sdk-cli.ts). Measured 2026-11-07 on pve3: with the channel on, the bash approvals of both a
	 * phone turn and a turn typed in the terminal are listed by `permission.requests.list` (the TUI shows only a
	 * spinner meanwhile) and `permission.respond` allows or rejects them. Without it the TUI ran bash unasked while
	 * the phone showed `prompt`. Enabling sets the session to prompt; re-enabling is a no-op. A failure leaves the
	 * session without the channel, logged.
	 */
	async #enableChannel(state: SessionState): Promise<void> {
		const cli = this.#sdkCli;
		if (!cli || state.channel) return;
		try {
			await cli.control(state.sessionId, state.cwd, "permission.channel.set", { enabled: true });
			state.channel = { requests: new Map(), waitingTools: new Set(), settled: new Set() };
		} catch (error) {
			this.#options.log?.(`permission channel not enabled for ${state.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * gjc announces a channel request on no stream, but the tool it gates arrives over ACP as a pending tool call
	 * first (measured ~1.4s before it is listed): read the channel then, again while such a call stays pending
	 * unlisted, and drop the card of a call that ended (expired, cancelled, answered in another way).
	 */
	#watchChannel(state: SessionState, update: any): void {
		const channel = state.channel!;
		const kind = update?.sessionUpdate;
		if (kind !== "tool_call" && kind !== "tool_call_update") return;
		const toolCallId = update.toolCallId;
		if (typeof toolCallId !== "string") return;
		const pending = update.status === "pending" || (kind === "tool_call" && update.status === undefined);
		// gjc starts every tool call pending; only a guarded one in prompt mode waits on the channel, never an ask.
		if (pending && (state.permissionMode !== "prompt" || update.rawInput?.questions !== undefined)) return;
		if (pending) {
			channel.waitingTools.add(toolCallId);
			this.#readChannel(state);
			return;
		}
		if (update.status === undefined) return;
		channel.waitingTools.delete(toolCallId);
		if (update.status !== "completed" && update.status !== "failed") return;
		for (const [id, request] of channel.requests) {
			if (request.toolCallId === toolCallId) this.#dropChannelRequest(state, id);
		}
	}

	/** Lists the channel's requests into phone permission cards; one read at a time, another queued behind it. */
	#readChannel(state: SessionState): void {
		const channel = state.channel;
		const cli = this.#sdkCli;
		if (!channel || !cli) return;
		if (channel.reading) {
			channel.again = true;
			return;
		}
		channel.reading = (async () => {
			for (let attempt = 0; attempt < CHANNEL_READS; attempt++) {
				channel.again = false;
				let read: { enabled: boolean; requests: ChannelRequest[] };
				try {
					read = channelRequests(await cli.query(state.sessionId, state.cwd, "permission.requests.list"));
				} catch (error) {
					this.#options.log?.(`permission.requests.list failed for ${state.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
					return;
				}
				if (state.channel !== channel) return;
				if (!read.enabled) {
					// The host lost it (a TUI restarted under the same id): turn it on again.
					for (const id of [...channel.requests.keys()]) this.#dropChannelRequest(state, id);
					state.channel = undefined;
					await this.#enableChannel(state);
					this.#announceShownMode(state);
					return;
				}
				const listed = read.requests.filter(r => !channel.settled.has(r.id));
				const ids = new Set(listed.map(r => r.id));
				for (const id of channel.requests.keys()) if (!ids.has(id)) this.#dropChannelRequest(state, id);
				for (const request of listed) {
					channel.waitingTools.delete(request.toolCallId);
					if (!channel.requests.has(request.id)) this.#showChannelRequest(state, request);
				}
				// A gated call shows up in the channel a moment after it arrives here; one that never does was not gated.
				if (!channel.again && channel.waitingTools.size === 0) return;
				if (!channel.again) await Bun.sleep(CHANNEL_RETRY_MS);
			}
		})().finally(() => {
			channel.reading = undefined;
			if (channel.again) this.#readChannel(state);
		});
	}

	#showChannelRequest(state: SessionState, request: ChannelRequest): void {
		const channel = state.channel!;
		const requestId = `perm-${this.#nextPermission++}`;
		channel.requests.set(request.id, { requestId, toolCallId: request.toolCallId });
		const pending: PendingPermission = {
			requestId,
			sessionId: state.sessionId,
			toolCall: request.toolCall,
			options: request.options,
			resolve: outcome => this.#answerChannel(state, request, outcome),
			fromChannel: true,
		};
		this.#permissions.set(requestId, pending);
		this.#broadcastAll("permission.request", publicPermission(pending));
	}

	/** Tells the phones the permission mode to show when it changed, e.g. `allow` for a TUI host that lost its channel. */
	#announceShownMode(state: SessionState): void {
		const shown = shownPermissionMode(state);
		if (shown === (state.shownMode ?? state.permissionMode)) return;
		state.shownMode = shown;
		this.#append(state, { sessionUpdate: PERMISSION_MODE_UPDATE, mode: shown });
	}

	/** Removes a request's card from the phones without answering it (gjc settled it some other way). */
	#dropChannelRequest(state: SessionState, id: string): void {
		const shown = state.channel?.requests.get(id);
		if (!shown) return;
		state.channel!.requests.delete(id);
		// A read that started before gjc settled it may still list it: never shown again.
		state.channel!.settled.add(id);
		this.#permissions.delete(shown.requestId);
		this.#broadcastAll("permission.resolved", { requestId: shown.requestId, sessionId: state.sessionId });
		if (this.#recyclePending) setTimeout(() => this.#maybeRecycle(), 0);
	}

	/** The phone's answer: `permission.respond` with the picked option, a dismissal as the offered rejection. */
	async #answerChannel(state: SessionState, request: ChannelRequest, outcome: PermissionOutcome): Promise<void> {
		if (!state.channel?.requests.has(request.id)) return;
		this.#dropChannelRequest(state, request.id);
		const optionId =
			outcome.outcome === "selected" ? outcome.optionId : request.options.find(o => o.kind === "reject_once" || o.kind === "reject_always")?.optionId;
		if (!optionId) return; // nothing to reject with: gjc fails it closed when it expires
		try {
			await this.#sdkCli!.control(state.sessionId, state.cwd, "permission.respond", { sessionId: state.sessionId, id: request.id, optionId });
		} catch (error) {
			this.#options.log?.(`permission.respond failed for ${state.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
			// Still waiting (the CLI failed, not gjc): show it again.
			state.channel?.settled.delete(request.id);
			this.#readChannel(state);
		}
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
				historySeq: 0,
				resync: new Set(),
				buffer: [],
				bufferBytes: 0,
				loaded: false,
				running: false,
				hostRunning: false,
				throughput: new Throughput(),
				queued: [],
				remoteAsks: new Map(),
				remoteAsksDone: new Set(),
				remoteAsksDismissed: new Set(),
				remoteAskAnswers: 0,
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
		state.bufferBytes += jsonBytes(update);
		while (
			state.buffer.length > this.#options.maxBufferedUpdates ||
			(state.bufferBytes > this.#options.maxBufferedBytes && state.buffer.length > 1)
		) {
			const dropped = state.buffer.shift()!;
			state.bufferBytes -= jsonBytes(dropped.update);
		}
		// A phone showing the chat already has the history a reload of the bridge's own replays.
		if (state.quietReplay) return;
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
			const meta = update._meta as { running?: unknown; gjcPhase?: unknown } | undefined;
			if (typeof meta?.running === "boolean") state.hostRunning = meta.running;
			if (typeof meta?.gjcPhase === "string") state.hostPhase = meta.gjcPhase;
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
		const sampledAt = Date.now();
		state.queueSample ??= this.sdk({ sessionId: state.sessionId, kind: "query", op: "queue.messages.list", internal: true })
			.then(result => {
				const queue = queuedMessages(result);
				if (isActive(state)) state.queued = queue;
				this.#settleEchoHold(state, queue, sampledAt);
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
		if (state.hostAsks.size === 0) this.#dropRemoteAsks(state);
	}

	/**
	 * Makes the TUI's pending asks answerable on the phone where the session host lists them (`ask.requests.list`, newer
	 * than gjc 0.19.3): each selector question becomes a permission card whose pick goes back as `ask.answer`. Runs on
	 * the status tick while the transcript shows an unanswered ask, since every pick (a multi-select toggle, the next
	 * question) gives the request a new id. A host without it leaves the read-only card from the transcript.
	 */
	#syncRemoteAsks(state: SessionState): void {
		if (state.remoteAsksUnsupported || !state.loaded || state.hostAsks.size === 0) return;
		if (state.remoteAskSync) {
			state.remoteAskSync.again = true;
			return;
		}
		const sync = { again: false };
		state.remoteAskSync = sync;
		void (async () => {
			try {
				do {
					sync.again = false;
					const acp = await this.agent();
					let listed: ReturnType<typeof remoteAskRequests>;
					try {
						listed = remoteAskRequests(await this.#sdkRequest(acp, state, "query", "ask.requests.list", {}));
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (error instanceof AcpError && (error.data as { code?: unknown } | undefined)?.code === "host_outdated") state.remoteAsksUnsupported = true;
						else if (state.remoteAskError !== message) console.error(`ask.requests.list failed for ${state.sessionId}: ${message}`);
						state.remoteAskError = message;
						return;
					}
					state.remoteAskError = undefined;
					if (state.hostAsks.size === 0) return;
					const live = new Set<string>();
					for (const request of listed) {
						if (request.sessionId !== undefined && request.sessionId !== state.sessionId) continue;
						if (state.remoteAsksDone.has(request.id)) continue;
						if (request.questionId !== undefined && state.remoteAsksDismissed.has(request.questionId)) continue;
						const card = remoteAskCard(request);
						if (!card) continue;
						live.add(request.id);
						if (!state.remoteAsks.has(request.id)) this.#showRemoteAsk(state, request.id, request.questionId, request.question, card);
					}
					for (const id of [...state.remoteAsks.keys()]) if (!live.has(id)) this.#dropRemoteAsk(state, id);
					// Dismissed questions the host no longer lists are done with.
					const listedQuestions = new Set(listed.map(r => r.questionId));
					for (const questionId of state.remoteAsksDismissed) if (!listedQuestions.has(questionId)) state.remoteAsksDismissed.delete(questionId);
				} while (sync.again);
			} finally {
				state.remoteAskSync = undefined;
			}
		})();
	}

	#showRemoteAsk(state: SessionState, id: string, questionId: string | undefined, question: string, card: RemoteAskCard): void {
		const requestId = `perm-${this.#nextPermission++}`;
		// The ask row on the phone carries the transcript's tool call id; with several pending, the card stands alone.
		const toolCallId = state.hostAsks.size === 1 ? [...state.hostAsks][0]! : `ask-${id}`;
		const pending: PendingPermission = {
			requestId,
			sessionId: state.sessionId,
			// No rawInput: the question is the title, and the ask row above already lists it with its options.
			toolCall: { toolCallId, toolName: "ask", title: question, kind: "other", status: "pending" },
			options: card.options,
			hostAsk: true,
			resolve: outcome => {
				// Dismissing the card leaves the question to the terminal.
				const answer = outcome.outcome === "selected" ? card.answers.get(outcome.optionId) : undefined;
				if (!answer && questionId !== undefined) state.remoteAsksDismissed.add(questionId);
				if (answer) state.remoteAskAnswers++;
				this.#dropRemoteAsk(state, id);
				if (answer) void this.#answerRemoteAsk(state, id, answer);
			},
		};
		state.remoteAsks.set(id, pending);
		this.#permissions.set(requestId, pending);
		this.#broadcastAll("permission.request", publicPermission(pending));
	}

	#dropRemoteAsk(state: SessionState, id: string): void {
		const shown = state.remoteAsks.get(id);
		if (!shown) return;
		state.remoteAsks.delete(id);
		state.remoteAsksDone.add(id);
		this.#permissions.delete(shown.requestId);
		this.#broadcastAll("permission.resolved", { requestId: shown.requestId, sessionId: state.sessionId });
		if (this.#recyclePending) setTimeout(() => this.#maybeRecycle(), 0);
	}

	#dropRemoteAsks(state: SessionState): void {
		for (const id of [...state.remoteAsks.keys()]) this.#dropRemoteAsk(state, id);
	}

	async #answerRemoteAsk(state: SessionState, id: string, answer: { kind: "value"; value: string } | { kind: "control"; controlId: string }): Promise<void> {
		try {
			const acp = await this.agent();
			await this.#sdkRequest(acp, state, "control", "ask.answer", { id, answer });
		} catch (error) {
			// A terminal answer that won the race, or a transition, makes the id stale: the next listing shows what is left.
			// Anything else did not reach the question: show the card again if it is still listed.
			if (!(error instanceof AcpError && (error.data as { code?: unknown } | undefined)?.code === "stale_request")) {
				state.remoteAsksDone.delete(id);
				console.error(`ask.answer failed for ${state.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
			}
		} finally {
			state.remoteAskAnswers--;
		}
		this.#syncRemoteAsks(state);
		if (this.#recyclePending) setTimeout(() => this.#maybeRecycle(), 0);
	}

	/** One tick per second while any session is working, so list rows show a live rate and chats gjc's queue. */
	#ensureStatusTimer(): void {
		if (this.#statusTimer) return;
		this.#statusTimer = setInterval(() => {
			const active = [...this.#sessions.values()].filter(isActive);
			for (const state of active) {
				this.#sampleHostAsks(state);
				this.#syncRemoteAsks(state);
				this.#watchStuckTurn(state);
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
		const tmuxSkipped = this.#tmux && (await this.#tmux.unavailable());
		if (tmuxSkipped) this.#options.log?.(`tmux skipped (opening over ACP): ${tmuxSkipped.slice(0, 200)}`);
		if (this.#tmux && !tmuxSkipped) {
			// gjc in the window starts the session; the phone then attaches to that TUI host like to any terminal
			// session. Nothing is saved until its first answer, so a window closed unused leaves no transcript behind.
			let sessionId: string;
			try {
				sessionId = await this.#tmux.open(cwd);
			} catch (error) {
				if (!(error instanceof TmuxError)) throw error;
				throw new AcpError(-32021, `새 세션을 tmux 창으로 열지 못했습니다: ${error.message}`, { code: error.code });
			}
			this.#stateFor(sessionId, cwd).inTmux = true;
			return this.openSession(clientId, { sessionId, cwd });
		}
		const result = await acp.request("session/new", { cwd, mcpServers: [] });
		const state = this.#stateFor(result.sessionId, cwd);
		state.loaded = true;
		state.configOptions = supportedConfigOptions(result.configOptions ?? state.configOptions);
		return this.#subscribe(clientId, state, 0);
	}

	async openSession(clientId: string, params: { sessionId: string; cwd?: string; afterSeq?: number }): Promise<OpenSnapshot> {
		const state = this.#stateFor(params.sessionId, params.cwd ?? this.#saved.find(params.sessionId)?.cwd);
		// A turn being released (`#releaseTurn`) reloads the session itself.
		await state.releasing?.catch(() => {});
		if (!state.loaded) {
			await this.#load(state);
			return this.#subscribe(clientId, state, 0, true);
		}
		return this.#subscribe(clientId, state, params.afterSeq ?? 0);
	}

	/** Loads the session into the ACP process (`session/load`); one load at a time per session. */
	#load(state: SessionState, quiet = false): Promise<void> {
		if (state.loaded) return Promise.resolve();
		state.loading ??= (async () => {
			const acp = await this.agent();
			// A reload replays the full history again; start the replay buffer from scratch.
			state.buffer = [];
			state.bufferBytes = 0;
			state.hostPhase = undefined;
			// The replay carries a waiting ask as failed ("ends without a result"); show it again as pending.
			state.hostAsks.clear();
			state.hostAskScan = undefined;
			// The cards went with the ACP process that listed them (or are listed again below); the host may be another build.
			this.#dropRemoteAsks(state);
			state.remoteAsksDone.clear();
			state.remoteAsksDismissed.clear();
			state.remoteAsksUnsupported = undefined;
			// The channel is judged again below; its cards come back from the first read.
			for (const id of [...(state.channel?.requests.keys() ?? [])]) this.#dropChannelRequest(state, id);
			state.channel = undefined;
			state.replaying = true;
			state.quietReplay = quiet;
			let result: any;
			try {
				result = await acp.request("session/load", { sessionId: state.sessionId, cwd: state.cwd, mcpServers: [] });
			} catch (error) {
				this.#recycleOnBrokerLoss(acp, error);
				throw error;
			} finally {
				state.replaying = false;
				state.quietReplay = false;
				state.historySeq = state.seq;
				if (quiet) for (const { client, sessions } of this.#clients.values()) if (sessions.has(state.sessionId)) state.resync.add(client.device ?? client.id);
			}
			state.configOptions = supportedConfigOptions(result?.configOptions ?? state.configOptions);
			// Judged on every load: a window the bridge opened (also before a restart) hosts it, or no longer does.
			if (this.#tmux) state.inTmux = await this.#tmux.hosts(state.sessionId, state.cwd);
			// Before the mode: enabling the channel sets the session to prompt.
			if (state.inTmux) await this.#enableChannel(state);
			if (state.permissionMode !== "prompt") await this.#applyPermissionMode(acp, state.sessionId, state.permissionMode);
			state.loaded = true;
			this.#announceShownMode(state);
			// Requests already waiting (from before a restart) are not announced by any later tool call.
			this.#readChannel(state);
		})().finally(() => {
			state.loading = undefined;
		});
		return state.loading;
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
		const entry = this.#clients.get(clientId);
		entry?.sessions.add(state.sessionId);
		const resync = state.resync.delete(entry?.client.device ?? clientId);
		const firstSeq = state.buffer[0]?.seq ?? state.seq + 1;
		const reset = forceReset || resync || afterSeq === 0 || afterSeq < firstSeq - 1 || afterSeq > state.seq || afterSeq < state.historySeq;
		return {
			sessionId: state.sessionId,
			cwd: state.cwd,
			configOptions: state.configOptions,
			// A turn started in the terminal counts too, as it does in the live `_meta.running` and session.status:
			// a phone opening the chat then steers it, and a photo message it holds waits for that turn's end.
			running: isActive(state),
			seq: state.seq,
			reset,
			updates: reset ? state.buffer.slice() : state.buffer.filter(u => u.seq > afterSeq),
			permissions: [...this.#permissions.values()].filter(p => p.sessionId === state.sessionId).map(publicPermission),
			permissionMode: shownPermissionMode(state),
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
		if (mode === "prompt" && state.inTmux && !state.channel) {
			await this.#enableChannel(state);
			if (!state.channel)
				throw new AcpError(-32020, "터미널(tmux) 세션의 승인 채널을 켜지 못해 폰에서 승인할 수 없습니다. 브리지 로그를 확인하세요.", {
					code: "approval_channel_unavailable",
				});
		}
		const kind = mode === "allow" ? "allow_once" : "reject_once";
		const settle = (fromChannel: boolean) => {
			if (mode === "prompt") return [];
			return [...this.#permissions.values()].flatMap(pending => {
				if (pending.sessionId !== state.sessionId || pending.hostAsk || Boolean(pending.fromChannel) !== fromChannel) return [];
				const option = pending.options.find(o => o.kind === kind);
				return option ? [pending.resolve({ outcome: "selected", optionId: option.optionId })] : [];
			});
		};
		// gjc cancels the channel's waiting requests when the mode changes: answer them first.
		await Promise.all(settle(true));
		await this.#applyPermissionMode(await this.agent(), state.sessionId, mode, state);
		state.permissionMode = mode;
		state.shownMode = mode;
		this.#append(state, { sessionUpdate: PERMISSION_MODE_UPDATE, mode });
		settle(false);
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

	async prompt(params: { sessionId: string; prompt: unknown[] }, interrupting = false): Promise<{ accepted: true; turnId: string }> {
		const acp = await this.agent();
		const state = this.#sessions.get(params.sessionId);
		// A released turn ends before its session is loaded again; the phone may already send the next message.
		await state?.releasing?.catch(() => {});
		if (!state?.loaded) throw new AcpError(-32002, "Session is not open; call session.open first");
		if (state.running || (state.interrupting && !interrupting))
			throw new AcpError(-32003, "A turn is already running in this session");
		if (!Array.isArray(params.prompt) || params.prompt.length === 0) throw new AcpError(-32602, "prompt must be a non-empty block array");
		const promptBytes = Buffer.byteLength(JSON.stringify(params.prompt));
		if (promptBytes > PROMPT_BYTES_LIMIT) throw promptTooLarge(params.prompt, promptBytes);
		state.running = true;
		const turnId = crypto.randomUUID();
		state.turnId = turnId;
		state.turnBehindHost = state.hostRunning;
		state.turnAttachmentText = params.prompt.some(block => (block as { type?: unknown } | null)?.type !== "text")
			? promptText(params.prompt) || undefined
			: undefined;
		const echoed = echoedBlocks(params.prompt);
		state.echoHold =
			state.hostRunning && echoed.length > 0
				? { blocks: echoed, updates: [], text: queueText(params.prompt), before: new Set(state.queued.map(m => m.id)) }
				: undefined;
		state.stuckCheck = { at: Date.now() };
		this.#track(state, { sessionUpdate: "x_gjcm_turn_start" });
		const turn: Promise<void> = acp.request("session/prompt", { sessionId: params.sessionId, prompt: params.prompt }).then(
			result => {
				// Already ended by `#releaseTurn`; a late answer must not end the next turn.
				if (state.turn !== turn) return;
				// Answered, so gjc took it: a hand-over the queue reads missed still shows the message, before the turn end.
				this.#releaseEcho(state);
				this.#endTurn(state, { sessionUpdate: TURN_END, stopReason: result?.stopReason ?? "end_turn" });
			},
			error => {
				if (state.turn !== turn) return;
				// Still held: it never reached the model (gjc 0.19.3 fails a queued prompt purged from its queue as
				// "Prompt submission failed."), so it is not shown as said.
				state.echoHold = undefined;
				const message = String(error?.message ?? error);
				if (message.includes(STALE_ATTACHMENT)) state.loaded = false;
				// A stop, not a failure; `undelivered` tells the phone that sent it to put the message back in its composer.
				if (message.includes(PREFLIGHT_CANCELLED)) this.#endTurn(state, { sessionUpdate: TURN_END, stopReason: "cancelled", undelivered: true });
				else this.#endTurn(state, { sessionUpdate: TURN_END, stopReason: "error", error: message });
			},
		);
		state.turn = turn;
		return { accepted: true, turnId };
	}

	#endTurn(state: SessionState, turnEnd: Record<string, unknown>): void {
		// Only the phone that sent the prompt knows this id, so only it takes an `undelivered` message back.
		const turnId = state.turnId;
		state.turn = undefined;
		state.turnId = undefined;
		state.running = false;
		state.turnBehindHost = false;
		state.turnAttachmentText = undefined;
		state.stuckCheck = undefined;
		this.#append(state, turnId ? { ...turnEnd, turnId } : turnEnd);
		this.#maybeRecycle();
	}

	/**
	 * The phone's stop. gjc lets a client stop only a run it owns (see `interrupt`), so a turn typed in the TUI and a
	 * phone prompt that went in behind one are refused at once, pointing at the terminal's Esc. Measured 2026-11-08 on
	 * gjc 0.19.3: `session/cancel` left both running, and while the phone's prompt still waited in gjc's queue it
	 * purged it, photos included ("Prompt submission failed."); a held photo message went back to the composer while
	 * the turn went on. Such a phone turn whose host has nothing left to do is one gjc ACP no longer ends: it is
	 * released (`#releaseTurn`). All this is for a session a terminal hosts (`primaryControlSurface` `cli`); in one gjc
	 * ACP hosts itself (`sdk`, measured: a session the bridge created) the stop is the plain `session/cancel` as before.
	 * When the host cannot say, a phone prompt that went in behind another turn is still refused (`session/cancel`
	 * could purge it), and anything else gets the plain stop.
	 */
	async cancel(params: { sessionId: string }): Promise<{ ok: true }> {
		const state = this.#sessions.get(params.sessionId);
		if (state?.releasing) {
			await state.releasing;
			return { ok: true };
		}
		// The bridge's own turn stops as before; its stop also stays when a steer repeats an attachment prompt's text
		// (the backstop `interrupt` has would make it refuse a turn a phone-only session can stop nowhere else).
		if (state?.loaded && (state.running ? state.turnBehindHost : state.hostRunning)) {
			const host = await this.#hostState(state);
			if (host?.terminal) {
				if (state.running && host.idle) {
					await this.#releaseTurn(state);
					return { ok: true };
				}
				if (state.running || !host.idle) throw hostTurnStop(state.running);
			} else if (!host && state.running) throw hostTurnStop(true);
		}
		return this.#cancelTurn(params.sessionId);
	}

	/** Stops a turn this bridge owns: gjc settles its `session/prompt` as cancelled. */
	async #cancelTurn(sessionId: string): Promise<{ ok: true }> {
		for (const permission of this.#permissions.values()) {
			if (permission.sessionId === sessionId) permission.resolve({ outcome: "cancelled" });
		}
		(await this.agent()).notify("session/cancel", { sessionId });
		return { ok: true };
	}

	/**
	 * What the session host says of itself (gjc 0.19.3), apart from the ACP phase, which a pending prompt keeps at
	 * working: whether a terminal hosts it (`runtime.capabilities` `primaryControlSurface` `cli`), and whether it has
	 * nothing left to do (`context.get` `isStreaming` false with empty queues, and no compaction or retry under way:
	 * `isStreaming` does not cover those). `undefined` when it cannot say.
	 */
	async #hostState(state: SessionState): Promise<{ terminal: boolean; idle: boolean } | undefined> {
		try {
			const acp = await this.agent();
			const [capabilities, context] = await Promise.all([
				this.#sdkRequest(acp, state, "query", "runtime.capabilities", {}),
				this.#sdkRequest(acp, state, "query", "context.get", {}),
			]);
			const surface = capabilities?.page?.items?.[0]?.primaryControlSurface;
			const item = context?.page?.items?.[0];
			if ((surface !== "cli" && surface !== "sdk") || typeof item?.isStreaming !== "boolean") return undefined;
			const idle = !item.isStreaming && !item.steeringQueueDepth && !item.followupQueueDepth && !HOST_BUSY_PHASES.has(state.hostPhase ?? "");
			return { terminal: surface === "cli", idle };
		} catch {
			return undefined;
		}
	}

	/**
	 * Ends a phone turn gjc ACP no longer ends. Seen 2026-11-08 on pve3 (gjc 0.19.3): a phone prompt went in behind a
	 * TUI turn and ran on after it until the terminal's Esc; the TUI went idle, but `session/prompt` stayed unanswered
	 * for over an hour, so the phone showed the turn working and refused every new message (-32003). Closing the ACP
	 * attachment settles the waiting prompt (as cancelled) and leaves a TUI host alone; the session is loaded again
	 * at once. Measured on gjc 0.19.3 with a TUI host: settled in 16ms, the host's turn ran on, reattached in 1.2s,
	 * and the next prompt was answered normally. gjc's close settles only the prompt it tracks as active, so a prompt
	 * still unanswered after [RELEASE_SETTLE_TIMEOUT_MS] (or a failed close) is ended here as cancelled.
	 */
	#releaseTurn(state: SessionState): Promise<void> {
		state.releasing ??= (async () => {
			const acp = await this.agent();
			const turn = state.turn;
			this.#options.log?.(`releasing a turn of ${state.sessionId}: its host is idle, but gjc ACP never ended it`);
			// Nothing else goes to the attachment being closed.
			state.loaded = false;
			try {
				await acp.request("session/close", { sessionId: state.sessionId });
			} catch (error) {
				this.#options.log?.(`closing ${state.sessionId} to release its turn failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			const settled = !turn || (await Promise.race([turn.then(() => true), Bun.sleep(RELEASE_SETTLE_TIMEOUT_MS).then(() => false)]));
			if (!settled && state.turn === turn) {
				state.echoHold = undefined;
				this.#endTurn(state, { sessionUpdate: TURN_END, stopReason: "cancelled" });
			}
			// The turn is over either way; a failed load leaves the session closed, and the phone's next call (-32002)
			// opens it again.
			await this.#load(state, true).catch(error =>
				this.#options.log?.(`loading ${state.sessionId} again after releasing its turn failed: ${error instanceof Error ? error.message : String(error)}`),
			);
		})().finally(() => {
			state.releasing = undefined;
		});
		return state.releasing;
	}

	/**
	 * Notices a turn `#releaseTurn` is for without waiting for a stop. While a phone prompt that went in behind a TUI
	 * turn is pending, the host is asked every [HubOptions.stuckTurnCheckMs]; idle twice in a row with no update in
	 * between releases it. A phone turn of its own is left to the stop: it settles with its run (measured).
	 */
	#watchStuckTurn(state: SessionState): void {
		const check = state.stuckCheck;
		if (!check || check.asking || !state.running || !state.turnBehindHost || !state.loaded || state.releasing) return;
		if (Date.now() - check.at < this.#options.stuckTurnCheckMs) return;
		const seq = state.seq;
		check.asking = true;
		void this.#hostState(state).then(host => {
			check.asking = false;
			check.at = Date.now();
			if (state.stuckCheck !== check) return;
			if (!host?.terminal || !host.idle || state.seq !== seq) {
				check.idleSeq = undefined;
				return;
			}
			if (check.idleSeq !== seq) {
				check.idleSeq = seq;
				return;
			}
			void this.#releaseTurn(state).catch(error =>
				this.#options.log?.(`releasing a turn of ${state.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`),
			);
		});
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
	 *
	 * The same holds when the bridge's own prompt went in during such a turn: gjc queues it as a steer of that turn
	 * (it is listed by `queue.messages.list`), and `session/cancel` leaves the TUI turn running but purges the queued
	 * prompt, failing it as "Prompt submission failed.". Measured 2026-11-06 on pve3 with gjc 0.19.3: a phone's
	 * photo+text was lost that way and only its text came back from the queue. It is refused too; gjc delivers it,
	 * attachments included, at the turn's next step, or runs it as a turn of its own once the TUI turn ends without
	 * taking it. In that last case 끼어들기 stays refused for the rest of that turn (see [SessionState.turnBehindHost]).
	 */
	async interrupt(params: { sessionId: string }): Promise<{ accepted: true; text: string }> {
		const state = this.#sessions.get(params.sessionId);
		if (!state?.loaded) throw new AcpError(-32002, "Session is not open; call session.open first");
		const steers = await this.#queuedSteers(params.sessionId);
		if (steers.length === 0) throw noPendingSteer();
		const ownPromptQueued =
			state.running &&
			(state.turnBehindHost === true ||
				(state.turnAttachmentText !== undefined && steers.some(s => s.text.trim() === state.turnAttachmentText)));
		if (!state.running && state.hostRunning)
			throw new AcpError(-32004, "터미널에서 시작한 턴은 앱에서 멈출 수 없습니다. 지시는 대기열에 있고 턴의 다음 단계에서 전달됩니다.", {
				code: "host_turn",
			});
		if (ownPromptQueued)
			throw new AcpError(
				-32004,
				"보낸 메시지가 터미널에서 시작한 턴 뒤에서 기다리고 있어 끼어들 수 없습니다. 메시지는 첨부와 함께 그 턴에 전달됩니다.",
				{ code: "host_turn" },
			);
		if (state.interrupting) throw new AcpError(-32003, "끼어들기가 이미 진행 중입니다.");
		const mark = state.seq;
		state.interrupting = true;
		try {
			return await this.#interruptAndResend(state, steers, mark);
		} finally {
			state.interrupting = false;
		}
	}

	async #interruptAndResend(
		state: SessionState,
		steers: { id: string; text: string }[],
		mark: number,
	): Promise<{ accepted: true; text: string }> {
		const params = { sessionId: state.sessionId };
		if (isActive(state)) {
			await this.#cancelTurn(params.sessionId);
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
		await this.prompt({ sessionId: params.sessionId, prompt: [{ type: "text", text }] }, true);
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
		if (params.kind === "control" && params.op === "turn.btw") return { result: await this.#sideQuestion(acp, state, params.input ?? {}) };
		const response = await this.#sdkRequest(acp, state, params.kind, params.op, params.input ?? {}, params.confirm);
		if (params.kind === "query") {
			const items: unknown[] = response?.page?.items ?? [];
			return { items: params.op === "context.get" ? items.map(withoutSystemPrompt) : items, complete: response?.page?.complete !== false };
		}
		// Measured shapes: most operations answer with the bare result ({renamed:true}, {path}, …);
		// some (mode.goal.operate) answer with the control envelope instead.
		if (response?.type === "control_response") return { result: response.result ?? null };
		return { result: response ?? null };
	}

	/**
	 * The phone's `/btw` (`turn.btw` {question, exchanges?: [{question, answer}]} -> {replyText}) on whichever side-question
	 * operation the gjc hosting this session has, read from its `runtime.capabilities` on every call (a session host can
	 * restart on another build):
	 * - `turn.btw` (local patch 0004): unchanged. First, because only it answers mid-turn with the main turn's pending
	 *   request kept out of the side conversation; a patched build rebased past gajae-code#7583 advertises both;
	 * - official `btw.ask` that takes `exchanges` (`btwAskExchangesVersion` 1, gajae-code#7583): history passed as is;
	 * - official `btw.ask` without it (0.19.3 accepts and silently drops `exchanges`, measured): the answered history is
	 *   folded into the question, oldest exchanges dropped first to stay within gjc's 16 KiB question limit.
	 */
	async #sideQuestion(acp: AcpProcess, state: SessionState, input: Record<string, unknown>): Promise<{ replyText: string }> {
		const response = await this.#sdkRequest(acp, state, "query", "runtime.capabilities", {});
		const capabilities = response?.page?.items?.[0];
		if (!Array.isArray(capabilities?.operations)) {
			throw new AcpError(-32020, "gjc의 runtime.capabilities 응답에 연산 목록(page.items[0].operations)이 없습니다.", { code: "internal" });
		}
		const operations: unknown[] = capabilities.operations;
		const question = typeof input.question === "string" ? input.question : "";
		const exchanges = btwExchanges(input.exchanges);
		if (operations.includes("turn.btw")) {
			return { replyText: String((await this.#sdkRequest(acp, state, "control", "turn.btw", input))?.replyText ?? "") };
		}
		if (operations.includes("btw.ask") && capabilities.btwAskExchangesVersion >= 1) {
			const asked = { question, ...(exchanges.length ? { exchanges: exchanges.map(e => ({ question: e.question, reply: e.answer })) } : {}) };
			return { replyText: String((await this.#sdkRequest(acp, state, "control", "btw.ask", asked))?.reply ?? "") };
		}
		if (operations.includes("btw.ask")) {
			const asked = { question: foldBtwExchanges(question, exchanges) };
			return { replyText: String((await this.#sdkRequest(acp, state, "control", "btw.ask", asked))?.reply ?? "") };
		}
		throw new AcpError(-32020, "이 세션의 gjc에는 BTW 기능(btw.ask)이 없습니다. gjc 0.19.3 이상이 필요하고, 업데이트 전에 시작된 세션이면 gjc를 다시 시작해야 합니다.", {
			code: "host_outdated",
		});
	}

	/** One `_gjc/sdk/query|control` round trip; gjc's `{ok:false}` answers become typed AcpErrors. */
	async #sdkRequest(
		acp: AcpProcess,
		state: SessionState,
		kind: "query" | "control",
		op: string,
		input: Record<string, unknown>,
		confirm?: boolean,
	): Promise<any> {
		const response =
			kind === "query"
				? await acp.request("_gjc/sdk/query", { sessionId: state.sessionId, query: op, input })
				: await acp.request("_gjc/sdk/control", {
						sessionId: state.sessionId,
						operation: op,
						input,
						...(confirm ? { confirm: true } : {}),
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
				// never had it or the session host started before it was added.
				// A restart only helps in the second case, so the message does not promise it.
				throw new AcpError(
					-32020,
					`이 세션의 gjc가 ${op}을(를) 지원하지 않습니다. 공식 gjc 릴리스에 없는 기능이거나, 그 기능이 들어가기 전에 시작된 세션입니다.`,
					{ code: "host_outdated" },
				);
			}
			throw new AcpError(-32020, message, { code: error.code ?? "internal" });
		}
		return response;
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
/** `session/close` settled the waiting prompt in 16ms (gjc 0.19.3, TUI host). */
const RELEASE_SETTLE_TIMEOUT_MS = 5000;
/** Spacing of the host checks `#watchStuckTurn` needs twice in a row (a host step rarely goes 15s without an update). */
const STUCK_TURN_CHECK_MS = 15_000;
/**
 * A session.open from scratch sends the whole buffer as one frame, and a phone drops the connection on a frame over
 * 32 MiB (server MAX_FRAME_BYTES, iOS maximumMessageSize). The buffer stays well under it, room left for the rest of
 * the snapshot (2026-11-08, pve1: a buffer then counted in UTF-16 units under a 48MB cap answered 28.2MB of UTF-8).
 */
const MAX_BUFFERED_BYTES = 24 * 1024 * 1024;
/** `gjcPhase` values gjc 0.19.3 reports while the host works with `isStreaming` false (acp-event-mapper). */
const HOST_BUSY_PHASES = new Set(["compacting", "retrying"]);
/**
 * gjc's ACP refuses a prompt whose SDK frame passes 256 KiB (`MAX_PROMPT_FRAME_BYTES`, gjc 0.19.3) with an English
 * message the phone shows as is ("ACP prompt is 326 KiB, over the 256 KiB transport limit..."). The frame carries the
 * same text and base64 images as the prompt blocks plus a ~200-byte envelope, so the blocks are held to that limit
 * minus a margin and refused here, before a turn is started, in Korean.
 */
const PROMPT_BYTES_LIMIT = 256 * 1024 - 1024;

/** Says which part to cut: since app 1.0.3 photos are re-encoded to fit, so what is left over is mostly text. */
function promptTooLarge(prompt: unknown[], bytes: number): AcpError {
	const textBytes = prompt.reduce<number>((sum, block) => {
		const text = (block as { type?: unknown; text?: unknown } | null)?.text;
		return typeof text === "string" ? sum + Buffer.byteLength(text) : sum;
	}, 0);
	const kib = (n: number) => Math.ceil(n / 1024);
	return new AcpError(
		-32602,
		`메시지가 ${kib(bytes)}KiB(글 ${kib(textBytes)}KiB, 사진 등 ${kib(Math.max(0, bytes - textBytes))}KiB)라 gjc가 한 번에 받는 256KiB를 넘습니다. 글이나 사진을 줄이세요.`,
		{ code: "prompt_too_large", bytes, limit: PROMPT_BYTES_LIMIT },
	);
}
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

/** gjc's `btw.ask` question limit (BTW_MAX_QUESTION_UTF8_BYTES). */
const BTW_ASK_QUESTION_BYTES = 16 * 1024;

interface BtwExchange {
	question: string;
	answer: string;
}

/**
 * The phone's answered `/btw` history (`[{question, answer}]`) for the `btw.ask` paths. The apps only send answered
 * exchanges; a malformed entry is left out rather than failing the whole side question.
 */
function btwExchanges(value: unknown): BtwExchange[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(entry =>
		typeof entry?.question === "string" && typeof entry?.answer === "string" ? [{ question: entry.question, answer: entry.answer }] : [],
	);
}

/**
 * The question for a `btw.ask` that drops `exchanges`: the answered history quoted ahead of it, oldest exchanges left
 * out first so the whole stays within gjc's question limit. A question that alone exceeds it goes out unchanged and
 * gjc refuses it as `invalid_input`; so does an empty question, which is not dressed up with history.
 */
export function foldBtwExchanges(question: string, exchanges: BtwExchange[]): string {
	if (!question.trim()) return question;
	const bytes = (text: string) => Buffer.byteLength(text, "utf8");
	for (let start = 0; start < exchanges.length; start++) {
		const history = exchanges
			.slice(start)
			.map(e => `Q: ${e.question}\nA: ${e.answer}`)
			.join("\n\n");
		const folded = `Earlier questions and answers in this side chat, oldest first:\n\n${history}\n\nCurrent question: ${question}`;
		if (bytes(folded) <= BTW_ASK_QUESTION_BYTES) return folded;
	}
	return question;
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

/** The prompt blocks gjc echoes back as `user_message_chunk`, in order (acp-agent: text with content and images). */
function echoedBlocks(prompt: unknown[]): EchoBlock[] {
	return prompt.flatMap((block): EchoBlock[] => {
		const b = block as { type?: unknown; text?: unknown; data?: unknown } | null;
		if (b?.type === "image" && typeof b.data === "string") return [{ type: "image", data: b.data }];
		if (b?.type === "text" && typeof b.text === "string" && b.text.length > 0) return [{ type: "text", text: b.text }];
		return [];
	});
}

function sameBlock(expected: EchoBlock | undefined, content: unknown): boolean {
	const c = content as { type?: unknown; text?: unknown; data?: unknown } | null | undefined;
	if (!expected || c?.type !== expected.type) return false;
	return expected.type === "text" ? c.text === expected.text : c.data === expected.data;
}

/**
 * The text gjc 0.19.3 lists a prompt under in its queue: `acpPromptPayload` joins its text blocks and renders file
 * links and text resources into the text, and an empty text with images is shown as "[Image]" (agent-session).
 */
function queueText(prompt: unknown[]): string {
	const text: string[] = [];
	let images = 0;
	for (const block of prompt) {
		const b = block as Record<string, any> | null;
		switch (b?.type) {
			case "text":
				if (typeof b.text === "string") text.push(b.text);
				break;
			case "image":
				images++;
				break;
			case "resource_link":
				text.push(
					[
						`[Resource: ${b.name}]`,
						`URI: ${b.uri}`,
						...(b.title ? [`Title: ${b.title}`] : []),
						...(b.description ? [b.description] : []),
						...(b.mimeType ? [`MIME: ${b.mimeType}`] : []),
						...(typeof b.size === "number" ? [`Size: ${b.size}`] : []),
					].join("\n"),
				);
				break;
			case "resource":
				if (typeof b.resource?.text === "string")
					text.push([`[Resource: ${b.resource.uri}]`, ...(b.resource.mimeType ? [`MIME: ${b.resource.mimeType}`] : []), b.resource.text].join("\n"));
				else images++;
				break;
		}
	}
	const joined = text.join("\n");
	return (joined || (images > 0 ? "[Image]" : "")).trim();
}

/** The text blocks of a prompt as gjc's queue lists it (attachments carry no text). */
function promptText(prompt: unknown[]): string {
	return prompt
		.map(block => (block as { type?: unknown; text?: unknown } | null))
		.filter(block => block?.type === "text" && typeof block.text === "string")
		.map(block => block!.text as string)
		.join("\n")
		.trim();
}

function hostTurnStop(phoneTurn: boolean): AcpError {
	const what = phoneTurn ? "보낸 메시지는 터미널에서 시작한 턴에 이어져 있어" : "터미널에서 시작한 턴은";
	return new AcpError(-32004, `${what} 앱에서 멈출 수 없습니다. 터미널에서 Esc로 멈추세요.`, { code: "host_turn" });
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

/** UTF-8 bytes of `value` as JSON, as it goes out: `length` counts UTF-16 units, a third of that for Korean text. */
function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

function stripUndefined<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== "")) as T;
}
