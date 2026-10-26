/**
 * Chunked file uploads from the phone (non-image attachments).
 * Images travel inline as ACP `image` blocks; every other file lands on the host under
 * <GJCM_HOME>/uploads/<sessionId>/ and is referenced from the prompt as an ACP `resource_link`
 * (`file://` URI) that gjc reads with its own tools — the same approach gajae-app takes with
 * its assets directory, but integrity-checked and bounded.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AcpError } from "./acp";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const CHUNK_BYTES = 512 * 1024;
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

interface ActiveUpload {
	id: string;
	sessionId: string;
	name: string;
	mimeType: string;
	size: number;
	sha256: string;
	received: number;
	tmpPath: string;
	finalPath: string;
	hash: crypto.Hash;
	ownerId: string;
}

export function safeFileName(name: string): string {
	const base = path.basename(name.normalize("NFC")).replace(/[\u0000-\u001f/\\:*?"<>|]/g, "_").trim();
	const cleaned = base.replace(/^\.+/, "").slice(0, 120);
	return cleaned || "file";
}

export class UploadStore {
	#root: string;
	#active = new Map<string, ActiveUpload>();

	constructor(root: string) {
		this.#root = root;
	}

	begin(ownerId: string, params: { sessionId: string; name: string; size: number; mimeType?: string; sha256: string }) {
		if (!SESSION_ID.test(params.sessionId)) throw new AcpError(-32602, "invalid sessionId");
		if (!Number.isSafeInteger(params.size) || params.size <= 0) throw new AcpError(-32602, "size must be a positive integer");
		if (params.size > MAX_UPLOAD_BYTES) throw new AcpError(-32010, `file exceeds ${MAX_UPLOAD_BYTES} bytes`);
		if (!/^[a-f0-9]{64}$/.test(params.sha256)) throw new AcpError(-32602, "sha256 must be lowercase hex");
		const dir = path.join(this.#root, params.sessionId);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const id = crypto.randomUUID();
		const fileName = `${id.slice(0, 8)}-${safeFileName(params.name)}`;
		const upload: ActiveUpload = {
			id,
			ownerId,
			sessionId: params.sessionId,
			name: params.name,
			mimeType: params.mimeType || "application/octet-stream",
			size: params.size,
			sha256: params.sha256,
			received: 0,
			tmpPath: path.join(dir, `.${fileName}.part`),
			finalPath: path.join(dir, fileName),
			hash: crypto.createHash("sha256"),
		};
		fs.writeFileSync(upload.tmpPath, new Uint8Array(), { mode: 0o600 });
		this.#active.set(id, upload);
		return { uploadId: id, chunkBytes: CHUNK_BYTES };
	}

	chunk(ownerId: string, params: { uploadId: string; offset: number; data: string }) {
		const upload = this.#owned(ownerId, params.uploadId);
		if (params.offset !== upload.received) throw new AcpError(-32011, `expected offset ${upload.received}`);
		const bytes = Buffer.from(params.data, "base64");
		if (bytes.length === 0 || bytes.length > CHUNK_BYTES) throw new AcpError(-32602, "chunk size out of range");
		if (upload.received + bytes.length > upload.size) throw new AcpError(-32012, "chunk exceeds declared size");
		fs.appendFileSync(upload.tmpPath, bytes);
		upload.hash.update(bytes);
		upload.received += bytes.length;
		return { received: upload.received };
	}

	commit(ownerId: string, params: { uploadId: string }) {
		const upload = this.#owned(ownerId, params.uploadId);
		this.#active.delete(upload.id);
		const digest = upload.hash.digest("hex");
		if (upload.received !== upload.size || digest !== upload.sha256) {
			fs.rmSync(upload.tmpPath, { force: true });
			throw new AcpError(-32013, "upload incomplete or sha256 mismatch");
		}
		fs.renameSync(upload.tmpPath, upload.finalPath);
		return {
			uri: pathToFileURL(upload.finalPath).href,
			path: upload.finalPath,
			name: upload.name,
			mimeType: upload.mimeType,
			size: upload.size,
		};
	}

	abortOwner(ownerId: string): void {
		for (const upload of this.#active.values()) {
			if (upload.ownerId !== ownerId) continue;
			fs.rmSync(upload.tmpPath, { force: true });
			this.#active.delete(upload.id);
		}
	}

	#owned(ownerId: string, uploadId: string): ActiveUpload {
		const upload = this.#active.get(uploadId);
		if (!upload || upload.ownerId !== ownerId) throw new AcpError(-32014, "unknown upload");
		return upload;
	}
}
