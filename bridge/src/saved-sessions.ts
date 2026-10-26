import fs from "node:fs";
import path from "node:path";

/**
 * Lists the sessions gjc has saved on disk (`<agentDir>/sessions/<bucket>/<stamp>_<id>.jsonl`), newest first.
 *
 * gjc's ACP `session/list` cannot back a resume picker: it pages the broker's runtime endpoint index,
 * oldest first. Measured on gjc 0.18.7 on this host, 78 of the first 100 rows had no saved transcript
 * (`session/load` → "Saved ACP session does not exist"), and 837 of 859 saved sessions were missing
 * from it. The saved transcripts are what `/resume` shows in the TUI, so the bridge reads their header
 * line directly (read-only; the first JSONL record is `{"type":"session","id","cwd","title",…}`).
 *
 * A rename or a session move does not rewrite that line: gjc appends `{"type":"header_patch","patch":{…}}`
 * and the latest patch wins (gjc `readSessionListTrailingPatches`). Transcripts only grow, so the patch
 * scan is incremental per file and only runs for the rows a page actually returns, or for every row
 * when a query or cwd filter has to see the patched title/cwd.
 */
export interface SavedSession {
	sessionId: string;
	cwd: string;
	title?: string;
	updatedAt: string;
	bytes: number;
}

export interface SavedSessionPage {
	sessions: SavedSession[];
	nextCursor?: string;
}

const HEADER_PROBE_BYTES = 64 * 1024;
const PATCH_SCAN_CHUNK_BYTES = 1024 * 1024;
const PAGE_SIZE = 50;
const HEADER_PATCH_MARKER = '"header_patch"';

type Header = { sessionId: string; cwd: string; title?: string };

interface CacheEntry {
	mtimeMs: number;
	header: Header | null;
}

/** Latest header patch seen in [0, scannedBytes) of one transcript file (identified by dev+ino). */
interface PatchScan {
	dev: number;
	ino: number;
	scannedBytes: number;
	title?: string;
	cwd?: string;
}

interface FileRow {
	path: string;
	mtimeMs: number;
	size: number;
	dev: number;
	ino: number;
}

export class SavedSessionIndex {
	readonly #root: string;
	readonly #cache = new Map<string, CacheEntry>();
	readonly #patches = new Map<string, PatchScan>();

	constructor(agentDir: string) {
		this.#root = path.join(agentDir, "sessions");
	}

	list(params: { cwd?: string; query?: string; cursor?: string; limit?: number } = {}): SavedSessionPage {
		const limit = Math.min(Math.max(params.limit ?? PAGE_SIZE, 1), 200);
		const offset = params.cursor ? Number.parseInt(params.cursor, 10) || 0 : 0;
		const needle = params.query?.trim().toLowerCase();
		const filtered = Boolean(needle || params.cwd);
		const rows: { file: FileRow; header: Header }[] = [];
		const seen = new Set<string>();
		for (const file of this.#files()) {
			const first = this.#header(file.path, file.mtimeMs);
			if (!first || seen.has(first.sessionId)) continue;
			const header = filtered ? this.#patched(file, first) : first;
			if (params.cwd && header.cwd !== params.cwd) continue;
			if (needle && !`${header.title ?? ""}\n${header.cwd}\n${header.sessionId}`.toLowerCase().includes(needle)) continue;
			seen.add(header.sessionId);
			rows.push({ file, header });
		}
		const sessions = rows.slice(offset, offset + limit).map(({ file, header }) => ({
			...(filtered ? header : this.#patched(file, header)),
			updatedAt: new Date(file.mtimeMs).toISOString(),
			bytes: file.size,
		}));
		return offset + limit < rows.length ? { sessions, nextCursor: String(offset + limit) } : { sessions };
	}

	find(sessionId: string): SavedSession | undefined {
		for (const file of this.#files()) {
			const header = this.#header(file.path, file.mtimeMs);
			if (header?.sessionId !== sessionId) continue;
			return { ...this.#patched(file, header), updatedAt: new Date(file.mtimeMs).toISOString(), bytes: file.size };
		}
		return undefined;
	}

	ids(): Set<string> {
		const ids = new Set<string>();
		for (const file of this.#files()) {
			const header = this.#header(file.path, file.mtimeMs);
			if (header) ids.add(header.sessionId);
		}
		return ids;
	}

	#files(): FileRow[] {
		const out: FileRow[] = [];
		let buckets: fs.Dirent[];
		try {
			buckets = fs.readdirSync(this.#root, { withFileTypes: true });
		} catch {
			return out;
		}
		for (const bucket of buckets) {
			if (!bucket.isDirectory()) continue;
			const dir = path.join(this.#root, bucket.name);
			let names: string[];
			try {
				names = fs.readdirSync(dir);
			} catch {
				continue;
			}
			for (const name of names) {
				if (!name.endsWith(".jsonl")) continue;
				const file = path.join(dir, name);
				try {
					const stat = fs.statSync(file);
					// A session created but never prompted leaves an empty transcript that gjc cannot resume.
					if (stat.isFile() && stat.size > 0)
						out.push({ path: file, mtimeMs: stat.mtimeMs, size: stat.size, dev: stat.dev, ino: stat.ino });
				} catch {}
			}
		}
		return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	}

	#header(file: string, mtimeMs: number): CacheEntry["header"] {
		const cached = this.#cache.get(file);
		if (cached && cached.mtimeMs === mtimeMs) return cached.header;
		let header: CacheEntry["header"] = null;
		try {
			const fd = fs.openSync(file, "r");
			try {
				const buffer = Buffer.alloc(HEADER_PROBE_BYTES);
				const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
				const text = buffer.subarray(0, read).toString("utf8");
				const newline = text.indexOf("\n");
				const record = JSON.parse(newline >= 0 ? text.slice(0, newline) : text);
				if (record?.type === "session" && typeof record.id === "string" && typeof record.cwd === "string") {
					header = {
						sessionId: record.id,
						cwd: record.cwd,
						...(typeof record.title === "string" && record.title ? { title: record.title } : {}),
					};
				}
			} finally {
				fs.closeSync(fd);
			}
		} catch {}
		this.#cache.set(file, { mtimeMs, header });
		return header;
	}

	/** `header` with the transcript's latest `header_patch` title/cwd applied. */
	#patched(file: FileRow, header: Header): Header {
		const scan = this.#scanPatches(file);
		if (!scan.title && !scan.cwd) return header;
		return { ...header, ...(scan.cwd ? { cwd: scan.cwd } : {}), ...(scan.title ? { title: scan.title } : {}) };
	}

	#scanPatches(file: FileRow): PatchScan {
		let scan = this.#patches.get(file.path);
		// A different inode or a shorter file means gjc rewrote the transcript: start over.
		if (!scan || scan.dev !== file.dev || scan.ino !== file.ino || scan.scannedBytes > file.size) {
			scan = { dev: file.dev, ino: file.ino, scannedBytes: 0 };
			this.#patches.set(file.path, scan);
		}
		if (scan.scannedBytes >= file.size) return scan;
		let fd: number;
		try {
			fd = fs.openSync(file.path, "r");
		} catch {
			return scan;
		}
		try {
			const buffer = Buffer.alloc(PATCH_SCAN_CHUNK_BYTES);
			let carry = Buffer.alloc(0);
			let position = scan.scannedBytes;
			while (position < file.size) {
				const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, file.size - position), position);
				if (read <= 0) break;
				position += read;
				const chunk = carry.length ? Buffer.concat([carry, buffer.subarray(0, read)]) : buffer.subarray(0, read);
				const lastNewline = chunk.lastIndexOf(0x0a);
				if (lastNewline < 0) {
					carry = Buffer.from(chunk);
					continue;
				}
				applyPatchLines(scan, chunk.subarray(0, lastNewline));
				// Only complete lines count as scanned; a line still being written is re-read next time.
				scan.scannedBytes = position - (chunk.length - lastNewline - 1);
				carry = Buffer.from(chunk.subarray(lastNewline + 1));
			}
		} catch {
		} finally {
			fs.closeSync(fd);
		}
		return scan;
	}
}

function applyPatchLines(scan: PatchScan, lines: Buffer): void {
	if (!lines.includes(HEADER_PATCH_MARKER)) return;
	for (const line of lines.toString("utf8").split("\n")) {
		if (!line.includes(HEADER_PATCH_MARKER)) continue;
		try {
			const record = JSON.parse(line);
			if (record?.type !== "header_patch" || typeof record.patch !== "object" || !record.patch) continue;
			if (typeof record.patch.title === "string" && record.patch.title) scan.title = record.patch.title;
			if (typeof record.patch.cwd === "string" && record.patch.cwd) scan.cwd = record.patch.cwd;
		} catch {
			// gjc ignores malformed or partial patch records too.
		}
	}
}
