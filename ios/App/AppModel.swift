import Foundation
import GjcMobileCore
import Observation
import UIKit

struct PairingLink: Equatable {
    let text: String
    let fromLink: Bool
}

enum PairingRefused: LocalizedError {
    case keyChanged

    var errorDescription: String? { "이미 등록된 호스트의 키가 바뀌어 연결하지 않았습니다." }
}

@MainActor
@Observable
final class AppModel {
    private(set) var hosts: [PairedHost]
    private(set) var connections: [String: HostConnection] = [:]
    /// A pairing link for the pairing sheet. `fromLink` (deep link, system camera) means the user is asked to confirm
    /// it first; the demo button's link is not.
    var pairingLink: PairingLink?
    /// Host to bring to the front, set by a widget link and consumed by `RootView`.
    var requestedHostId: String?
    private let store = SecureStore()
    private let cache = SessionCache()
    private(set) var device: DeviceIdentity

    init() {
        device = store.deviceIdentity()
        hosts = store.hosts()
        for host in hosts { connections[host.hostId] = makeConnection(host) }
        if store.hostsAvailable { WidgetStore.sync(hosts) }
    }

    var deviceName: String { UIDevice.current.name }

    func connection(for host: PairedHost) -> HostConnection {
        if let existing = connections[host.hostId] { return existing }
        let created = makeConnection(host)
        connections[host.hostId] = created
        return created
    }

    private func makeConnection(_ host: PairedHost) -> HostConnection {
        HostConnection(host: host, device: device, deviceName: deviceName, cache: cache) { [weak self] updated in
            self?.update(host: updated)
        }
    }

    /// First connection from a QR offer: proves the pairing secret, then remembers the host.
    func pair(with offerText: String, replaceChangedKey: Bool = false) async throws -> PairedHost {
        try await pair(offer: try PairingOffer.parse(offerText), replaceChangedKey: replaceChangedKey)
    }

    /// First connection from a validated offer (QR, link, or a device code's box): proves the pairing secret on
    /// `endpoints` in order (a code's `HeldCodeOffer.helloEndpoints`), or on the offer's endpoints when none are given.
    func pair(offer: PairingOffer, endpoints: [String]? = nil, replaceChangedKey: Bool = false) async throws -> PairedHost {
        // A known hostId under a different key is replaced only when the user explicitly approved it.
        if !offer.isAllowed(among: hosts, keyChangeApproved: replaceChangedKey) { throw PairingRefused.keyChanged }
        guard let hostKey = Data(base64URL: offer.hostKey), let secret = Data(base64URL: offer.secret) else {
            throw PairingOffer.ParseError.malformed
        }
        var lastError: Error = BridgeError.noReachableEndpoint
        for endpoint in endpoints ?? offer.endpoints {
            guard let url = URL(string: endpoint) else { continue }
            do {
                let client = try await BridgeClient.connect(url: url, device: device, hostKey: hostKey,
                                                            deviceName: deviceName, pairing: (offer.pairingId, secret))
                var host = PairedHost(offer: offer)
                host.lastEndpoint = endpoint
                // Pairing the same host again keeps the directory the user saved for it.
                host.preferredCwd = hosts.first { $0.hostId == offer.hostId }?.preferredCwd
                if let info = try? await client.hostInfo() { host.name = info.hostName }
                update(host: host)
                connection(for: host).adopt(client: client, endpoint: endpoint, host: host)
                return host
            } catch let error as BridgeError {
                // A rejected pairing will not succeed on another endpoint either.
                if case .rejected = error { throw error }
                lastError = error
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    /// Where the running code pairing is, for the progress line.
    private(set) var codeStage: CodePairingStage?

    /// The device-code offer kept across a key-change confirmation or a failed hello.
    private var codeOffers = CodeOfferKeeper()

    /// The offer waiting for a key-change confirmation or a retry after a failed hello.
    var pendingCodeOffer: PairingOffer? { codeOffers.held?.offer }

    /// Forgets a held code offer (the user cancelled): nothing was saved, and its secret is dropped.
    func discardCodeOffer() {
        codeOffers.discard()
    }

    /// Pairing by device code (gjcm-code-v1): CPace on the code's address returns the offer, then the usual hello
    /// pairs. Throws `CodePairingError`, or `PairingRefused.keyChanged` before any hello when the offer would replace
    /// a known host's key (confirm, then call again with the same code and `replaceChangedKey`, or
    /// `discardCodeOffer()`). Calling again with the same code after a failed hello retries the hello with the held
    /// offer. `replaceChangedKey` approves only the held offer of that code; a new code's offer is confirmed on its own.
    func pair(code input: String, replaceChangedKey: Bool = false) async throws -> PairedHost {
        let decoded = try DecodedCode.parse(input)
        if codeOffers.submit(code: decoded.code, approvingKeyChange: replaceChangedKey) {
            // Stages reach the main actor through one ordered stream, so a late one cannot overwrite a newer state.
            let (stages, continuation) = AsyncStream.makeStream(of: CodePairingStage.self)
            let relay = Task { @MainActor [weak self] in
                for await stage in stages { self?.codeStage = stage }
            }
            codeStage = .connecting
            let fetched: Result<PairingOffer, Error>
            do {
                fetched = .success(try await BridgeClient.fetchOfferWithCode(url: decoded.endpoint, code: decoded.code, onStage: { stage in
                    continuation.yield(stage)
                }))
            } catch {
                fetched = .failure(error)
            }
            continuation.finish()
            await relay.value
            codeStage = nil
            let offer = try fetched.get()
            codeOffers.keep(code: decoded.code, offer: offer, endpoint: decoded.endpoint.absoluteString)
        }
        // The keeper's approval is the gate: a changed key is never sent a hello before the user approved it.
        if codeOffers.needsKeyChangeApproval(among: hosts) { throw PairingRefused.keyChanged }
        guard let held = codeOffers.held else { throw CodePairingError.pakeFailed }
        do {
            let host = try await pair(offer: held.offer, endpoints: held.helloEndpoints, replaceChangedKey: held.keyChangeApproved)
            codeOffers.helloSucceeded()
            return host
        } catch PairingRefused.keyChanged {
            // pair(offer:) checks the same rule again; the keeper already passed it, so this is not a hello failure.
            throw PairingRefused.keyChanged
        } catch {
            throw codeOffers.helloFailed(error)
        }
    }

    func update(host: PairedHost) {
        if let index = hosts.firstIndex(where: { $0.hostId == host.hostId }) {
            hosts[index] = host
        } else {
            hosts.append(host)
        }
        persistHosts()
        if store.hostsAvailable { WidgetStore.sync(hosts) }
    }

    /// Saves the list; hosts that were stored but unreadable at launch come back into memory with the merge.
    private func persistHosts(forgetting hostId: String? = nil) {
        guard let saved = store.save(hosts: hosts, forgetting: hostId) else { return }
        adopt(saved)
    }

    private func adopt(_ stored: [PairedHost]) {
        for host in stored where !hosts.contains(where: { $0.hostId == host.hostId }) {
            hosts.append(host)
            connections[host.hostId] = makeConnection(host)
        }
    }

    func forget(_ host: PairedHost) {
        connections.removeValue(forKey: host.hostId)?.disconnect()
        hosts.removeAll { $0.hostId == host.hostId }
        cache.remove(hostId: host.hostId)
        persistHosts(forgetting: host.hostId)
        if store.hostsAvailable { WidgetStore.sync(hosts) }
    }

    /// `gjcm://session?host=…&id=…&cwd=…` from a widget row: switches to that host and opens the chat.
    func openSession(hostId: String, sessionId: String, cwd: String) {
        guard let host = hosts.first(where: { $0.hostId == hostId }) else { return }
        let connection = connection(for: host)
        let summary = connection.sessions.first { $0.sessionId == sessionId }
            ?? SessionSummary(sessionId: sessionId, cwd: cwd, title: nil, updatedAt: nil, running: nil)
        connection.activeChat = connection.chat(for: summary)
        requestedHostId = hostId
        connection.ensureConnected()
    }

    /// The Keychain could not be read at launch (locked after a reboot): read the device key and the hosts again.
    /// Hosts are not connected before the real key is back, since a throwaway key is an unknown device to the host.
    /// The hosts go through the same save as every other change, which re-reads, merges and writes.
    private func recoverUnreadableStorage() {
        if store.deviceIsTemporary {
            guard let recovered = store.recoverDeviceIdentity() else { return }
            device = recovered
            for connection in connections.values { connection.disconnect() }
            connections = [:]
            for host in hosts { connections[host.hostId] = makeConnection(host) }
        }
        guard !store.hostsAvailable else { return }
        persistHosts()
        if store.hostsAvailable { WidgetStore.sync(hosts) }
    }

    /// Leaving the screen: the connections are still up for a moment, so their view goes to the widget as fresh,
    /// and iOS is asked for a background refresh later.
    func appWentToBackground() {
        for connection in connections.values { connection.recordWidget() }
        WidgetRefresher.schedule()
    }

    func appBecameActive() {
        recoverUnreadableStorage()
        guard !store.deviceIsTemporary else { return }
        for connection in connections.values { connection.ensureConnected() }
    }
}
