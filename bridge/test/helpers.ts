import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeClient } from "../src/client";
import { CODE_ATTEMPTS } from "../src/code-pairing";
import { generateKeyPair } from "../src/crypto";
import { encodeCode } from "../src/device-code";
import { buildOffer, type PairingOffer } from "../src/offer";
import { BridgeState } from "../src/state";

export const FAKE_AGENT = [process.execPath, path.join(import.meta.dir, "fake-acp-agent.ts")];
export const DEMO_AGENT = [process.execPath, path.join(import.meta.dir, "..", "demo", "demo-agent.ts")];

function isFakeAgent(command: string[]): boolean {
	return command.includes(FAKE_AGENT[1]) || command.includes(DEMO_AGENT[1]);
}

/** Starts a bridge in a child process (see serve-fixture.ts) sharing a temp GJCM_HOME with the test. */
export async function startTestBridge(command: string[] = FAKE_AGENT, cwd = os.tmpdir(), env: Record<string, string> = {}) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjcm-test-"));
	const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "serve-fixture.ts")], {
		env: {
			...process.env,
			GJCM_HOME: home,
			GJCM_TEST_AGENT: JSON.stringify(command),
			GJCM_TEST_CWD: cwd,
			FAKE_ACP_STATE: path.join(home, "fake-acp-sessions.json"),
			// The fake agent writes transcripts only under GJCM_FAKE_AGENT_DIR, never the inherited
			// GJC_CODING_AGENT_DIR (a variant like [...FAKE_AGENT, "x"] once wrote into ~/.gjc/agent).
			GJCM_FAKE_AGENT_DIR: path.join(home, "agent"),
			GJCM_DEMO_AGENT_DIR: path.join(home, "agent"),
			GJCM_DEMO_CHUNK_MS: "2",
			GJCM_TEST_LOG: path.join(home, "bridge.log"),
			...(command === DEMO_AGENT ? { GJCM_TEST_DEMO_ENDPOINT: "wss://demo.example/ws" } : {}),
			// Only fake-agent bridges index the scratch dir; real gjc keeps its login and session store.
			...(isFakeAgent(command) ? { GJC_CODING_AGENT_DIR: path.join(home, "agent") } : {}),
			...env,
		},
		stdout: "pipe",
		stderr: "inherit",
	});
	const reader = proc.stdout.getReader();
	let line = "";
	while (!line.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) throw new Error("bridge fixture exited before listening");
		line += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	const { port } = JSON.parse(line);
	const state = new BridgeState(home);
	const endpoint = `ws://127.0.0.1:${port}/ws`;
	const offer = async (): Promise<PairingOffer> => buildOffer(state.host(), await state.createPairing(), [endpoint]);
	const pairedClient = async (name = "test-phone") => {
		const o = await offer();
		const identity = BridgeClient.identityFromOffer(o, generateKeyPair());
		const client = await BridgeClient.connect(endpoint, identity, { pairing: { id: o.pairingId, secret: o.secret }, name });
		return { client, identity };
	};
	/**
	 * A pairing with a device code, as `gjcm-bridge pair` makes it. The code names `codeIp` (unreachable from the
	 * test), so tests dial `endpoint` with `pairWithCode(code, { dial: endpoint })`.
	 */
	const codeOffer = async (secret = 0x2468a, codeIp = "100.100.1.2") => {
		const code = encodeCode({ ip: codeIp, port: 7787 }, secret);
		const pairing = await state.createPairing({
			code: p => ({ prs: code, attemptsLeft: CODE_ATTEMPTS, offer: buildOffer(state.host(), p, [endpoint]) }),
		});
		return { code, offer: buildOffer(state.host(), pairing, [endpoint]) };
	};
	const logText = () => {
		try {
			return fs.readFileSync(path.join(home, "bridge.log"), "utf8");
		} catch {
			return "";
		}
	};
	const stop = async () => {
		proc.kill("SIGTERM");
		await proc.exited;
		fs.rmSync(home, { recursive: true, force: true });
	};
	/** What a gjc updater sends after switching the gjc build. */
	const hangup = () => proc.kill("SIGHUP");
	return { home, state, endpoint, offer, codeOffer, logText, pairedClient, hangup, stop, pid: proc.pid };
}
