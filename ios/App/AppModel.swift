import Foundation
import GjcMobileCore
import Observation
import UIKit

@MainActor
@Observable
final class AppModel {
    private(set) var hosts: [PairedHost]
    private(set) var connections: [String: HostConnection] = [:]
    var pairingURL: String?
    /// Host to bring to the front, set by a widget link and consumed by `RootView`.
    var requestedHostId: String?
    private let store = SecureStore()
    private let cache = SessionCache()
    let device: DeviceIdentity

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
    func pair(with offerText: String) async throws -> PairedHost {
        let offer = try PairingOffer.parse(offerText)
        guard let hostKey = Data(base64URL: offer.hostKey), let secret = Data(base64URL: offer.secret) else {
            throw PairingOffer.ParseError.malformed
        }
        var lastError: Error = BridgeError.noReachableEndpoint
        for endpoint in offer.endpoints {
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

    /// The Keychain could not be read at launch (locked after a reboot): read again and add the hosts it holds.
    private func recoverUnreadableHosts() {
        guard !store.hostsAvailable else { return }
        let stored = store.hosts()
        guard store.hostsAvailable else { return }
        adopt(stored)
        WidgetStore.sync(hosts)
    }

    /// Leaving the screen: the connections are still up for a moment, so their view goes to the widget as fresh,
    /// and iOS is asked for a background refresh later.
    func appWentToBackground() {
        for connection in connections.values { connection.recordWidget() }
        WidgetRefresher.schedule()
    }

    func appBecameActive() {
        recoverUnreadableHosts()
        for connection in connections.values { connection.ensureConnected() }
    }
}
