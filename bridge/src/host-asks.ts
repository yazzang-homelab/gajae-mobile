/**
 * Asks a turn typed in the TUI is waiting on, read from the session transcript.
 *
 * gjc keeps a CLI-hosted turn's tool calls to its own host: its ACP adapter attaches observers without the
 * permission/UI providers, so while the TUI owns the turn the bridge gets only `session_info_update`
 * (`running: true`) — no `tool_call` for the `ask`, no `session/request_permission`. Measured on gjc 0.19.0
 * 2026-10-26 with an `ask` pending in the TUI: `workflow.gates.list` was empty and `ask.answer` answered
 * "ask.answer is unavailable without an installed session seam". The transcript is the one place the pending
 * ask shows: an assistant message whose `ask` tool call has no `toolResult` yet; the answer lands as that
 * `toolResult` once the user picks an option in the terminal.
 */
import fs from "node:fs";

/** The tail read per scan; an assistant message (thinking signatures included) stays well below this. */
const TAIL_BYTES = 1024 * 1024;

export interface TranscriptAsk {
	toolCallId: string;
	input: unknown;
}

export interface TranscriptAskResult {
	text: string;
	isError: boolean;
}

export interface TranscriptAskScan {
	/** `ask` tool calls in the tail without a `toolResult`, oldest first. */
	pending: TranscriptAsk[];
	/** `toolResult` records in the tail by tool call id. */
	results: Map<string, TranscriptAskResult>;
}

export function scanTranscriptAsks(file: string, tailBytes = TAIL_BYTES): TranscriptAskScan | undefined {
	let text: string;
	let partialHead: boolean;
	try {
		const fd = fs.openSync(file, "r");
		try {
			const size = fs.fstatSync(fd).size;
			const start = Math.max(0, size - tailBytes);
			const buffer = Buffer.alloc(size - start);
			const read = fs.readSync(fd, buffer, 0, buffer.length, start);
			text = buffer.subarray(0, read).toString("utf8");
			partialHead = start > 0;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
	const lines = text.split("\n");
	// The first line of a tail window is cut; the last one is still being written unless it ends in a newline.
	if (partialHead) lines.shift();
	lines.pop();
	const pending = new Map<string, unknown>();
	const results = new Map<string, TranscriptAskResult>();
	for (const line of lines) {
		if (!line.includes('"message"')) continue;
		let record: any;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		const message = record?.type === "message" ? record.message : undefined;
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block?.type === "toolCall" && block.name === "ask" && typeof block.id === "string")
					pending.set(block.id, block.arguments);
			}
		} else if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
			pending.delete(message.toolCallId);
			const content = Array.isArray(message.content) ? message.content : [];
			results.set(message.toolCallId, {
				text: content
					.filter((c: any) => c?.type === "text" && typeof c.text === "string")
					.map((c: any) => c.text)
					.join("\n"),
				isError: message.isError === true,
			});
		}
	}
	return { pending: [...pending].map(([toolCallId, input]) => ({ toolCallId, input })), results };
}

/** The `tool_call` the phone renders for an ask waiting in the TUI (same id gjc uses when it replays the session). */
export function hostAskToolCall(ask: TranscriptAsk): Record<string, unknown> {
	const questions = askQuestions(ask.input);
	return {
		sessionUpdate: "tool_call",
		toolCallId: ask.toolCallId,
		title: questions.length > 0 ? `ask: ${questions.map(q => q.question).join(" / ")}` : "ask",
		kind: "other",
		status: "pending",
		rawInput: ask.input,
		content: terminalAskContent(questions),
		_meta: { gjcm: { hostAsk: true } },
	};
}

/**
 * An `ask` of a turn the phone started in a session the TUI hosts (a tmux window, see tmux.ts). gjc puts the
 * question up in the terminal and sends the phone only a bare `tool_call` (measured on 0.19.3: no
 * `session/request_permission`, `workflow.gates.list` empty), so the phone gets the question, the options, and
 * where to answer. Other updates pass through unchanged.
 */
export function terminalAsk(update: Record<string, unknown>): Record<string, unknown> {
	if (update.sessionUpdate !== "tool_call") return update;
	const questions = askQuestions(update.rawInput);
	if (questions.length === 0) return update;
	const meta = (update._meta as Record<string, unknown> | undefined) ?? {};
	return { ...update, content: terminalAskContent(questions), _meta: { ...meta, gjcm: { hostAsk: true } } };
}

function terminalAskContent(questions: { question: string; options: string[] }[]): unknown[] {
	const lines = questions.flatMap(q => [q.question, ...q.options.map(o => `  • ${o}`)]);
	lines.push("", "터미널(gjc TUI)에서 답을 기다리는 질문입니다. 답은 터미널에서 고르면 여기에도 표시됩니다.");
	return [{ type: "content", content: { type: "text", text: lines.join("\n") } }];
}

export function hostAskSettled(toolCallId: string, result: TranscriptAskResult | undefined): Record<string, unknown> {
	const text = result?.text || "답을 받기 전에 터미널의 턴이 끝났습니다.";
	return {
		sessionUpdate: "tool_call_update",
		toolCallId,
		status: result && !result.isError ? "completed" : "failed",
		content: [{ type: "content", content: { type: "text", text } }],
	};
}

function askQuestions(input: unknown): { question: string; options: string[] }[] {
	const questions = (input as { questions?: unknown } | undefined)?.questions;
	if (!Array.isArray(questions)) return [];
	return questions
		.filter(q => typeof q?.question === "string")
		.map(q => ({
			question: q.question as string,
			options: Array.isArray(q.options) ? q.options.map((o: any) => o?.label).filter((l: unknown) => typeof l === "string") : [],
		}));
}

/**
 * One pending ask from gjc's `ask.requests.list` (Q34, gajae-code#7611; newer than 0.19.3), the session-owned view of a
 * question the TUI shows, answered with `ask.answer` (C06). Fields used here; the rest (answerSchema, editor) is for
 * free-text interactions a permission card cannot take.
 */
export interface RemoteAskRequest {
	id: string;
	/** Stable across toggles and selector/editor transitions of one question (the contract's card identity). */
	questionId?: string;
	sessionId?: string;
	question: string;
	options: string[];
	interaction: string;
	multi?: boolean;
	selectedOptions?: string[];
	recommendedIndex?: number;
	transitionCount?: number;
	controls: Array<{ id: string; label: string; enabled: boolean }>;
}

export type RemoteAskAnswer = { kind: "value"; value: string } | { kind: "control"; controlId: string };

export interface RemoteAskCard {
	options: Array<{ optionId: string; name: string; kind: string }>;
	answers: Map<string, RemoteAskAnswer>;
}

export function remoteAskRequests(result: unknown): RemoteAskRequest[] {
	const items = (result as { page?: { items?: unknown } } | undefined)?.page?.items;
	if (!Array.isArray(items)) return [];
	return items.flatMap(item => {
		if (typeof item?.id !== "string" || typeof item.question !== "string" || typeof item.interaction !== "string") return [];
		if (!Array.isArray(item.options) || !item.options.every((o: unknown) => typeof o === "string")) return [];
		const controls = Array.isArray(item.controls)
			? item.controls.filter((c: any) => typeof c?.id === "string" && typeof c.label === "string").map((c: any) => ({ id: c.id, label: c.label, enabled: c.enabled === true }))
			: [];
		return [
			{
				id: item.id,
				questionId: typeof item.questionId === "string" ? item.questionId : undefined,
				sessionId: typeof item.sessionId === "string" ? item.sessionId : undefined,
				question: item.question,
				options: item.options,
				interaction: item.interaction,
				multi: item.multi === true,
				selectedOptions: Array.isArray(item.selectedOptions) ? item.selectedOptions.filter((o: unknown) => typeof o === "string") : undefined,
				recommendedIndex: typeof item.recommendedIndex === "number" ? item.recommendedIndex : undefined,
				transitionCount: typeof item.transitionCount === "number" ? item.transitionCount : undefined,
				controls,
			},
		];
	});
}

/**
 * The permission card for one pending ask, built the way gjc itself bridges a headless session's asks to an ACP client
 * (`createSdkPermissionAskAnswerSource`, sdk/bus): selector interactions only; the trailing "Other"/clarification
 * entries (`transitionCount`) dropped, since they open a text editor a card cannot fill; multi-select options marked
 * `[x]`/`[ ]` (picking one toggles it, and the next listing carries the new state) with the enabled controls (Next,
 * Done) as further options. None for a text editor, or when nothing is left to pick.
 */
export function remoteAskCard(request: RemoteAskRequest): RemoteAskCard | undefined {
	if (request.interaction !== "selector") return undefined;
	const transitions = request.transitionCount && request.transitionCount > 0 ? Math.min(request.transitionCount, request.options.length) : 0;
	const picks = request.options.slice(0, request.options.length - transitions);
	const controls = request.controls.filter(c => c.enabled);
	if (picks.length === 0 && controls.length === 0) return undefined;
	// Marked from the first card of a multi-select, so it reads as one to toggle before anything is picked.
	const marked = request.multi === true || (request.selectedOptions !== undefined && request.selectedOptions.length > 0);
	const recommended = request.recommendedIndex !== undefined && request.recommendedIndex >= 0 ? picks[request.recommendedIndex] : undefined;
	const answers = new Map<string, RemoteAskAnswer>();
	const options = picks.map((label, index) => {
		const optionId = `option:${index}`;
		answers.set(optionId, { kind: "value", value: label });
		const name = marked ? `${request.selectedOptions?.includes(label) ? "[x] " : "[ ] "}${label}` : label;
		return { optionId, name: label === recommended ? `${name} (추천)` : name, kind: "allow_once" };
	});
	for (const control of controls) {
		const optionId = `control:${control.id}`;
		answers.set(optionId, { kind: "control", controlId: control.id });
		options.push({ optionId, name: control.label, kind: "allow_once" });
	}
	return { options, answers };
}
