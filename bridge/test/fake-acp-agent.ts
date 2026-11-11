/**
 * Deterministic stand-in for `gjc --mode=acp`, shaped after the recorded trace
 * fixtures/acp-echo-permission.trace (real gjc 0.18.7 output).
 */
import fs from "node:fs";
import path from "node:path";

// Launched by the bridge's tmux path as the TUI (the tmux tests' agent command, which carries `--tui=<mode>`, without
// `--mode=acp`): like gjc, start a new session, publish its SDK endpoint under <cwd>/.gjc/state/sdk with this
// process's pid (and the agent dir it got), and only then register the session with the broker, without waiting
// (gjc 0.19.3/0.20.0 `session-runtime.ts`: `runtime.start()`, then `registerBroker()`). `<id>.tui` stands for that
// registration for the ACP process below: like gjc's broker, it attaches a live host on session/load before any
// transcript exists, and answers not_found until then. The registration goes with this process.
// `--tui=run` registers 400ms after publishing, `--tui=late` publishes 800ms after starting, `--tui=unregistered`
// never registers, `--tui=exit` quits at once, `--tui=silent` never publishes.
const tuiMode = process.argv.find(arg => arg.startsWith("--tui="))?.slice("--tui=".length);
if (tuiMode && !process.argv.includes("--mode=acp") && !process.argv.includes("sdk")) {
	if (tuiMode === "exit") process.exit(1);
	if (tuiMode !== "silent") {
		const dir = path.join(process.cwd(), ".gjc", "state", "sdk");
		const sessionId = `tui-${process.pid}`;
		const agentDir = process.env.GJC_CODING_AGENT_DIR;
		const registration = path.join(dir, `${sessionId}.tui`);
		const publish = () => {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ version: 1, sessionId, pid: process.pid, agentDir }));
			if (tuiMode !== "unregistered") setTimeout(() => fs.writeFileSync(registration, ""), 400);
		};
		if (tuiMode === "late") setTimeout(publish, 800);
		else publish();
		const leave = () => {
			fs.rmSync(registration, { force: true });
			process.exit(0);
		};
		process.on("SIGHUP", leave);
		process.on("SIGTERM", leave);
	}
	setInterval(() => {}, 60_000);
	await new Promise(() => {});
}

// Launched by the bridge as gjc's session CLI (`<agent> sdk session raw control|query <id> … --json`, see
// sdk-cli.ts) for the permission approval channel of a session a tmux window hosts. Like gjc 0.19.3, the channel is
// the host's: files under <cwd>/.gjc/state/sdk stand for it (`<id>.channel` on, `<id>.requests.json` the pending
// requests, `<id>.answer.json` the last response), shared with the ACP process that runs the turns here.
const rawAt = process.argv.indexOf("raw");
if (process.argv.includes("sdk") && process.argv.includes("session") && rawAt >= 0) {
	const [verb, sessionId] = [process.argv[rawAt + 1], process.argv[rawAt + 2]];
	const op = process.argv[process.argv.indexOf(verb === "control" ? "--op" : "--query") + 1];
	const input = verb === "control" ? JSON.parse(process.argv[process.argv.indexOf("--json-input") + 1]!) : undefined;
	const file = (suffix: string) => path.join(process.cwd(), ".gjc", "state", "sdk", `${sessionId}.${suffix}`);
	const out = (result: unknown) => process.stdout.write(`${JSON.stringify({ type: `${verb}_response`, id: "c", ok: true, result })}\n`);
	const failed = (code: string, message: string) => process.stdout.write(`${JSON.stringify({ type: `${verb}_response`, id: "c", ok: false, error: { code, message } })}\n`);
	if (process.env.FAKE_CLI_FAIL) failed("resource_gone", "No live session.");
	else if (op === "permission.channel.set") {
		if (input.enabled) fs.writeFileSync(file("channel"), "");
		else fs.rmSync(file("channel"), { force: true });
		out({ enabled: Boolean(input.enabled) });
	} else if (op === "permission.requests.list") {
		const requests = fs.existsSync(file("requests.json")) ? JSON.parse(fs.readFileSync(file("requests.json"), "utf8")) : [];
		out({ sessionId, enabled: fs.existsSync(file("channel")), requests });
	} else if (op === "permission.respond") {
		const requests: Array<{ id: string }> = fs.existsSync(file("requests.json")) ? JSON.parse(fs.readFileSync(file("requests.json"), "utf8")) : [];
		// `<id>.respond-fail` stands for one call that never reached the host (the CLI or broker failed).
		if (fs.existsSync(file("respond-fail"))) {
			fs.rmSync(file("respond-fail"));
			failed("internal", "Broker request failed.");
		} else if (!requests.some(r => r.id === input.id)) failed("invalid_input", "Permission request is stale or already answered");
		else {
			fs.writeFileSync(file("answer.json"), JSON.stringify(input));
			out({ accepted: true });
		}
	} else failed("unknown_operation", `Unknown control operation: ${op}.`);
	process.exit(0);
}

// Sessions persist across restarts like ~/.gjc/agent/sessions does for real gjc.
const stateFile = process.env.FAKE_ACP_STATE;
const sessions = new Map<string, string[]>(
	stateFile && fs.existsSync(stateFile) ? Object.entries(JSON.parse(fs.readFileSync(stateFile, "utf8"))) : [],
); // sessionId → history texts
const persist = () => stateFile && fs.writeFileSync(stateFile, JSON.stringify(Object.fromEntries(sessions)));
// Mirrors gjc's saved transcript layout (<agentDir>/sessions/<bucket>/<stamp>_<id>.jsonl, header record
// first) that the bridge lists for resume. Like gjc, nothing is written until the first prompt.
const agentDir = process.env.GJCM_FAKE_AGENT_DIR;
function saveTranscript(sessionId: string, cwd: string) {
	if (!agentDir) return;
	const dir = `${agentDir}/sessions/v2-fake`;
	fs.mkdirSync(dir, { recursive: true });
	const header = { type: "session", version: 5, id: sessionId, timestamp: "2026-10-21T00:00:00.000Z", cwd, title: `title ${sessionId}` };
	const body = (sessions.get(sessionId) ?? []).map(text => JSON.stringify({ type: "message", text }));
	fs.writeFileSync(`${dir}/2026-10-21T00-00-00-000Z_${sessionId}.jsonl`, [JSON.stringify(header), ...body].join("\n") + "\n");
}
const sessionCwds = new Map<string, string>();
// Sessions whose SDK attachment this process lost (gjc: the session host restarted elsewhere); cleared by session/load.
const staleAttachments = new Set<string>();
// Sessions this process created or loaded; like real gjc, others are "Unknown session" until session/load.
const attached = new Set<string>();
let nextId = 1000;
const pending = new Map<number, (result: any) => void>();
// Prompts still streaming ("slow"), settled by session/cancel like gjc does.
const cancellable = new Map<string, () => void>();
// gjc's pending steers per session (queue.messages.list). Unlike real gjc (which drops them), a cancel keeps
// them here, so the bridge's clean-up path is exercised.
const steers = new Map<string, { id: string; text: string; mode: "steer" | "followUp"; label: string }[]>();
let nextSteer = 1;
/** What ask.requests.list lists per session; `toolCallId` and `next` (listed after a non-final pick) stay in the fake. */
interface FakeAskRequest {
	id: string;
	toolCallId: string;
	next?: FakeAskRequest;
	failOnce?: boolean;
	[key: string]: unknown;
}
const remoteAsks = new Map<string, FakeAskRequest[]>();
const askAnswers: { sessionId: string; id: string; answer: unknown }[] = [];
// Sessions with a turn typed in the TUI ("terminal turn" … "terminal done"), which no ACP prompt owns.
const terminalTurns = new Set<string>();
// ACP prompts that arrived during a terminal turn. Like gjc 0.19.3 (measured 2026-11-06 on pve3): such a prompt waits
// in the session queue, listed by queue.messages.list as a steer, and reaches the model at the turn's next step.
// gjc echoes its blocks as soon as it receives the prompt (not when the model takes it) and reports no
// `running: false` until the prompt settles.
// session/cancel does not stop the terminal turn; it purges the queued prompt, which then fails as
// "Prompt submission failed." ("Queued prompt was removed before consumption" in gjc's log).
// `orphan`: gjc no longer tracks it as the session's active prompt, so session/close does not settle it either.
const queuedPrompts = new Map<
	string,
	{ steerId: string; blocks: any[]; taken?: boolean; orphan?: boolean; settle: (outcome: "consumed" | "removed" | "closed") => void }
>();
// Sessions whose next session/load fails once ("fail next load").
const failNextLoad = new Set<string>();
// gjc's SDK permission policy; every ACP attachment (session/new, session/load) resets it to prompt.
const permissionModes = new Map<string, string>();

function write(message: unknown) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}
function update(sessionId: string, u: unknown) {
	write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
}
function request(method: string, params: unknown): Promise<any> {
	const id = nextId++;
	write({ jsonrpc: "2.0", id, method, params });
	return new Promise(resolve => pending.set(id, resolve));
}
const configOptions = [
	{ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
	{ id: "model", name: "Model", category: "model", type: "select", currentValue: "fake/model-a", options: [{ value: "fake/model-a", name: "A" }, { value: "fake/model-b", name: "B" }] },
	{ id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
];
// Like gjc, set_config_option for thinking is slow (it rebuilds the model catalog); thinking.set is not.
const thinkingLevels = new Map<string, string>();

// A tool approval through the host's permission channel (see the CLI mode above) instead of session/request_permission:
// listed as a request, answered by `permission.respond`. A request left alone fails when "expire" is steered.
const channelOptions = [
	{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
	{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
];
let nextChannelRequest = 1;
const expiring = new Map<string, () => void>();
function channelOn(sid: string): string | undefined {
	const cwd = sessionCwds.get(sid);
	const dir = cwd && path.join(cwd, ".gjc", "state", "sdk");
	return dir && fs.existsSync(path.join(dir, `${sid}.channel`)) ? dir : undefined;
}
async function channelApproval(sid: string, dir: string, toolCall: Record<string, unknown>): Promise<string | undefined> {
	const id = `req-${nextChannelRequest++}`;
	const requests = path.join(dir, `${sid}.requests.json`);
	const answer = path.join(dir, `${sid}.answer.json`);
	// gjc lists the request a moment after the pending tool call arrives over ACP (measured ~1.4s).
	await Bun.sleep(1200);
	fs.writeFileSync(requests, JSON.stringify([{ id, sessionId: sid, expiresAt: new Date(Date.now() + 60_000).toISOString(), options: channelOptions, toolCall: { ...toolCall, toolName: "bash" } }]));
	const answered = (): string | undefined => {
		if (!fs.existsSync(answer)) return undefined;
		const given = JSON.parse(fs.readFileSync(answer, "utf8"));
		fs.rmSync(answer);
		return given.id === id ? given.optionId : undefined;
	};
	// Like gjc, the request settles at once: by the response that landed first, or by the expiry or cancellation,
	// after which a response finds it gone.
	let settled: { optionId?: string } | undefined;
	expiring.set(sid, () => (settled ??= { optionId: answered() }));
	try {
		for (;;) {
			if (settled) return settled.optionId;
			const optionId = answered();
			if (optionId) return optionId;
			await Bun.sleep(30);
		}
	} finally {
		expiring.delete(sid);
		fs.rmSync(requests, { force: true });
	}
}

function channelWaiting(sid: string): boolean {
	const cwd = sessionCwds.get(sid);
	return cwd !== undefined && fs.existsSync(path.join(cwd, ".gjc", "state", "sdk", `${sid}.requests.json`));
}
// `<id>.typed` under the session's sdk directory stands for a turn typed in the TUI itself, which no ACP client asked
// for: gjc reports the host working, the turn's bash call waits on the permission channel (runs unasked without
// one), and the host goes idle when the call ends.
setInterval(() => {
	for (const [sid, cwd] of sessionCwds) {
		const typed = path.join(cwd, ".gjc", "state", "sdk", `${sid}.typed`);
		if (!fs.existsSync(typed)) continue;
		fs.rmSync(typed);
		const dir = channelOn(sid);
		const toolCall = { toolCallId: "ty1", title: "make build", kind: "execute", status: "pending", rawInput: { command: "make build" } };
		update(sid, { sessionUpdate: "session_info_update", _meta: { gjcPhase: "working", running: true } });
		update(sid, { sessionUpdate: "tool_call", ...toolCall });
		void (dir ? channelApproval(sid, dir, toolCall) : Promise.resolve("allow_once")).then(optionId => {
			update(sid, { sessionUpdate: "tool_call_update", toolCallId: "ty1", status: optionId === "allow_once" ? "completed" : "failed" });
			update(sid, { sessionUpdate: "session_info_update", _meta: { gjcPhase: "idle", running: false } });
		});
	}
}, 50);

async function handle(msg: any) {
	const { id, method, params } = msg;
	const reply = (result: unknown) => write({ jsonrpc: "2.0", id, result });
	switch (method) {
		case "initialize":
			return reply({ protocolVersion: 1, agentInfo: { name: "fake-gjc", version: String(process.pid) }, authMethods: [], agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } } });
		case "session/new": {
			const sessionId = `s${sessions.size + 1}`;
			sessions.set(sessionId, []);
			sessionCwds.set(sessionId, params.cwd);
			attached.add(sessionId);
			permissionModes.delete(sessionId);
			persist();
			// Like gjc's ACP session host, publish the SDK endpoint (it stays behind after session/close): the tmux tests,
			// whose cwd is a scratch dir, check that a new window is never taken for it.
			const sdkDir = path.join(params.cwd, ".gjc", "state", "sdk");
			if (process.env.GJCM_TEST_TMUX) {
				fs.mkdirSync(sdkDir, { recursive: true });
				fs.writeFileSync(path.join(sdkDir, `${sessionId}.json`), JSON.stringify({ version: 1, sessionId, pid: process.pid }));
			}
			reply({ sessionId, configOptions });
			update(sessionId, { sessionUpdate: "session_info_update", _meta: { gjcPhase: "idle" } });
			return;
		}
		case "session/load": {
			if (failNextLoad.delete(params.sessionId))
				return write({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error: load failed" } });
			if (params.sessionId === "broker-lost")
				return write({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error: SDK request outcome is uncertain after the frame was sent." } });
			// Like gjc's broker, a session a live TUI registered attaches before its first answer saved it; until it
			// registered, or once it is gone, such a session is saved nowhere.
			const registered = fs.existsSync(path.join(params.cwd, ".gjc", "state", "sdk", `${params.sessionId}.tui`));
			const saved = sessions.get(params.sessionId);
			const unsaved = !saved || (params.sessionId.startsWith("tui-") && saved.length === 0);
			// What gjc answers (acpRequestFailure): -32603 with the adapter's code in data.
			const missing = `Saved ACP session does not exist: ${params.sessionId}`;
			if (unsaved && !registered)
				return write({ jsonrpc: "2.0", id, error: { code: -32603, message: `Internal error: ${missing}`, data: { code: "not_found", details: missing } } });
			const history = saved ?? [];
			sessions.set(params.sessionId, history);
			staleAttachments.delete(params.sessionId);
			attached.add(params.sessionId);
			permissionModes.delete(params.sessionId);
			sessionCwds.set(params.sessionId, params.cwd);
			for (const text of history) update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
			// FAKE_LOAD_SETTLES_PROMPT: the prompt the lost attachment left unsettled ends while the load is still answering.
			if (process.env.FAKE_LOAD_SETTLES_PROMPT && cancellable.has(params.sessionId)) {
				cancellable.get(params.sessionId)!();
				cancellable.delete(params.sessionId);
				await new Promise(resolve => setTimeout(resolve, 300));
			}
			return reply({ configOptions });
		}
		case "session/fork": {
			const source = sessions.get(params.sessionId);
			if (!source) return write({ jsonrpc: "2.0", id, error: { code: -32002, message: "not found" } });
			const sessionId = `s${sessions.size + 1}`;
			sessions.set(sessionId, [...source]);
			sessionCwds.set(sessionId, params.cwd);
			attached.add(sessionId);
			persist();
			saveTranscript(sessionId, params.cwd);
			return reply({ sessionId, configOptions });
		}
		case "session/close": {
			attached.delete(params.sessionId);
			// Like gjc 0.19.3 (measured with a TUI host): closing the attachment settles a prompt still waiting on it as
			// cancelled; the host's own turn is left alone.
			const waiting = queuedPrompts.get(params.sessionId);
			if (waiting && !waiting.orphan) {
				queuedPrompts.delete(params.sessionId);
				steers.set(params.sessionId, (steers.get(params.sessionId) ?? []).filter(s => s.id !== waiting.steerId));
				waiting.settle("closed");
			}
			return reply({});
		}
		case "session/delete": {
			sessions.delete(params.sessionId);
			persist();
			if (agentDir) fs.rmSync(`${agentDir}/sessions/v2-fake/2026-10-21T00-00-00-000Z_${params.sessionId}.jsonl`, { force: true });
			return reply({});
		}
		case "session/set_config_option": {
			if (!attached.has(params.sessionId))
				return write({ jsonrpc: "2.0", id, error: { code: -32603, message: `Internal error: Unknown session, not found: ${params.sessionId}` } });
			if (params.configId === "thinking") await Bun.sleep(4000);
			const opt = configOptions.find(o => o.id === params.configId)!;
			opt.currentValue = params.value;
			return reply({ configOptions });
		}
		case "session/prompt": {
			const sid = params.sessionId;
			const texts = params.prompt.filter((b: any) => b.type === "text").map((b: any) => b.text);
			if (terminalTurns.has(sid)) {
				// Like gjc 0.19.3: the echo (text with content and images only) comes first, the queue entry after it (~0.1s
				// measured; 0.4s here so a queue read can land in between).
				// It is listed under acpPromptPayload's text ("[Image]" for photos only), and as a follow-up when one
				// already waits ahead of it.
				const ahead = (steers.get(sid) ?? []).some(s => s.mode === "followUp");
				const steerId = `${ahead ? "followUp" : "steer"}:${nextSteer++}`;
				for (const block of params.prompt)
					if (block.type === "image" || (block.type === "text" && block.text.length > 0))
						update(sid, { sessionUpdate: "user_message_chunk", content: block });
				const listed = params.prompt
					.flatMap((b: any) =>
						b.type === "text"
							? [b.text]
							: b.type === "resource_link"
								? [
										[
											`[Resource: ${b.name}]`,
											`URI: ${b.uri}`,
											...(b.title ? [`Title: ${b.title}`] : []),
											...(b.description ? [b.description] : []),
											...(b.mimeType ? [`MIME: ${b.mimeType}`] : []),
											...(typeof b.size === "number" ? [`Size: ${b.size}`] : []),
										].join("\n"),
									]
								: [],
					)
					.join("\n");
				const hasImage = params.prompt.some((b: any) => b.type === "image");
				// "즉시" stands for a prompt the TUI turn took at once (it was at a step boundary): never listed as queued.
				if (!texts.join(" ").startsWith("즉시"))
					setTimeout(() => {
						const waiting = queuedPrompts.get(sid);
						if (waiting?.steerId !== steerId || waiting.taken) return; // purged or taken meanwhile
						const entry = { id: steerId, text: listed || (hasImage ? "[Image]" : ""), mode: ahead ? "followUp" : "steer", label: ahead ? "Follow-up" : "Steer" } as const;
						steers.set(sid, [...(steers.get(sid) ?? []), entry]);
					}, 400);
				const outcome = await new Promise<"consumed" | "removed" | "closed">(settle => queuedPrompts.set(sid, { steerId, blocks: params.prompt, settle }));
				if (outcome === "removed") return write({ jsonrpc: "2.0", id, error: { code: -32603, message: "Prompt submission failed." } });
				if (outcome === "closed") return reply({ stopReason: "cancelled" });
				update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `받은 블록: ${params.prompt.map((b: any) => b.type).join(",")}` } });
				reply({ stopReason: "end_turn" });
				update(sid, { sessionUpdate: "session_info_update", _meta: { gjcPhase: "idle", running: false } });
				return;
			}
			if (texts.join(" ").startsWith("preflight")) {
				// Like gjc 0.19.3/0.20.0 in a session a terminal hosts, stopped before the prompt ran (measured 2026-11-08): the
				// echo comes, the transcript never gets the message, and session/prompt fails instead of settling as cancelled.
				for (const block of params.prompt) update(sid, { sessionUpdate: "user_message_chunk", content: block });
				await new Promise<void>(resolve => cancellable.set(sid, resolve));
				return write({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error: Prompt preflight was cancelled before execution." } });
			}
			sessions.get(sid)?.push(texts.join("\n"));
			persist();
			saveTranscript(sid, sessionCwds.get(sid) ?? "/tmp");
			for (const block of params.prompt) update(sid, { sessionUpdate: "user_message_chunk", content: block });
			if (texts.join(" ") === "crash") process.exit(3);
			// "malformed" stands for a gjc that writes lines outside the protocol before its real reply.
			if (texts.join(" ") === "malformed") {
				process.stdout.write("null\n");
				process.stdout.write("42\n");
				write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid } });
			}
			// "huge" stands for a single update bigger than any frame (a tool's output, say): 33 MiB of text.
			if (texts.join(" ") === "huge") {
				update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(33 * 1024 * 1024) } });
				return reply({ stopReason: "end_turn" });
			}
			if (texts.join(" ").includes("slow")) {
				update(sid, { sessionUpdate: "session_info_update", _meta: { gjcPhase: "working", running: true } });
				update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one\ntwo\n" } });
				await new Promise<void>(resolve => cancellable.set(sid, resolve));
				update(sid, { sessionUpdate: "session_info_update", _meta: { gjcPhase: "idle", running: false } });
				return reply({ stopReason: "cancelled" });
			}
			const kinds = params.prompt.map((b: any) => b.type).join(",");
			if (texts.join(" ") === "ask me") {
				// What gjc sends for an ask of an ACP turn in a session the TUI hosts: a bare tool_call, answered in the terminal.
				const rawInput = { questions: [{ id: "fruit", question: "사과와 배 중 하나를 고르세요", options: [{ label: "사과" }, { label: "배" }], recommended: 0 }] };
				update(sid, { sessionUpdate: "tool_call", toolCallId: "ask1", title: "과일 선택", kind: "other", status: "pending", rawInput });
				update(sid, { sessionUpdate: "tool_call_update", toolCallId: "ask1", status: "completed", content: [{ type: "content", content: { type: "text", text: "User selected: 배" } }] });
			}
			if (texts.join(" ").includes("tool")) {
				const toolCall = { toolCallId: "t1", title: "echo hi", kind: "execute", status: "pending", rawInput: { command: "echo hi" } };
				update(sid, { sessionUpdate: "tool_call", ...toolCall });
				const mode = permissionModes.get(sid) ?? "prompt";
				const channel = mode === "prompt" ? channelOn(sid) : undefined;
				// Measured on gjc 0.19.3: a TUI host (the tmux window's gjc) does not ask over ACP; without its approval
				// channel it runs the tool unasked.
				const sdkDir = path.join(sessionCwds.get(sid) ?? process.cwd(), ".gjc", "state", "sdk");
				const tuiHost = fs.existsSync(path.join(sdkDir, `${sid}.tui`));
				const res = channel
					? { outcome: { outcome: "selected", optionId: (await channelApproval(sid, channel, toolCall)) ?? "reject_once" } }
					: tuiHost && mode === "prompt"
						? { outcome: { outcome: "selected", optionId: "allow_once" } }
					: mode === "prompt"
						? await request("session/request_permission", {
								sessionId: sid,
								toolCall,
								options: [
									{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
									{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
								],
							})
						: { outcome: { outcome: "selected", optionId: mode === "allow" ? "allow_once" : "reject_once" } };
				if (res.outcome.outcome !== "selected" || res.outcome.optionId !== "allow_once") {
					update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" });
					return reply({ stopReason: "cancelled" });
				}
				update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "hi\n" } }] });
			}
			update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "받은 블록: " } });
			update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: kinds } });
			return reply({ stopReason: "end_turn" });
		}
		case "session/cancel": {
			// A steer starting with "boundary" stands for one the turn reached its step boundary with before the
			// cancel landed: gjc hands it to the model (a user message) and it leaves the queue.
			const queued = steers.get(params.sessionId) ?? [];
			for (const s of queued.filter(s => s.text.startsWith("boundary")))
				update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: s.text } });
			steers.set(params.sessionId, queued.filter(s => !s.text.startsWith("boundary")));
			const waiting = queuedPrompts.get(params.sessionId);
			if (waiting) {
				queuedPrompts.delete(params.sessionId);
				steers.set(params.sessionId, (steers.get(params.sessionId) ?? []).filter(s => s.id !== waiting.steerId));
				// The purged prompt fails a moment later, after a queue read can already see it gone.
				setTimeout(() => waiting.settle("removed"), 1500);
			}
			cancellable.get(params.sessionId)?.();
			cancellable.delete(params.sessionId);
			return;
		}
		// Shapes mirror gjc 0.18.7 measured over ACP (query → query_response page, control → bare result).
		case "_gjc/sdk/query":
			if (staleAttachments.has(params.sessionId))
				return reply({ type: "query_response", id: "q", ok: false, error: { code: "internal", message: "SDK session attachment is stale." } });
			if (params.query === "usage.get") {
				// The first usage read finds the attachment gone, as after a session-host restart.
				staleAttachments.add(params.sessionId);
				return reply({ type: "query_response", id: "q", ok: false, error: { code: "internal", message: "SDK session attachment is stale." } });
			}
			if (params.query === "queue.messages.list")
				return reply({ type: "query_response", id: "q", ok: true, page: { items: steers.get(params.sessionId) ?? [], complete: true } });
			if (params.query === "runtime.capabilities") {
				// FAKE_BTW picks the session host's /btw surface: none, turn (local patch 0004), ask (official 0.19.3,
				// which drops exchanges), ask-exchanges (btw.ask with btwAskExchangesVersion 1, gajae-code#7583) or
				// turn-exchanges (patch 0004 rebased past gajae-code#7583: both operations and the version).
				const btw = process.env.FAKE_BTW ?? "none";
				if (btw === "malformed")
					return reply({ type: "query_response", id: "q", ok: true, page: { items: [{ hostTools: false }], complete: true } });
				if (btw === "stale") {
					// The capability read finds the attachment gone, as after a session-host restart.
					staleAttachments.add(params.sessionId);
					return reply({ type: "query_response", id: "q", ok: false, error: { code: "internal", message: "SDK session attachment is stale." } });
				}
				const operations = ["turn.steer", ...(btw.startsWith("turn") ? ["turn.btw", "btw.ask"] : btw.startsWith("ask") ? ["btw.ask"] : [])];
				// FAKE_SURFACE=sdk stands for a session gjc ACP hosts itself; by default a terminal hosts it, as the
				// "terminal ..." steers below play.
				// FAKE_SURFACE=none stands for a host that does not say (no such field).
				const surface = process.env.FAKE_SURFACE ?? "cli";
				const item = {
					operations,
					hostTools: false,
					...(surface === "none" ? {} : { primaryControlSurface: surface }),
					...(btw.endsWith("-exchanges") ? { btwAskExchangesVersion: 1 } : {}),
				};
				return reply({ type: "query_response", id: "q", ok: true, page: { items: [item], complete: true } });
			}
			if (params.query === "ask.requests.list") {
				if (agentDir) fs.appendFileSync(`${agentDir}/ask-list-calls`, "x");
				// FAKE_ASK_LIST=q34 stands for a session host with gajae-code#7611; without it, as gjc 0.19.3, no such query.
				if (process.env.FAKE_ASK_LIST !== "q34")
					return reply({ type: "query_response", id: "q", ok: false, error: { code: "unknown_operation", message: `Unknown query operation: ${params.query}` } });
				const items = (remoteAsks.get(params.sessionId) ?? []).map(({ toolCallId: _, next: __, failOnce: ___, ...item }) => item);
				return reply({ type: "query_response", id: "q", ok: true, page: { items, complete: true, revision: "r" } });
			}
			if (params.query === "context.get") {
				// Like gjc 0.19.3: the host's own run state, apart from the ACP phase a pending prompt keeps at working.
				const queue = steers.get(params.sessionId) ?? [];
				const item = {
					usage: { tokens: 1200, contextWindow: 100000, percent: 1.2 },
					// A tool waiting on the permission channel belongs to a run under way (also one a restarted ACP finds).
					isStreaming: terminalTurns.has(params.sessionId) || cancellable.has(params.sessionId) || channelWaiting(params.sessionId),
					steeringQueueDepth: queue.filter(s => s.mode === "steer").length,
					followupQueueDepth: queue.filter(s => s.mode === "followUp").length,
					systemPrompt: ["abc", "de"],
				};
				return reply({ type: "query_response", id: "q", ok: true, page: { items: [item], complete: true } });
			}
			return reply({ type: "query_response", id: "q", ok: false, error: { code: "unsupported", message: `no ${params.query}` } });
		case "_gjc/sdk/control":
			if (params.operation === "session.rename") {
				// gjc appends the new title as a header_patch instead of rewriting the header line.
				const file = `${agentDir}/sessions/v2-fake/2026-10-21T00-00-00-000Z_${params.sessionId}.jsonl`;
				if (agentDir && fs.existsSync(file))
					fs.appendFileSync(file, `${JSON.stringify({ type: "header_patch", patch: { title: params.input?.name, titleSource: "user" } })}\n`);
				return reply({ renamed: params.input?.name === "새 이름" });
			}
			if (params.operation === "permission_mode.set") {
				if (staleAttachments.has(params.sessionId))
					return reply({ ok: false, error: { code: "internal", message: "SDK session attachment is stale." } });
				const changed = (permissionModes.get(params.sessionId) ?? "prompt") !== params.input?.mode;
				permissionModes.set(params.sessionId, params.input?.mode);
				// Like gjc (external-permissions.ts), a mode change cancels the channel's waiting requests.
				if (changed) expiring.get(params.sessionId)?.();
				return reply({ changed, mode: params.input?.mode });
			}
			if (params.operation === "thinking.set") {
				thinkingLevels.set(params.sessionId, params.input.level);
				return reply({ changed: true });
			}
			if (params.operation === "ask.answer") {
				// The listed request leaves; a commit writes the ask's toolResult as gjc does, a toggle/next lists `next`.
				const asks = remoteAsks.get(params.sessionId) ?? [];
				const request = asks.find(r => r.id === params.input?.id);
				if (!request) return reply({ ok: false, error: { code: "stale_request", message: "stale" } });
				// `failOnce`: the first answer fails short of the question (a transport error, not a stale id).
				if (request.failOnce) {
					request.failOnce = false;
					return reply({ ok: false, error: { code: "internal", message: "transport lost" } });
				}
				askAnswers.push({ sessionId: params.sessionId, id: request.id, answer: params.input.answer });
				remoteAsks.set(params.sessionId, [...asks.filter(r => r !== request), ...(request.next ? [request.next] : [])]);
				if (!request.next) {
					const value = params.input.answer?.value ?? params.input.answer?.controlId;
					const file = `${agentDir}/sessions/v2-fake/2026-10-26T00-00-00-000Z_${params.sessionId}.jsonl`;
					fs.appendFileSync(
						file,
						`${JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: request.toolCallId, toolName: "ask", content: [{ type: "text", text: `User selected: ${value} (${askAnswers.length} answers)` }] } })}\n`,
					);
				}
				return reply({ id: request.id, sessionId: params.sessionId, settlement: { kind: request.next ? "resolve_without_commit" : "commit" } });
			}
			if (params.operation === "turn.steer") {
				const text = String(params.input?.text ?? "");
				// "host ask <json>" stands for the TUI showing those ask requests (what ask.requests.list lists).
				if (text.startsWith("host ask ")) {
					remoteAsks.set(params.sessionId, JSON.parse(text.slice("host ask ".length)));
					return reply({ accepted: true });
				}
				// "terminal tool" stands for a bash call of the TUI turn that waits on the permission channel; "expire" lets
				// a waiting channel request time out.
				if (text === "terminal tool") {
					const dir = channelOn(params.sessionId);
					const toolCall = { toolCallId: "tt1", title: "rm -f x", kind: "execute", status: "pending", rawInput: { command: "rm -f x" } };
					update(params.sessionId, { sessionUpdate: "tool_call", ...toolCall });
					if (dir)
						void channelApproval(params.sessionId, dir, toolCall).then(optionId =>
							update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tt1", status: optionId === "allow_once" ? "completed" : "failed" }),
						);
					return reply({ accepted: true });
				}
				// "crash" stands for the ACP process dying while a prompt is in flight.
				if (text === "crash") process.exit(3);
				if (text === "expire") {
					expiring.get(params.sessionId)?.();
					return reply({ accepted: true });
				}
				// "terminal turn" stands for a turn typed in the TUI: gjc reports it working, but no ACP prompt owns it.
				if (text === "terminal turn") {
					terminalTurns.add(params.sessionId);
					update(params.sessionId, { sessionUpdate: "session_info_update", _meta: { gjcPhase: "working", running: true } });
					return reply({ accepted: true });
				}
				// "terminal step" stands for the TUI turn's next step boundary: gjc hands a queued prompt to the model, which
				// leaves the queue; the prompt still settles only with the turn.
				if (text === "terminal step") {
					const waiting = queuedPrompts.get(params.sessionId);
					if (waiting) {
						waiting.taken = true;
						steers.set(params.sessionId, (steers.get(params.sessionId) ?? []).filter(s => s.id !== waiting.steerId));
					}
					update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "terminal-tool", status: "completed" });
					return reply({ accepted: true });
				}
				// "terminal esc" stands for the TUI's Esc on a run that carries the phone's prompt. Seen 2026-11-08 on pve3
				// (gjc 0.19.3): the run stopped and the host went idle, but the ACP prompt was never answered and gjc reported
				// working on.
				// "terminal esc, orphaned" also leaves the prompt out of gjc's sight (see `orphan`).
				if (text === "terminal esc" || text === "terminal esc, orphaned") {
					terminalTurns.delete(params.sessionId);
					const waiting = queuedPrompts.get(params.sessionId);
					if (waiting) {
						waiting.taken = true;
						waiting.orphan = text.endsWith("orphaned");
						steers.set(params.sessionId, (steers.get(params.sessionId) ?? []).filter(s => s.id !== waiting.steerId));
					}
					return reply({ accepted: true });
				}
				if (text === "fail next load") {
					failNextLoad.add(params.sessionId);
					return reply({ accepted: true });
				}
				// "host compacting" / "host compacted": gjc's auto-compaction, which `isStreaming` does not cover.
				if (text === "host compacting" || text === "host compacted") {
					const phase = text === "host compacting" ? "compacting" : "idle";
					update(params.sessionId, { sessionUpdate: "session_info_update", _meta: { gjcPhase: phase, running: phase !== "idle" } });
					return reply({ accepted: true });
				}
				// "terminal done" ends that TUI turn.
				if (text === "terminal done") {
					terminalTurns.delete(params.sessionId);
					// A prompt queued behind the terminal turn reaches the model inside it, images included; the prompt
					// settles with that turn and only then does gjc report idle.
					const waiting = queuedPrompts.get(params.sessionId);
					if (waiting) {
						queuedPrompts.delete(params.sessionId);
						steers.set(params.sessionId, (steers.get(params.sessionId) ?? []).filter(s => s.id !== waiting.steerId));
						waiting.settle("consumed");
						return reply({ accepted: true });
					}
					update(params.sessionId, { sessionUpdate: "session_info_update", _meta: { gjcPhase: "idle", running: false } });
					return reply({ accepted: true });
				}
				// "taken" stands for a steer the model consumed at its next step: it never stays queued.
				if (text !== "taken") steers.set(params.sessionId, [...(steers.get(params.sessionId) ?? []), { id: `steer:${nextSteer++}`, text, mode: "steer", label: "Steer" }]);
				return reply({ accepted: true });
			}
			if (params.operation === "turn.follow_up") {
				const text = String(params.input?.text ?? "");
				steers.set(params.sessionId, [...(steers.get(params.sessionId) ?? []), { id: `followUp:${nextSteer++}`, text, mode: "followUp", label: "Follow-up" }]);
				return reply({ accepted: true });
			}
			if (params.operation === "queue.message.remove") {
				steers.set(params.sessionId, (steers.get(params.sessionId) ?? []).filter(m => m.id !== params.input?.id));
				return reply({ removed: true });
			}
			if (params.operation === "config.patch") {
				// gjc's withSdkControlMutation waits for the carrying session's turn to end, so on a busy session the
				// SDK request times out as uncertain_after_send (measured ~40s); answer that at once here.
				if (cancellable.has(params.sessionId))
					return reply({ ok: false, error: { code: "uncertain_after_send", message: "SDK request outcome is uncertain after the frame was sent." } });
				// gjc persists each top-level patch key into <agentDir>/config.yml (settings.set on dotted paths).
				const file = `${agentDir}/config.yml`;
				const config = fs.existsSync(file) ? (Bun.YAML.parse(fs.readFileSync(file, "utf8")) as any) ?? {} : {};
				const patch = params.input?.patch ?? {};
				for (const [key, value] of Object.entries(patch)) {
					const keys = key.split(".");
					let node = config;
					for (const k of keys.slice(0, -1)) node = node[k] ??= {};
					node[keys.at(-1)!] = value;
				}
				fs.writeFileSync(file, `${Bun.YAML.stringify(config, null, 2)}\n`);
				return reply({ patched: Object.keys(patch), revision: "1" });
			}
			// Side questions echo the input they received so tests can see what the bridge sent.
			if (params.operation === "turn.btw" && process.env.FAKE_BTW?.startsWith("turn"))
				return reply({ replyText: `turn.btw ${JSON.stringify(params.input)}` });
			if (params.operation === "btw.ask" && process.env.FAKE_BTW && process.env.FAKE_BTW !== "none")
				return reply({ reply: `btw.ask ${JSON.stringify(params.input)}` });
			// A session host without the operation (measured: gjc dispatch.ts "unknown_operation").
			if (params.operation === "turn.btw" || params.operation === "btw.ask" || params.operation === "service_tier.set")
				return reply({ ok: false, error: { code: "unknown_operation", message: `Unknown control operation: ${params.operation}.` } });
			if (params.operation === "mode.goal.operate") return reply({ type: "control_response", id: "c", ok: true });
			if (params.operation === "compaction.run")
				return reply({ ok: false, error: { code: "invalid_request", message: "Nothing to compact (session too small)" } });
			return reply({ ok: false, error: { code: "unsupported", message: "no" } });
		default:
			if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32601, message: `no ${method}` } });
	}
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
	buffer += new TextDecoder().decode(chunk);
	let nl = buffer.indexOf("\n");
	while (nl >= 0) {
		const line = buffer.slice(0, nl);
		buffer = buffer.slice(nl + 1);
		nl = buffer.indexOf("\n");
		if (!line.trim()) continue;
		const msg = JSON.parse(line);
		if (msg.method === undefined && pending.has(msg.id)) {
			pending.get(msg.id)!(msg.result);
			pending.delete(msg.id);
		} else void handle(msg);
	}
}
