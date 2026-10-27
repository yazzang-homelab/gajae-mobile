<!-- media:hero -->

# gajae-mobile

**English** · [한국어](README.ko.md) · [简体中文](README.zh-CN.md)

**Your agent asks. Your phone answers.**

gajae-mobile is a native iOS and Android companion for [Gajae Code (`gjc`)](https://github.com/Yeachan-Heo/gajae-code), the coding agent that runs on your own computer. Start work, approve the commands the agent wants to run, steer a running turn, and see from your home screen which session is waiting for you. The agent, its sessions and your model logins never leave the computer; the phone is a remote control over an end-to-end encrypted channel.

<p align="center"><a href="docs/media/reel.mp4"><img src="docs/media/reel.webp" width="720" alt="24-second film built from a real recording: pairing, an approval request, the home-screen widget, the deep link and the answer"></a><br><sub>Built from a real screen recording of the app. <a href="docs/media/reel.mp4">MP4 with sound</a></sub></p>

<p align="center">
  <img src="docs/media/empty.png" width="200" alt="Empty state: pair by QR code or try the demo host">
  <img src="docs/media/approve.png" width="200" alt="Approval card: the agent asks before running a command">
  <img src="docs/media/answer.png" width="200" alt="Streamed answer with plan and tool result">
  <img src="docs/media/widget.png" width="200" alt="Home-screen widget: one session waiting for your answer">
</p>
<p align="center"><sub>Real screenshots of the iOS app (Simulator) talking to the scripted demo host.</sub></p>

## Features

- **Pair by QR code.** `gjcm-bridge pair` prints a one-time code (valid 10 minutes); scan it or paste the link.
- **Chat with the agent.** Streamed answers, reasoning, plans, tool calls and their output, photo and file attachments.
- **Approve from your phone.** When the agent wants to run a command it asks; you get a notification and answer with *Allow once* or *Reject*.
- **Steer and interrupt.** Send an instruction into a running turn, queue the next one, or stop it.
- **Sessions, models, modes.** Resume saved sessions grouped by directory, search them, switch model, reasoning effort and permission mode.
- **Home and lock-screen widget.** Shows how many sessions are waiting for you and which ones are working, and opens the waiting session in one tap. It never shows question or command text, and after 15 minutes without fresh state it says "check needed" instead of a reassuring zero.
- **Try it without a computer.** Builds configured with a demo host offer a "try the demo" button that pairs with a scripted host that runs nothing.

## How it works

```
 Phone (iOS / Android)                  Your computer
┌──────────────────────┐  gjcm-e2ee-v1  ┌────────────────────┐  ACP (stdio)  ┌──────────────────┐
│ gajae-mobile app     │ ◀─ WebSocket ─▶ │ gjcm-bridge        │ ◀───────────▶ │ gjc --mode=acp   │
│  pairing, chat,      │  ws:// or wss:// │  device auth, E2EE │               │  models, tools,  │
│  approvals, widget   │  X25519+AES-GCM │  session multiplex │               │  saved sessions  │
└──────────────────────┘                 └────────────────────┘               └──────────────────┘
```

- Every message between phone and bridge is encrypted at the application layer (X25519 key agreement, HKDF-SHA256, AES-256-GCM), so a plain `ws://` address on your LAN or tailnet gets the same guarantee as TLS.
- The bridge keeps one long-lived `gjc --mode=acp` process and multiplexes devices and sessions over it. Subscription and API credentials stay in `gjc` on the host.
- A lost phone is cut off on the host with `gjcm-bridge revoke <name>`.

## Quick start

Requirements on the computer: [Bun](https://bun.sh) and [Gajae Code](https://github.com/Yeachan-Heo/gajae-code) (`gjc`) on `PATH`.

```bash
git clone https://github.com/yazzang-homelab/gajae-mobile.git
cd gajae-mobile/bridge && bun install

# 1. Run the bridge next to gjc
bun src/cli.ts serve --host 0.0.0.0 --port 7787 --gjc "gjc --mode=acp"

# 2. In another terminal: a one-time pairing code (QR + gjcm:// link)
bun src/cli.ts pair
```

Then open the app and scan the code. `deploy/gjcm-bridge.service` is an example systemd unit for running the bridge permanently.

### Getting the app

There are no store releases yet; build from source.

| Platform | Build |
|---|---|
| Android 8.0+ | `cd android && ./gradlew :app:assembleDebug`, then install `app/build/outputs/apk/debug/app-debug.apk` |
| iOS 17+ | `cd ios && xcodegen generate && open GjcMobile.xcodeproj`, set your team, run on your iPhone |

Set `GJCM_DEMO_OFFER_URL` at build time to enable the demo button against your own demo host (`deploy/gjcm-demo.service`).

## Repository

| Path | Contents |
|---|---|
| [`bridge/`](bridge/README.md) | Host bridge (Bun, TypeScript): protocol, pairing, RPC, scripted demo agent |
| [`ios/`](ios/README.md) | Swift 6, SwiftUI app, WidgetKit extension, platform-independent `GjcMobileCore` package |
| [`android/`](android/README.md) | Kotlin, Jetpack Compose app, Glance widget |
| `fixtures/` | Cross-language test vectors; all three implementations reproduce `e2ee-vector.json` |
| `deploy/` | Example systemd units for the bridge and the demo host |
| `tools/` | Ad-hoc OTA signing and release helpers, ACP smoke test |

Design documents are in Korean: [architecture and protocol](docs/ARCHITECTURE.ko.md), [widget](docs/WIDGET.ko.md), [`/btw` side conversation](docs/BTW.ko.md), [release and CI](docs/RELEASE.ko.md), [Xcode Cloud setup](docs/XCODE-CLOUD.ko.md).

## Development

```bash
cd bridge && bun test && bun x tsc --noEmit -p .            # bridge
cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug   # Android
cd ios/Core && swift test                                    # iOS core (macOS or Linux, Swift 6)
```

CI builds the iOS app on macOS. Contributions go through an issue and a pull request against `dev`; see [AGENTS.md](AGENTS.md).

## License

[GNU Affero General Public License v3.0](LICENSE).
