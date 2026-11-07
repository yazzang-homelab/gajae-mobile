/**
 * Deterministic stand-in for `gjc --mode=acp`, shaped after the recorded trace
 * fixtures/acp-echo-permission.trace (real gjc 0.18.7 output).
 */
import fs from "node:fs";

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
const steers = new Map<string, { id: string; text: string; mode: "steer"; label: "Steer" }[]>();
let nextSteer = 1;
// Sessions with a turn typed in the TUI ("terminal turn" … "terminal done"), which no ACP prompt owns.
const terminalTurns = new Set<string>();
// ACP prompts that arrived during a terminal turn. Like gjc 0.19.3 (measured 2026-11-06 on pve3): such a prompt waits
// in the session queue, listed by queue.messages.list as a steer, and reaches the model at the turn's next step.
// gjc echoes its blocks as soon as it receives the prompt (not when the model takes it) and reports no
// `running: false` until the prompt settles.
// session/cancel does not stop the terminal turn; it purges the queued prompt, which then fails as
// "Prompt submission failed." ("Queued prompt was removed before consumption" in gjc's log).
const queuedPrompts = new Map<string, { steerId: string; blocks: any[]; settle: (outcome: "consumed" | "removed") => void }>();
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
			reply({ sessionId, configOptions });
			update(sessionId, { sessionUpdate: "session_info_update", _meta: { gjcPhase: "idle" } });
			return;
		}
		case "session/load": {
			if (params.sessionId === "broker-lost")
				return write({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error: SDK request outcome is uncertain after the frame was sent." } });
			const history = sessions.get(params.sessionId);
			if (!history) return write({ jsonrpc: "2.0", id, error: { code: -32002, message: "not found" } });
			staleAttachments.delete(params.sessionId);
			attached.add(params.sessionId);
			permissionModes.delete(params.sessionId);
			for (const text of history) update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
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
				const steerId = `steer:${nextSteer++}`;
				// "즉시" stands for a prompt the TUI turn took at once (it was at a step boundary): never listed as queued.
				if (!texts.join(" ").startsWith("즉시"))
					steers.set(sid, [...(steers.get(sid) ?? []), { id: steerId, text: texts.join("\n"), mode: "steer", label: "Steer" }]);
				for (const block of params.prompt) update(sid, { sessionUpdate: "user_message_chunk", content: block });
				const outcome = await new Promise<"consumed" | "removed">(settle => queuedPrompts.set(sid, { steerId, blocks: params.prompt, settle }));
				if (outcome === "removed") return write({ jsonrpc: "2.0", id, error: { code: -32603, message: "Prompt submission failed." } });
				update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `받은 블록: ${params.prompt.map((b: any) => b.type).join(",")}` } });
				reply({ stopReason: "end_turn" });
				update(sid, { sessionUpdate: "session_info_update", _meta: { gjcPhase: "idle", running: false } });
				return;
			}
			sessions.get(sid)?.push(texts.join("\n"));
			persist();
			saveTranscript(sid, sessionCwds.get(sid) ?? "/tmp");
			for (const block of params.prompt) update(sid, { sessionUpdate: "user_message_chunk", content: block });
			if (texts.join(" ") === "crash") process.exit(3);
			if (texts.join(" ").includes("slow")) {
				update(sid, { sessionUpdate: "session_info_update", _meta: { gjcPhase: "working", running: true } });
				update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one\ntwo\n" } });
				await new Promise<void>(resolve => cancellable.set(sid, resolve));
				update(sid, { sessionUpdate: "session_info_update", _meta: { gjcPhase: "idle", running: false } });
				return reply({ stopReason: "cancelled" });
			}
			const kinds = params.prompt.map((b: any) => b.type).join(",");
			if (texts.join(" ").includes("tool")) {
				const toolCall = { toolCallId: "t1", title: "echo hi", kind: "execute", status: "pending", rawInput: { command: "echo hi" } };
				update(sid, { sessionUpdate: "tool_call", ...toolCall });
				const mode = permissionModes.get(sid) ?? "prompt";
				const res =
					mode === "prompt"
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
				const item = { operations, hostTools: false, ...(btw.endsWith("-exchanges") ? { btwAskExchangesVersion: 1 } : {}) };
				return reply({ type: "query_response", id: "q", ok: true, page: { items: [item], complete: true } });
			}
			if (params.query === "context.get")
				return reply({ type: "query_response", id: "q", ok: true, page: { items: [{ usage: { tokens: 1200, contextWindow: 100000, percent: 1.2 }, systemPrompt: ["abc", "de"] }], complete: true } });
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
				permissionModes.set(params.sessionId, params.input?.mode);
				return reply({ changed: true, mode: params.input?.mode });
			}
			if (params.operation === "thinking.set") {
				thinkingLevels.set(params.sessionId, params.input.level);
				return reply({ changed: true });
			}
			if (params.operation === "turn.steer") {
				const text = String(params.input?.text ?? "");
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
					if (waiting) steers.set(params.sessionId, (steers.get(params.sessionId) ?? []).filter(s => s.id !== waiting.steerId));
					update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "terminal-tool", status: "completed" });
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
