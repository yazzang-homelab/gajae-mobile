#!/usr/bin/env bun
/**
 * Smoke test for a freshly built gjc: spawns `<gjc> --mode=acp` from a freshly built slot and requires an
 * ACP `initialize` answer reporting the expected version. initialize touches no session, so the
 * check leaves the shared agent directory (session list) untouched.
 *
 *   bun tools/acp-smoke.ts <expected-version> <command...>
 */
import { AcpProcess } from "../bridge/src/acp";

const TIMEOUT_MS = 60_000;
const [expected, ...command] = Bun.argv.slice(2);
if (!expected || command.length === 0) {
	console.error("usage: acp-smoke.ts <expected-version> <command...>");
	process.exit(2);
}

const acp = new AcpProcess(
	{ command },
	{
		onNotification() {},
		onRequest: async method => {
			throw new Error(`unexpected agent request ${method}`);
		},
		onExit() {},
	},
);
const timer = setTimeout(() => {
	console.error(`initialize timed out after ${TIMEOUT_MS}ms\n${acp.stderrTail.slice(-2000)}`);
	acp.kill();
	process.exit(1);
}, TIMEOUT_MS);

try {
	const init = await acp.request("initialize", {
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		clientInfo: { name: "gjcm-acp-smoke", version: "0" },
	});
	const version = String(init?.agentInfo?.version ?? "");
	if (version !== expected) {
		console.error(`agentInfo.version=${JSON.stringify(version)} expected ${expected}`);
		process.exitCode = 1;
	} else {
		console.log(`acp initialize ok: ${init.agentInfo.name ?? "gjc"} ${version}`);
	}
} catch (error) {
	console.error(`initialize failed: ${(error as Error).message}\n${acp.stderrTail.slice(-2000)}`);
	process.exitCode = 1;
} finally {
	clearTimeout(timer);
	acp.kill();
}
