/**
 * gjc's session CLI raw hatch (`gjc sdk session raw control|query <sessionId> … --json`), the official path for a
 * local machine controller to reach a session's SDK operations that ACP refuses. The bridge uses it for the
 * external permission approval channel (`permission.channel.set`, `permission.requests.list`,
 * `permission.respond`), which gjc 0.19.3 prohibits over ACP ("permission.channel.set is prohibited for ACP.").
 * Each call starts a gjc process: measured 2.2–3.8s on pve3.
 */

export interface SdkCliOptions {
	/** The gjc launcher without `--mode=acp` (see `tuiCommand`). */
	command: string[];
	/** gjc agent dir, so the CLI resolves the session through the same broker as the bridge's ACP process. */
	agentDir: string;
	timeoutMs?: number;
}

export class SdkCliError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class SdkCli {
	readonly #options: SdkCliOptions;

	constructor(options: SdkCliOptions) {
		this.#options = options;
	}

	control(sessionId: string, cwd: string, operation: string, input: unknown): Promise<unknown> {
		return this.#run(cwd, ["control", sessionId, "--op", operation, "--json-input", JSON.stringify(input)]);
	}

	query(sessionId: string, cwd: string, query: string): Promise<unknown> {
		return this.#run(cwd, ["query", sessionId, "--query", query]);
	}

	async #run(cwd: string, args: string[]): Promise<unknown> {
		const proc = Bun.spawn([...this.#options.command, "sdk", "session", "raw", ...args, "--json"], {
			cwd,
			env: { ...process.env, GJC_CODING_AGENT_DIR: this.#options.agentDir },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const timer = setTimeout(() => proc.kill(), this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		try {
			const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
			let response: { ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } } | undefined;
			try {
				response = JSON.parse(stdout.trim());
			} catch {
				// stdout can carry a request's command or file content (`permission.requests.list`): log only its size.
				throw new SdkCliError("cli_failed", `gjc sdk session raw exited ${code} (${stdout.length} bytes of stdout): ${stderr.trim().slice(0, 300)}`);
			}
			if (response?.ok === true) return response.result;
			// A failed operation answers `{ok:false,error}`; a CLI failure is a `gjc.command-error` envelope.
			const error = response?.error ?? (response as { code?: unknown; message?: unknown } | undefined);
			throw new SdkCliError(
				typeof error?.code === "string" ? error.code : "cli_failed",
				typeof error?.message === "string" ? error.message : `gjc sdk session raw exited ${code}`,
			);
		} finally {
			clearTimeout(timer);
		}
	}
}
