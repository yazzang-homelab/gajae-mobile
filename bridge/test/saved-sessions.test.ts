import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SavedSessionIndex } from "../src/saved-sessions";

function agentDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjcm-saved-"));
	fs.mkdirSync(path.join(dir, "sessions", "v2-a"), { recursive: true });
	fs.mkdirSync(path.join(dir, "sessions", "v2-b"), { recursive: true });
	return dir;
}
function write(dir: string, bucket: string, id: string, header: object | string, mtimeSec: number) {
	const file = path.join(dir, "sessions", bucket, `2026-10-21T00-00-00-000Z_${id}.jsonl`);
	fs.writeFileSync(file, typeof header === "string" ? header : `${JSON.stringify(header)}\n{"type":"message"}\n`);
	fs.utimesSync(file, mtimeSec, mtimeSec);
}

describe("saved session index", () => {
	test("newest first across buckets; empty, non-session and foreign files are skipped", () => {
		const dir = agentDir();
		write(dir, "v2-a", "old", { type: "session", id: "old", cwd: "/w", title: "오래된 세션" }, 1_000);
		write(dir, "v2-b", "new", { type: "session", id: "new", cwd: "/x" }, 3_000);
		write(dir, "v2-a", "mid", { type: "session", id: "mid", cwd: "/w", title: "" }, 2_000);
		write(dir, "v2-a", "empty", "", 4_000);
		write(dir, "v2-a", "junk", "not json\n", 5_000);
		write(dir, "v2-a", "other", { type: "message", id: "other", cwd: "/w" }, 6_000);
		fs.writeFileSync(path.join(dir, "sessions", "v2-a", "notes.txt"), "x");
		const index = new SavedSessionIndex(dir);
		const { sessions, nextCursor } = index.list();
		expect(sessions.map(s => s.sessionId)).toEqual(["new", "mid", "old"]);
		expect(sessions[2]).toMatchObject({ cwd: "/w", title: "오래된 세션", updatedAt: new Date(1_000_000).toISOString() });
		expect("title" in sessions[1]).toBe(false);
		expect(nextCursor).toBeUndefined();
	});

	test("filters by cwd and query, pages with an offset cursor, and resolves one id", () => {
		const dir = agentDir();
		for (let i = 0; i < 5; i++) write(dir, "v2-a", `s${i}`, { type: "session", id: `s${i}`, cwd: i % 2 ? "/odd" : "/even", title: `작업 ${i}` }, 1_000 + i);
		const index = new SavedSessionIndex(dir);
		expect(index.list({ cwd: "/odd" }).sessions.map(s => s.sessionId)).toEqual(["s3", "s1"]);
		expect(index.list({ query: "작업 2" }).sessions.map(s => s.sessionId)).toEqual(["s2"]);
		const first = index.list({ limit: 2 });
		expect(first.sessions.map(s => s.sessionId)).toEqual(["s4", "s3"]);
		expect(first.nextCursor).toBe("2");
		const last = index.list({ limit: 2, cursor: "4" });
		expect(last.sessions.map(s => s.sessionId)).toEqual(["s0"]);
		expect(last.nextCursor).toBeUndefined();
		expect(index.find("s1")?.cwd).toBe("/odd");
		expect(index.find("missing")).toBeUndefined();
	});

	test("a rewritten header (new title) is picked up when the file mtime changes", () => {
		const dir = agentDir();
		write(dir, "v2-a", "t", { type: "session", id: "t", cwd: "/w", title: "처음" }, 1_000);
		const index = new SavedSessionIndex(dir);
		expect(index.list().sessions[0].title).toBe("처음");
		write(dir, "v2-a", "t", { type: "session", id: "t", cwd: "/w", title: "바뀜" }, 2_000);
		expect(index.list().sessions[0].title).toBe("바뀜");
	});

	test("renames and moves appended as header_patch records win over the header line, latest first", () => {
		const dir = agentDir();
		write(dir, "v2-a", "r", { type: "session", id: "r", cwd: "/w", title: "자동 제목" }, 1_000);
		write(dir, "v2-a", "q", { type: "session", id: "q", cwd: "/w" }, 500);
		const file = path.join(dir, "sessions", "v2-a", "2026-10-21T00-00-00-000Z_r.jsonl");
		const append = (text: string, mtimeSec: number) => {
			fs.appendFileSync(file, text);
			fs.utimesSync(file, mtimeSec, mtimeSec);
		};
		const index = new SavedSessionIndex(dir);
		expect(index.list().sessions[0].title).toBe("자동 제목");

		append(`${JSON.stringify({ type: "header_patch", patch: { title: "폰에서 바꾼 이름", titleSource: "user" } })}\n{"type":"message"}\n`, 2_000);
		expect(index.list().sessions[0].title).toBe("폰에서 바꾼 이름");
		expect(index.find("r")?.title).toBe("폰에서 바꾼 이름");
		expect(index.list({ query: "폰에서" }).sessions.map(s => s.sessionId)).toEqual(["r"]);

		// Incremental: only the appended bytes are scanned, and a half-written line is re-read later.
		const half = JSON.stringify({ type: "header_patch", patch: { title: "두 번째", cwd: "/moved" } });
		append(half.slice(0, 20), 3_000);
		expect(index.list().sessions[0].title).toBe("폰에서 바꾼 이름");
		append(`${half.slice(20)}\n${JSON.stringify({ type: "header_patch", patch: { starred: true } })}\n`, 4_000);
		expect(index.list().sessions[0]).toMatchObject({ title: "두 번째", cwd: "/moved" });
		expect(index.list({ cwd: "/moved" }).sessions.map(s => s.sessionId)).toEqual(["r"]);
		expect(index.list({ cwd: "/w" }).sessions.map(s => s.sessionId)).toEqual(["q"]);

		// A rewrite (new inode) without the patch drops the stale patched title.
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify({ type: "session", id: "r", cwd: "/w", title: "재작성" })}\n`);
		fs.renameSync(tmp, file);
		fs.utimesSync(file, 5_000, 5_000);
		expect(index.list().sessions[0]).toMatchObject({ title: "재작성", cwd: "/w" });
	});

	test("a missing sessions dir lists nothing", () => {
		expect(new SavedSessionIndex("/nonexistent/gjc").list()).toEqual({ sessions: [] });
	});
});
