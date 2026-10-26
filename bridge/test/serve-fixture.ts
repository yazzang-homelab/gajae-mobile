/**
 * Runs a bridge in its own process for tests. A Bun WebSocket client that shares an event loop
 * with a Bun WebSocket server can observe frames out of send order (measured: ~10% of runs
 * in-process vs 0/80 across processes), so tests use the real topology: phone and bridge in
 * different processes.
 */
import { SessionHub } from "../src/hub";
import { demoOfferUrl } from "../src/offer";
import { startBridgeServer } from "../src/server";
import { BridgeState } from "../src/state";
import { UploadStore } from "../src/uploads";

const command = JSON.parse(process.env.GJCM_TEST_AGENT!);
const cwd = process.env.GJCM_TEST_CWD!;
const state = new BridgeState();
const hub = new SessionHub({ acp: { command, cwd }, defaultCwd: cwd, agentDir: process.env.GJC_CODING_AGENT_DIR || `${process.env.HOME}/.gjc/agent`, version: "test" });
const demoEndpoint = process.env.GJCM_TEST_DEMO_ENDPOINT;
const server = startBridgeServer({
	hostname: "127.0.0.1",
	port: 0,
	state,
	hub,
	uploads: new UploadStore(state.uploadsDir),
	...(demoEndpoint ? { demoOffer: () => demoOfferUrl(state, demoEndpoint) } : {}),
});
process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);
process.on("SIGHUP", () => hub.recycleWhenIdle());
process.on("SIGTERM", () => {
	hub.stop();
	server.stop(true);
	process.exit(0);
});
