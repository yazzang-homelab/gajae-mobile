#!/usr/bin/env bun
/**
 * gjcm-bridge — host daemon that lets the gjc-mobile iPhone app drive `gjc --mode=acp`.
 *
 *   gjcm-bridge serve   [--host 0.0.0.0] [--port 7787] [--cwd DIR] [--gjc "gjc --mode=acp"] [--demo-endpoint wss://…/ws]
 *   gjcm-bridge pair    [--port 7787] [--endpoint ws://host:port/ws ...] [--ttl-min 10] [--png FILE] [--reusable]
 *   gjcm-bridge devices
 *   gjcm-bridge revoke  <deviceKeyPrefix|name>
 */
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import pkg from "../package.json";
import { SessionHub } from "./hub";
import { buildOffer, demoOfferUrl, discoverEndpoints, offerUrl } from "./offer";
import { startBridgeServer } from "./server";
import { BridgeState } from "./state";
import { UploadStore } from "./uploads";

const { positionals, values } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		host: { type: "string", default: "0.0.0.0" },
		port: { type: "string", default: "7787" },
		cwd: { type: "string" },
		gjc: { type: "string", default: "gjc --mode=acp" },
		endpoint: { type: "string", multiple: true },
		"ttl-min": { type: "string", default: "10" },
		png: { type: "string" },
		// Only for the review demo host (bridge/demo): one code that every reviewer device can pair with.
		reusable: { type: "boolean", default: false },
		// Review demo host: serve GET /offer with a reusable pairing for this public endpoint.
		"demo-endpoint": { type: "string" },
	},
});

const command = positionals[0] ?? "help";
const state = new BridgeState();
const port = Number(values.port);

switch (command) {
	case "serve": {
		const hub = new SessionHub({
			acp: { command: values.gjc!.split(/\s+/).filter(Boolean) },
			defaultCwd: values.cwd ?? os.homedir(),
			agentDir: process.env.GJC_CODING_AGENT_DIR || path.join(os.homedir(), ".gjc", "agent"),
			version: pkg.version,
		});
		const server = startBridgeServer({
			hostname: values.host!,
			port,
			state,
			hub,
			uploads: new UploadStore(state.uploadsDir),
			log: line => console.log(`${new Date().toISOString()} ${line}`),
			...(values["demo-endpoint"] ? { demoOffer: () => demoOfferUrl(state, values["demo-endpoint"]!) } : {}),
		});
		console.log(`gjcm-bridge ${pkg.version} listening on ${server.hostname}:${server.port} (state ${state.home})`);
		await hub.agent().catch(error => console.error(`gjc ACP start failed: ${error.message}`));
		const shutdown = () => {
			hub.stop();
			server.stop(true);
			process.exit(0);
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
		// Sent by whatever updates the gjc build behind the ACP launcher (e.g. a deploy script).
		process.on("SIGHUP", () => {
			console.log(`${new Date().toISOString()} SIGHUP: restarting gjc ACP once idle`);
			hub.recycleWhenIdle();
		});
		break;
	}
	case "pair": {
		const pairing = state.createPairing(Number(values["ttl-min"]) * 60_000, values.reusable);
		const endpoints = values.endpoint?.length ? values.endpoint : await discoverEndpoints(port);
		if (endpoints.length === 0) {
			console.error("no reachable endpoint found; pass --endpoint ws://<host>:<port>/ws");
			process.exit(1);
		}
		const url = offerUrl(buildOffer(state.host(), pairing, endpoints));
		console.log(await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "L" }));
		console.log(url);
		console.log(`\n엔드포인트: ${endpoints.join(", ")}`);
		console.log(
			values.reusable
				? `이 코드는 ${values["ttl-min"]}분 뒤 만료되며 그때까지 여러 기기가 쓸 수 있습니다(데모 호스트 전용).`
				: `이 코드는 ${values["ttl-min"]}분 뒤 만료되며 한 번만 쓸 수 있습니다.`,
		);
		if (values.png) await QRCode.toFile(values.png, url, { errorCorrectionLevel: "L", width: 512 });
		break;
	}
	case "devices": {
		for (const d of state.devices()) {
			console.log(`${d.deviceKey.slice(0, 12)}  ${d.name}  paired=${d.pairedAt}  lastSeen=${d.lastSeenAt ?? "-"}`);
		}
		break;
	}
	case "revoke": {
		const target = positionals[1];
		if (!target) {
			console.error("usage: gjcm-bridge revoke <deviceKeyPrefix|name>");
			process.exit(2);
		}
		const removed = state.revokeDevice(target);
		console.log(removed.length ? `revoked ${removed.map(d => d.name).join(", ")}` : "no matching device");
		break;
	}
	default:
		console.log("usage: gjcm-bridge <serve|pair|devices|revoke> [options]");
		process.exit(command === "help" ? 0 : 2);
}
