/**
 * JSON-RPC 2.0 client for `gjc --mode=acp` over newline-delimited stdio.
 * The bridge advertises no fs/terminal capabilities, so gjc runs every tool itself on the host;
 * the only agent→client request it sends is `session/request_permission`.
 */
import type { Subprocess } from "bun";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface AcpHandlers {
	onNotification(method: string, params: any): void;
	/** Agent→client request. Resolve with the JSON-RPC result. */
	onRequest(method: string, params: any): Promise<unknown>;
	onExit(code: number | null): void;
}

export interface AcpSpawnOptions {
	command: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
}

export class AcpError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
	}
}

const STDERR_DRAIN_MS = 500;
/** Keeps the whole message inside the bridge's 300-char rpc failure log line. */
const EXIT_REASON_CHARS = 240;

/** "gjc ACP process exited (code 1): <stderr tail>", so a failed start says why in the bridge log and on the phone. */
export function exitMessage(code: number | null, stderrTail: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes from gjc's stderr
	const reason = stderrTail.replace(/\x1b\[[0-9;]*m/g, "").trim().replace(/\s*\n\s*/g, " | ").slice(-EXIT_REASON_CHARS);
	return `gjc ACP process exited (code ${code ?? "signal"})${reason ? `: ${reason}` : ""}`;
}

export class AcpProcess {
	#proc: Subprocess<"pipe", "pipe", "pipe">;
	#nextId = 1;
	#pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
	#handlers: AcpHandlers;
	#closed = false;
	stderrTail = "";

	constructor(options: AcpSpawnOptions, handlers: AcpHandlers) {
		this.#handlers = handlers;
		this.#proc = Bun.spawn(options.command, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		void this.#readStdout();
		const stderrDrained = this.#readStderr().catch(() => {});
		void this.#proc.exited.then(async code => {
			// gjc's last stderr lines say why it died; let them land, but never wait on a pipe that a
			// detached child (the SDK broker) may still hold open.
			await Promise.race([stderrDrained, Bun.sleep(STDERR_DRAIN_MS)]);
			this.#closed = true;
			const error = new AcpError(-32000, exitMessage(code, this.stderrTail));
			for (const p of this.#pending.values()) p.reject(error);
			this.#pending.clear();
			this.#handlers.onExit(code);
		});
	}

	get closed(): boolean {
		return this.#closed;
	}

	request<T = any>(method: string, params: unknown): Promise<T> {
		if (this.#closed) return Promise.reject(new AcpError(-32000, "gjc ACP process is not running"));
		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (!this.#closed) this.#write({ jsonrpc: "2.0", method, params });
	}

	kill(): void {
		this.#proc.kill();
	}

	#write(message: unknown): void {
		this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
		this.#proc.stdin.flush();
	}

	async #readStdout(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of this.#proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) this.#dispatch(line);
				newline = buffer.indexOf("\n");
			}
		}
	}

	async #readStderr(): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of this.#proc.stderr) {
			this.stderrTail = (this.stderrTail + decoder.decode(chunk, { stream: true })).slice(-8192);
		}
	}

	#dispatch(line: string): void {
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			return; // gjc only writes JSON-RPC on stdout; ignore anything else defensively
		}
		if (message.method !== undefined && message.id !== undefined) {
			const id = message.id;
			this.#handlers.onRequest(message.method, message.params).then(
				result => this.#write({ jsonrpc: "2.0", id, result }),
				error =>
					this.#write({
						jsonrpc: "2.0",
						id,
						error: { code: error instanceof AcpError ? error.code : -32603, message: String(error?.message ?? error) },
					}),
			);
			return;
		}
		if (message.method !== undefined) {
			this.#handlers.onNotification(message.method, message.params);
			return;
		}
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		if (message.error) pending.reject(new AcpError(message.error.code, message.error.message, message.error.data));
		else pending.resolve(message.result);
	}
}
