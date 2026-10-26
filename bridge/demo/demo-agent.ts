/**
 * Scripted stand-in for `gjc --mode=acp` behind the public demo bridge that App Store and Google Play reviewers
 * pair with. It speaks the same ACP subset the bridge uses (protocol shapes follow bridge/test/fake-acp-agent.ts,
 * itself recorded from real gjc), so the apps run their production code path end to end — pairing, E2EE, streaming,
 * reasoning, tool permission, steering, model and effort — while nothing here touches a shell, a model provider or
 * any file outside `GJCM_DEMO_AGENT_DIR`.
 *
 *   gjcm-bridge serve --gjc "bun demo/demo-agent.ts" with GJC_CODING_AGENT_DIR=GJCM_DEMO_AGENT_DIR
 */
import fs from "node:fs";
import path from "node:path";

const agentDir = process.env.GJCM_DEMO_AGENT_DIR ?? process.env.GJC_CODING_AGENT_DIR;
if (!agentDir) throw new Error("GJCM_DEMO_AGENT_DIR is required");
const sessionsDir = path.join(agentDir, "sessions", "demo");
fs.mkdirSync(sessionsDir, { recursive: true });
/** Reviewers come and go for days; the demo keeps at most this many sessions, dropping the oldest. */
const MAX_SESSIONS = 40;
const CHUNK_DELAY_MS = Number(process.env.GJCM_DEMO_CHUNK_MS ?? 45);

interface DemoSession {
	id: string;
	cwd: string;
	title: string;
	createdAt: string;
	history: { role: "user" | "agent"; text: string }[];
	model: string;
	thinking: string;
}

const sessions = new Map<string, DemoSession>();
const attached = new Set<string>();
const running = new Map<string, () => void>();
const steers = new Map<string, { id: string; text: string; mode: "steer"; label: "Steer" }[]>();
/** Like gjc, each ACP attachment (session/new, session/load) starts at `prompt`. */
const permissionModes = new Map<string, "prompt" | "allow" | "deny">();
const pending = new Map<number, (result: any) => void>();
let nextRequestId = 1;
let nextSteerId = 1;

const MODELS = [
	{ value: "demo/gajae-fast", name: "Gajae Fast (demo)" },
	{ value: "demo/gajae-deep", name: "Gajae Deep (demo)" },
];
const THINKING = ["off", "low", "medium", "high"];

function transcriptFile(id: string) {
	return path.join(sessionsDir, `${id}.jsonl`);
}

/** gjc's saved-session layout (header record first) so the bridge's session list and resume work unchanged. */
function save(session: DemoSession) {
	const header = { type: "session", version: 5, id: session.id, timestamp: session.createdAt, cwd: session.cwd, title: session.title };
	const body = session.history.map(h => JSON.stringify({ type: "message", role: h.role, text: h.text }));
	fs.writeFileSync(transcriptFile(session.id), `${[JSON.stringify(header), ...body].join("\n")}\n`);
}

function load(id: string): DemoSession | undefined {
	const cached = sessions.get(id);
	if (cached) return cached;
	const file = transcriptFile(id);
	if (!fs.existsSync(file)) return undefined;
	const [head, ...rest] = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
	const session: DemoSession = {
		id,
		cwd: head.cwd,
		title: head.title,
		createdAt: head.timestamp,
		history: rest.filter(r => r.type === "message").map(r => ({ role: r.role, text: r.text })),
		model: MODELS[0].value,
		thinking: "medium",
	};
	sessions.set(id, session);
	return session;
}

function prune() {
	const files = fs
		.readdirSync(sessionsDir)
		.filter(f => f.endsWith(".jsonl"))
		.map(f => ({ f, t: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
		.sort((a, b) => b.t - a.t);
	for (const { f } of files.slice(MAX_SESSIONS)) {
		fs.rmSync(path.join(sessionsDir, f), { force: true });
		sessions.delete(f.replace(/\.jsonl$/, ""));
	}
}

function configOptions(session: DemoSession) {
	return [
		{ id: "model", name: "Model", category: "model", type: "select", currentValue: session.model, options: MODELS },
		{
			id: "thinking",
			name: "Thinking",
			category: "thought_level",
			type: "select",
			currentValue: session.thinking,
			options: THINKING.map(value => ({ value, name: value })),
		},
	];
}

function write(message: unknown) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}
function update(sessionId: string, u: unknown) {
	write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
}
function request(method: string, params: unknown): Promise<any> {
	const id = nextRequestId++;
	write({ jsonrpc: "2.0", id, method, params });
	return new Promise(resolve => pending.set(id, resolve));
}
function phase(sessionId: string, busy: boolean) {
	update(sessionId, { sessionUpdate: "session_info_update", _meta: { gjcPhase: busy ? "working" : "idle", running: busy } });
}

class Cancelled extends Error {}

/** Streams text in small chunks like a model would; a cancel or a waiting steer interrupts between chunks. */
async function stream(session: DemoSession, kind: "agent_message_chunk" | "agent_thought_chunk", text: string, signal: { cancelled: boolean }) {
	const parts = text.match(/.{1,6}/gsu) ?? [];
	let sent = "";
	for (const part of parts) {
		if (signal.cancelled) throw new Cancelled();
		await Bun.sleep(CHUNK_DELAY_MS);
		update(session.id, { sessionUpdate: kind, content: { type: "text", text: part } });
		sent += part;
		// gjc hands a steer to the model at the next step; the demo picks it up at the next chunk boundary.
		const queued = steers.get(session.id);
		if (kind === "agent_message_chunk" && queued?.length) {
			steers.delete(session.id);
			const note = `\n\n↪ 끼어든 지시를 반영합니다: “${queued.map(s => s.text).join(" / ")}”\n데모 에이전트라 지시를 확인했다는 사실만 보여 드립니다.\n`;
			for (const p of note.match(/.{1,6}/gsu) ?? []) {
				await Bun.sleep(CHUNK_DELAY_MS);
				update(session.id, { sessionUpdate: kind, content: { type: "text", text: p } });
			}
			return sent + note;
		}
	}
	return sent;
}

const wantsTool = (text: string) => /명령|실행|파일|목록|테스트|빌드|run|command|file|list|test|build|ls\b/i.test(text);

async function prompt(session: DemoSession, blocks: any[]): Promise<string> {
	const texts = blocks.filter(b => b.type === "text").map(b => String(b.text));
	const images = blocks.filter(b => b.type === "image").length;
	const files = blocks.filter(b => b.type === "resource" || b.type === "resource_link").length;
	const text = texts.join("\n").trim();
	session.history.push({ role: "user", text: text || "(첨부)" });
	if (session.title === "새 데모 세션" && text) session.title = text.slice(0, 40);
	save(session);
	for (const block of blocks) update(session.id, { sessionUpdate: "user_message_chunk", content: block });

	const signal = { cancelled: false };
	running.set(session.id, () => {
		signal.cancelled = true;
	});
	phase(session.id, true);
	try {
		if (session.thinking !== "off") {
			await stream(
				session,
				"agent_thought_chunk",
				`요청을 읽었습니다. 추론 강도는 ${session.thinking}, 모델은 ${session.model}입니다. 이 서버는 심사용 데모라 실제 모델 대신 정해진 흐름을 재생합니다.`,
				signal,
			);
		}
		update(session.id, {
			sessionUpdate: "plan",
			entries: [
				{ content: "요청 확인", priority: "high", status: "completed" },
				{ content: wantsTool(text) ? "호스트에서 명령 실행(승인 필요)" : "답변 작성", priority: "medium", status: "in_progress" },
				{ content: "결과 정리", priority: "low", status: "pending" },
			],
		});
		let toolNote = "";
		if (wantsTool(text)) {
			const toolCall = {
				toolCallId: `demo-${Date.now()}`,
				title: "ls -la ~/demo-project",
				kind: "execute",
				status: "pending",
				rawInput: { command: "ls -la ~/demo-project" },
			};
			update(session.id, { sessionUpdate: "tool_call", ...toolCall });
			const mode = permissionModes.get(session.id) ?? "prompt";
			const res =
				mode === "prompt"
					? await request("session/request_permission", {
							sessionId: session.id,
							toolCall,
							options: [
								{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
								{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
							],
						})
					: { outcome: { outcome: "selected", optionId: mode === "allow" ? "allow_once" : "reject_once" } };
			if (signal.cancelled) throw new Cancelled();
			if (res?.outcome?.outcome === "selected" && res.outcome.optionId === "allow_once") {
				update(session.id, {
					sessionUpdate: "tool_call_update",
					toolCallId: toolCall.toolCallId,
					status: "completed",
					content: [{ type: "content", content: { type: "text", text: "README.md\nsrc/\ntests/\npackage.json\n" } }],
				});
				toolNote = "승인하신 명령을 (데모로) 실행했고, 위에 결과가 표시됩니다.\n\n";
			} else {
				update(session.id, { sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId, status: "failed" });
				toolNote = "명령 실행을 거절하셨으므로 실행하지 않았습니다.\n\n";
			}
		}
		const attachments =
			images || files ? `첨부 ${[images && `이미지 ${images}개`, files && `파일 ${files}개`].filter(Boolean).join(", ")}를 받았습니다.\n\n` : "";
		const answer =
			`${toolNote}${attachments}` +
			`“${text || "첨부"}”에 대한 데모 응답입니다. 실제 사용 시에는 사용자의 컴퓨터에서 실행 중인 가재코드(gjc)가 이 자리에 답변하고, ` +
			"파일 편집이나 명령 실행이 필요하면 지금처럼 휴대폰으로 승인을 요청합니다.\n\n" +
			"This is a scripted demo host for app review. With a real host, Gajae Code running on the user's own computer answers here.\n\n" +
			"시험해 볼 기능:\n• 답변 중 메시지를 보내 끼어들기\n• 우측 상단 메뉴에서 모델·추론 강도 변경\n• “파일 목록 보여줘”로 명령 승인 흐름 확인\n• 사진·파일 첨부";
		const said = await stream(session, "agent_message_chunk", answer, signal);
		session.history.push({ role: "agent", text: said });
		save(session);
		return "end_turn";
	} catch (error) {
		if (error instanceof Cancelled) return "cancelled";
		throw error;
	} finally {
		running.delete(session.id);
		phase(session.id, false);
		prune();
	}
}

function newSession(cwd: string): DemoSession {
	const session: DemoSession = {
		id: crypto.randomUUID(),
		cwd: cwd || "/home/demo/demo-project",
		title: "새 데모 세션",
		createdAt: new Date().toISOString(),
		history: [],
		model: MODELS[0].value,
		thinking: "medium",
	};
	sessions.set(session.id, session);
	attached.add(session.id);
	permissionModes.delete(session.id);
	return session;
}

async function handle(msg: any) {
	const { id, method, params } = msg;
	const reply = (result: unknown) => write({ jsonrpc: "2.0", id, result });
	const fail = (code: number, message: string) => write({ jsonrpc: "2.0", id, error: { code, message } });
	const session = params?.sessionId ? load(params.sessionId) : undefined;
	switch (method) {
		case "initialize":
			return reply({
				protocolVersion: 1,
				agentInfo: { name: "gjc-demo", version: "demo" },
				authMethods: [],
				agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } },
			});
		case "session/new": {
			const created = newSession(params.cwd);
			reply({ sessionId: created.id, configOptions: configOptions(created) });
			phase(created.id, false);
			return;
		}
		case "session/load": {
			if (!session) return fail(-32002, "not found");
			attached.add(session.id);
			permissionModes.delete(session.id);
			for (const h of session.history)
				update(session.id, {
					sessionUpdate: h.role === "user" ? "user_message_chunk" : "agent_message_chunk",
					content: { type: "text", text: h.text },
				});
			return reply({ configOptions: configOptions(session) });
		}
		case "session/fork": {
			if (!session) return fail(-32002, "not found");
			const forked = newSession(params.cwd ?? session.cwd);
			forked.history = [...session.history];
			forked.title = `${session.title} (포크)`;
			save(forked);
			return reply({ sessionId: forked.id, configOptions: configOptions(forked) });
		}
		case "session/delete":
			if (session) {
				sessions.delete(session.id);
				fs.rmSync(transcriptFile(session.id), { force: true });
			}
			return reply({});
		case "session/set_config_option": {
			if (!session || !attached.has(session.id)) return fail(-32603, `Internal error: Unknown session, not found: ${params.sessionId}`);
			if (params.configId === "model" && MODELS.some(m => m.value === params.value)) session.model = params.value;
			else if (params.configId === "thinking" && THINKING.includes(params.value)) session.thinking = params.value;
			else return fail(-32602, `Unsupported value for ${params.configId}`);
			return reply({ configOptions: configOptions(session) });
		}
		case "session/prompt": {
			if (!session) return fail(-32002, "not found");
			return reply({ stopReason: await prompt(session, params.prompt ?? []) });
		}
		case "session/cancel":
			running.get(params.sessionId)?.();
			steers.delete(params.sessionId);
			return;
		case "_gjc/sdk/query": {
			const ok = (items: unknown[]) => reply({ type: "query_response", id: "q", ok: true, page: { items, complete: true } });
			if (params.query === "queue.messages.list") return ok(steers.get(params.sessionId) ?? []);
			if (params.query === "context.get") {
				const chars = (session?.history ?? []).reduce((n, h) => n + h.text.length, 0);
				const tokens = 1800 + Math.round(chars / 2);
				return ok([{ usage: { tokens, contextWindow: 200000, percent: (tokens / 200000) * 100 }, systemPrompt: ["demo"] }]);
			}
			return reply({ type: "query_response", id: "q", ok: false, error: { code: "unsupported", message: `${params.query} is not available on the demo host` } });
		}
		case "_gjc/sdk/control": {
			const op = params.operation;
			if (op === "thinking.set" && session && THINKING.includes(params.input?.level)) {
				session.thinking = params.input.level;
				return reply({ changed: true });
			}
			if (op === "permission_mode.set" && session && ["prompt", "allow", "deny"].includes(params.input?.mode)) {
				permissionModes.set(session.id, params.input.mode);
				return reply({ changed: true, mode: params.input.mode });
			}
			if (op === "model.set" && session && MODELS.some(m => m.value === params.input?.model)) {
				session.model = params.input.model;
				return reply({ changed: true });
			}
			if (op === "turn.steer") {
				const list = steers.get(params.sessionId) ?? [];
				list.push({ id: `steer:${nextSteerId++}`, text: String(params.input?.text ?? ""), mode: "steer", label: "Steer" });
				steers.set(params.sessionId, list);
				return reply({ accepted: true });
			}
			if (op === "turn.btw") {
				// Scripted /btw side chat: answers from nothing but the question and prior exchanges, like the real
				// one never writes to the session history.
				const question = String(params.input?.question ?? "").trim();
				if (!question) return reply({ ok: false, error: { code: "invalid_input", message: "turn.btw requires a non-empty question." } });
				const turns = Array.isArray(params.input?.exchanges) ? params.input.exchanges.length : 0;
				return reply({
					replyText: `데모 사이드 대화 답변입니다(${turns + 1}번째 질문). "${question.slice(0, 60)}"에 대해 실제 호스트에서는 현재 세션의 대화를 참고해 답하고, 이 대화는 세션 기록에 남지 않습니다.`,
				});
			}
			if (op === "queue.message.remove") {
				steers.set(params.sessionId, (steers.get(params.sessionId) ?? []).filter(m => m.id !== params.input?.id));
				return reply({ removed: true });
			}
			if (op === "session.rename" && session && typeof params.input?.name === "string") {
				session.title = params.input.name.slice(0, 80);
				save(session);
				return reply({ renamed: true });
			}
			if (op === "config.patch") {
				// Per-role model choices: kept in the demo's own config.yml, which the bridge reads back.
				const file = path.join(agentDir!, "config.yml");
				const config = fs.existsSync(file) ? ((Bun.YAML.parse(fs.readFileSync(file, "utf8")) as any) ?? {}) : {};
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
			return reply({ ok: false, error: { code: "unsupported", message: `${op} is not available on the demo host` } });
		}
		default:
			if (id !== undefined) fail(-32601, `no ${method}`);
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
		} else void handle(msg).catch(error => msg.id !== undefined && write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(error?.message ?? error) } }));
	}
}
