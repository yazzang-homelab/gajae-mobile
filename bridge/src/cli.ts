#!/usr/bin/env bun
/**
 * gjcm-bridge — host daemon that lets the gjc-mobile iPhone app drive `gjc --mode=acp`.
 *
 *   gjcm-bridge serve   [--host 0.0.0.0] [--port 7787] [--cwd DIR] [--gjc "gjc --mode=acp"] [--tmux-session gjcm] [--demo-endpoint wss://…/ws]
 *   gjcm-bridge pair    [--port 7787] [--endpoint ws://host:port/ws ...] [--ttl-min 15] [--code-lan] [--png FILE] [--reusable]
 *   gjcm-bridge devices
 *   gjcm-bridge revoke  <deviceKeyPrefix|name>
 */
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import pkg from "../package.json";
import { CODE_ATTEMPTS } from "./code-pairing";
import { type CodeAddress, encodableEndpoint, formatCode, newCode } from "./device-code";
import { SessionHub } from "./hub";
import { buildOffer, demoOfferUrl, discoverEndpoints, offerUrl } from "./offer";
import { startBridgeServer } from "./server";
import { BridgeState, PairingsBusyError } from "./state";
import { UploadStore } from "./uploads";

const { positionals, values } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		host: { type: "string", default: "0.0.0.0" },
		port: { type: "string", default: "7787" },
		cwd: { type: "string" },
		gjc: { type: "string", default: "gjc --mode=acp" },
		// Opt-in: open the phone's new sessions as windows of this tmux session (only while a tmux server runs).
		"tmux-session": { type: "string" },
		endpoint: { type: "string", multiple: true },
		"ttl-min": { type: "string", default: "15" },
		// Put a private LAN address in the device code instead of the Tailscale one (the phone is not on the tailnet).
		"code-lan": { type: "boolean", default: false },
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
		const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
		const hub = new SessionHub({
			acp: { command: values.gjc!.split(/\s+/).filter(Boolean) },
			defaultCwd: values.cwd ?? os.homedir(),
			agentDir: process.env.GJC_CODING_AGENT_DIR || path.join(os.homedir(), ".gjc", "agent"),
			version: pkg.version,
			...(values["tmux-session"] ? { tmux: { session: values["tmux-session"] } } : {}),
			log,
		});
		const server = startBridgeServer({
			hostname: values.host!,
			port,
			state,
			hub,
			uploads: new UploadStore(state.uploadsDir),
			log,
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
		const endpoints = values.endpoint?.length ? values.endpoint : await discoverEndpoints(port);
		if (endpoints.length === 0) {
			console.error("no reachable endpoint found; pass --endpoint ws://<host>:<port>/ws");
			process.exit(1);
		}
		const ttlMin = Number(values["ttl-min"]);
		const codeAddress = values.reusable ? undefined : pickCodeAddress(endpoints, values["code-lan"]!);
		const host = state.host();
		const code = codeAddress && "address" in codeAddress ? newCode(codeAddress.address) : undefined;
		const pairing = await state
			.createPairing({
				ttlMs: ttlMin * 60_000,
				reusable: values.reusable,
				...(code ? { code: p => ({ prs: code, attemptsLeft: CODE_ATTEMPTS, offer: buildOffer(host, p, endpoints) }) } : {}),
			})
			.catch(error => {
				if (!(error instanceof PairingsBusyError)) throw error;
				console.error(`${state.home}/pairings.lock을 다른 gjcm-bridge가 잡고 있습니다. 잠시 후 다시 실행하세요.`);
				process.exit(1);
			});
		const url = offerUrl(buildOffer(host, pairing, endpoints));
		if (code && codeAddress && "address" in codeAddress) {
			const { ip, port: codePort, range } = codeAddress.address;
			const spaced = formatCode(code).split("").join(" ");
			const bar = "─".repeat(spaced.length + 6);
			console.log(`\n  페어링 코드 (앱에서 입력)\n  ┌${bar}┐\n  │   ${spaced}   │\n  └${bar}┘`);
			const where = range === "tailscale" ? "Tailscale" : "LAN";
			console.log(
				`  코드 주소: ${ip}${codePort === port ? "" : `:${codePort}`} (${where}) · ${ttlMin}분 · 1회 · ${CODE_ATTEMPTS}회 틀리면 폐기`,
			);
			if (range === "tailscale") console.log("  폰이 Tailscale 밖이면 `gjcm-bridge pair --code-lan`을 쓰세요.");
			console.log("\n  또는 QR을 스캔하세요.");
		} else if (codeAddress && "reason" in codeAddress) {
			console.log(`코드를 만들 수 없는 주소라 QR만 표시합니다: ${codeAddress.reason}`);
		}
		console.log(await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "L" }));
		console.log(url);
		console.log(`\n엔드포인트: ${endpoints.join(", ")}`);
		console.log(
			values.reusable
				? `이 QR은 ${ttlMin}분 뒤 만료되며 그때까지 여러 기기가 쓸 수 있습니다(데모 호스트 전용).`
				: `이 ${code ? "코드와 QR은" : "QR은"} ${ttlMin}분 뒤 만료되며 한 번만 쓸 수 있습니다. 하나로 페어링하면 다른 하나도 소멸합니다.`,
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

/**
 * The address the device code carries: the first endpoint that fits in a code (Tailscale first, as discovered),
 * or with `--code-lan` the first private LAN one. A reason instead when none fits.
 */
function pickCodeAddress(endpoints: string[], lanOnly: boolean): { address: CodeAddress } | { reason: string } {
	const reasons: string[] = [];
	for (const endpoint of endpoints) {
		const found = encodableEndpoint(endpoint);
		if (!found.ok) {
			reasons.push(found.reason);
			continue;
		}
		if (lanOnly && found.address.range === "tailscale") continue;
		return { address: found.address };
	}
	if (lanOnly) return { reason: "--code-lan을 줬지만 코드에 담을 수 있는 LAN 주소(10/8, 172.16/12, 192.168/16)가 없습니다" };
	return { reason: reasons[0] ?? "코드에 담을 수 있는 주소가 없습니다" };
}
