/**
 * Output speed for the session list ("working · 42 tok/s").
 *
 * The ACP stream carries no token counts and often no text while the model works: with reasoning models the
 * thinking is not streamed, tool-call arguments are not streamed, and the answer can arrive in one burst at the
 * end. Measured on a real turn (bash + 400-character answer, 15 s): visible text appeared only in the last
 * second, so a text-only estimate showed 0 for 14 s while gjc had produced 849 output tokens.
 *
 * So the authoritative count is gjc's own usage (`session.stats` output tokens), which grows once per completed
 * assistant message and includes hidden reasoning and tool arguments. Text streamed since the last usage
 * update is estimated (~4 ASCII characters or ~1.4 Hangul characters per token) so the number moves between
 * messages; the next usage update replaces that estimate. Time spent running tools is not model time and is
 * left out, so the figure is the model's output rate over the turn so far.
 */
export function estimateTokens(text: string): number {
	let ascii = 0;
	let other = 0;
	for (const char of text) {
		if (char.charCodeAt(0) < 0x80) ascii++;
		else other++;
	}
	return ascii / 4 + other * 0.7;
}

interface Turn {
	startedAt: number;
	/** Session output total when the turn started; unknown until the first usage sample. */
	baseline?: number;
	/** Output tokens of this turn per gjc's usage. */
	reported: number;
	/** Estimated tokens of text streamed since the last usage increase. */
	pending: number;
	tools: Set<string>;
	toolSince?: number;
	toolMs: number;
	endedAt?: number;
}

export class Throughput {
	#turn?: Turn;
	#active = false;

	constructor(private readonly now: () => number = Date.now) {}

	get active(): boolean {
		return this.#active;
	}

	start(): void {
		this.#turn = { startedAt: this.now(), reported: 0, pending: 0, tools: new Set(), toolMs: 0 };
		this.#active = true;
	}

	/** Ends the turn. Its figure stays as the idle rate and still takes a final usage sample. */
	finish(): void {
		const turn = this.#turn;
		if (!this.#active || !turn) return;
		this.#closeToolTime(turn);
		turn.tools.clear();
		turn.endedAt = this.now();
		this.#active = false;
	}

	/** gjc's cumulative output tokens for the session (`session.stats`). */
	usage(total: number): void {
		const turn = this.#turn;
		if (!turn) return;
		if (turn.baseline === undefined) {
			turn.baseline = total;
			return;
		}
		const reported = total - turn.baseline;
		if (reported > turn.reported) {
			turn.reported = reported;
			turn.pending = 0;
		}
	}

	add(text: string): void {
		if (!this.#active || !this.#turn) return;
		this.#turn.pending += estimateTokens(text);
	}

	toolStarted(id: string): void {
		const turn = this.#turn;
		if (!this.#active || !turn || turn.tools.has(id)) return;
		if (turn.tools.size === 0) turn.toolSince = this.now();
		turn.tools.add(id);
	}

	toolEnded(id: string): void {
		const turn = this.#turn;
		if (!this.#active || !turn || !turn.tools.delete(id)) return;
		if (turn.tools.size === 0) this.#closeToolTime(turn);
	}

	/** Output tokens per second of model time this turn (running) or over the whole last turn (idle). */
	rate(): number | undefined {
		const turn = this.#turn;
		if (!turn) return undefined;
		const tokens = turn.reported + turn.pending;
		const openToolMs = turn.toolSince === undefined ? 0 : this.now() - turn.toolSince;
		const modelMs = (turn.endedAt ?? this.now()) - turn.startedAt - turn.toolMs - openToolMs;
		if (tokens <= 0) return this.#active ? 0 : undefined;
		// Shorter than a second (down to zero: start and end in the same clock tick) counts as one second.
		return Math.round((tokens / Math.max(modelMs / 1000, 1)) * 10) / 10;
	}

	#closeToolTime(turn: Turn): void {
		if (turn.toolSince === undefined) return;
		turn.toolMs += this.now() - turn.toolSince;
		turn.toolSince = undefined;
	}
}
