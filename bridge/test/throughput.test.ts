import { expect, test } from "bun:test";
import { outputTokens } from "../src/hub";
import { estimateTokens, Throughput } from "../src/throughput";

test("token estimate weighs ASCII at ~4 chars/token and Hangul at ~0.7 tokens/char", () => {
	expect(estimateTokens("abcdefgh")).toBe(2);
	expect(estimateTokens("가나")).toBeCloseTo(1.4);
	expect(estimateTokens("")).toBe(0);
});

test("gjc usage drives the rate even when no text streams (hidden reasoning, tool arguments)", () => {
	let now = 0;
	const meter = new Throughput(() => now);
	expect(meter.rate()).toBeUndefined();
	meter.usage(500); // before any turn: ignored
	meter.start();
	meter.usage(1000); // baseline: the session's total before this turn
	now = 5000;
	expect(meter.rate()).toBe(0); // reasoning, nothing streamed or reported yet
	meter.usage(1100); // first message (a tool call) completed: 100 tokens, no text at all
	expect(meter.rate()).toBe(20);
	meter.toolStarted("t1");
	now = 8000; // 3 s of tool execution is not model time
	expect(meter.rate()).toBe(20);
	meter.toolEnded("t1");
	now = 10_000;
	expect(meter.rate()).toBe(14.3); // 100 tokens / 7 s of model time
	meter.add("a".repeat(400)); // answer streaming: ~100 estimated tokens
	expect(meter.rate()).toBe(28.6);
	meter.usage(1250); // the real count replaces the estimate
	expect(meter.rate()).toBe(35.7);
	now = 12_000;
	meter.finish();
	expect(meter.active).toBe(false);
	meter.usage(1450); // final sample after turn end: the last message's real size
	now = 60_000; // idle time does not dilute the last turn's figure
	expect(meter.rate()).toBe(50); // 450 tokens / 9 s of model time
	meter.add("ignored while idle");
	meter.toolStarted("ignored");
	expect(meter.rate()).toBe(50);
});

test("without usage (older gjc, session not open here) the text estimate still counts", () => {
	let now = 0;
	const meter = new Throughput(() => now);
	meter.start();
	now = 2000;
	meter.add("a".repeat(80)); // 20 tokens
	expect(meter.rate()).toBe(10);
	meter.finish();
	expect(meter.rate()).toBe(10);
	meter.start();
	expect(meter.rate()).toBe(0); // a new turn starts from zero, not the previous figure
});

test("a turn that produced output within one clock tick still reports a rate", () => {
	const meter = new Throughput(() => 1000); // start and finish land in the same millisecond
	meter.start();
	meter.add("a".repeat(40)); // 10 tokens
	meter.finish();
	expect(meter.rate()).toBe(10); // the 1 s floor, as for any turn shorter than a second
});

test("a tool still running at turn end stops counting as tool time", () => {
	let now = 0;
	const meter = new Throughput(() => now);
	meter.start();
	meter.usage(0);
	now = 1000;
	meter.toolStarted("t");
	now = 4000;
	meter.usage(30);
	meter.finish(); // cancelled mid-tool
	now = 9000;
	expect(meter.rate()).toBe(30); // 30 tokens / 1 s of model time
});

test("output tokens sum the session.stats items", () => {
	expect(outputTokens({ items: [{ input: 6, output: 849, cacheRead: 269731 }], complete: true })).toBe(849);
	expect(outputTokens({ items: [{ output: 10 }, { output: 5 }, { input: 3 }] })).toBe(15);
	expect(outputTokens({ items: [{ input: 3 }] })).toBeUndefined();
	expect(outputTokens({})).toBeUndefined();
	expect(outputTokens(null)).toBeUndefined();
});
