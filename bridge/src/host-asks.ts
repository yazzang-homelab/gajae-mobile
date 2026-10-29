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
	const lines = questions.flatMap(q => [q.question, ...q.options.map(o => `  • ${o}`)]);
	lines.push("", "터미널(gjc TUI)에서 답을 기다리는 질문입니다. 답은 터미널에서 고르면 여기에도 표시됩니다.");
	return {
		sessionUpdate: "tool_call",
		toolCallId: ask.toolCallId,
		title: questions.length > 0 ? `ask: ${questions.map(q => q.question).join(" / ")}` : "ask",
		kind: "other",
		status: "pending",
		rawInput: ask.input,
		content: [{ type: "content", content: { type: "text", text: lines.join("\n") } }],
		_meta: { gjcm: { hostAsk: true } },
	};
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
