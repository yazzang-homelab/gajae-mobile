import Foundation
import GjcMobileCore
import Observation

/// Live link to one paired host's bridge. Reconnects with backoff and re-opens visible chats with
/// `afterSeq`, so a phone that slept or changed networks catches up without reloading history.
@MainActor
@Observable
final class HostConnection {
    enum Status: Equatable {
        case idle
        case connecting
        case connected
        case failed(String)
    }

    private(set) var host: PairedHost
    private(set) var status: Status = .idle
    private(set) var info: HostInfo?
    private(set) var sessions: [SessionSummary]
    private(set) var permissions: [PermissionRequest] = []
    private(set) var chats: [String: ChatModel] = [:]
    private(set) var nextCursor: String?
    private(set) var loadingMore = false
    /// Why the last session-list request failed while the connection stayed up (an error reply from the bridge).
    private(set) var listError: String?
    private(set) var searchQuery = ""
    private(set) var route: HomeRoute?
    /// The host home's chat (nil shows the new-chat composer) and that composer's directory. Kept per host so
    /// switching hosts in the sidebar and back returns to the same chat.
    var activeChat: ChatModel?
    var draftCwd: String?

    /// What the host home screen should show next, asked for from inside a chat (`/new`, `/resume`, `/fork`, `/drop`).
    enum HomeRoute: Equatable {
        case chat(ChatModel)
        case newChat(cwd: String?)
        case sessions
    }

    @ObservationIgnored private var client: BridgeClient?
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var connectTask: Task<Void, Never>?
    @ObservationIgnored private var backoff = ReconnectBackoff()
    /// The backoff's clock: `ContinuousClock` keeps counting while the phone sleeps (`systemUptime` does not), like
    /// Android's `elapsedRealtime`, so a connection that lived across a locked screen is not a drop right after attaching.
    private static let clockStart = ContinuousClock.now
    private static var clockSeconds: TimeInterval {
        let elapsed = clockStart.duration(to: .now).components
        return TimeInterval(elapsed.seconds) + TimeInterval(elapsed.attoseconds) / 1e18
    }
    @ObservationIgnored private var alerts = ActivityAlerts()
    /// The widget may only record what this connection fully knows: the unfiltered list and every waiting ask.
    @ObservationIgnored private var listKnown = false
    @ObservationIgnored private var waitingKnown = false
    /// Asks delivered live on this connection: kept when the `permission.list` reply, possibly older, lacks them.
    @ObservationIgnored private var arrivedSinceAttach: Set<String> = []
    @ObservationIgnored private let device: DeviceIdentity
    @ObservationIgnored private let deviceName: String
    @ObservationIgnored private let cache: SessionCache
    @ObservationIgnored private let onHostChange: (PairedHost) -> Void

    init(host: PairedHost, device: DeviceIdentity, deviceName: String, cache: SessionCache, onHostChange: @escaping (PairedHost) -> Void) {
        self.host = host
        self.device = device
        self.deviceName = deviceName
        self.cache = cache
        self.onHostChange = onHostChange
        sessions = cache.load(hostId: host.hostId)
    }

    var connectedClient: BridgeClient? { status == .connected ? client : nil }

    /// Saves (or with nil clears) the directory new chats on this host start in. Only an explicit user action calls
    /// this; a path picked for one chat stays in `draftCwd`.
    func setPreferredCwd(_ cwd: String?) {
        guard host.preferredCwd != cwd else { return }
        host.preferredCwd = cwd
        onHostChange(host)
    }

    func ensureConnected(after wait: TimeInterval = 0) {
        guard status != .connected, connectTask == nil else { return }
        connectTask = Task { await connectLoop(after: wait) }
    }

    func disconnect() {
        connectTask?.cancel()
        connectTask = nil
        eventTask?.cancel()
        if let client { Task { await client.close() } }
        client = nil
        listError = nil
        status = .idle
    }

    /// Takes over a client that was just created by pairing, together with the host record that pairing produced.
    /// Re-pairing a known host may bring new endpoints, a new name or a new key, so the old record (and any retry
    /// loop still dialing it) must not outlive the pairing.
    func adopt(client: BridgeClient, endpoint: String, host paired: PairedHost) {
        disconnect()
        host = paired
        attach(client, endpoint: endpoint)
    }

    private func connectLoop(after wait: TimeInterval) async {
        // A cancelled loop may still be finishing after a newer one started; it must not clear that one's handle.
        defer { if !Task.isCancelled { connectTask = nil } }
        if wait > 0 {
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled else { return }
        }
        while !Task.isCancelled {
            status = .connecting
            do {
                let (client, endpoint) = try await BridgeClient.connectAny(host: host, device: device, deviceName: deviceName)
                // Cancelled meanwhile (disconnect, or a pairing adopted its own client): do not replace that client.
                guard !Task.isCancelled else {
                    await client.close()
                    return
                }
                attach(client, endpoint: endpoint)
                return
            } catch {
                // A cancelled loop (the dial itself does not stop on cancellation) must not overwrite the state of
                // whatever replaced it, e.g. the client a re-pairing just adopted.
                guard !Task.isCancelled else { return }
                status = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
                if case BridgeError.rejected = error { return } // unpaired: retrying cannot help
                try? await Task.sleep(for: .seconds(backoff.failedDial()))
                guard !Task.isCancelled else { return }
            }
        }
    }

    private func attach(_ client: BridgeClient, endpoint: String) {
        // The previous client's socket and reader outlive a plain overwrite; the bridge would keep both links.
        // Stop its event reader first so the disconnected event that close() emits is never handled as a drop.
        eventTask?.cancel()
        if let previous = self.client, previous !== client { Task { await previous.close() } }
        self.client = client
        status = .connected
        listError = nil
        listKnown = false
        waitingKnown = false
        arrivedSinceAttach = []
        backoff.attached(at: Self.clockSeconds)
        if host.lastEndpoint != endpoint {
            host.lastEndpoint = endpoint
            onHostChange(host)
        }
        eventTask = Task { [weak self] in
            for await event in client.events {
                guard let self, !Task.isCancelled else { return }
                self.handle(event)
            }
        }
        Task {
            info = try? await client.hostInfo()
            // Asks raised while this phone was away are only re-offered inside an opened chat; fetch them all.
            if let pending = try? await client.pendingPermissions() {
                let live = Dictionary(permissions.map { ($0.requestId, $0) }, uniquingKeysWith: { first, _ in first })
                let listed = Set(pending.map(\.requestId))
                // Drops asks remembered from before a disconnect that were settled meanwhile.
                permissions = pending.map { live[$0.requestId] ?? $0 }
                    + permissions.filter { arrivedSinceAttach.contains($0.requestId) && !listed.contains($0.requestId) }
                for request in pending { notify(alerts.permission(request)) }
                waitingKnown = true
            }
            await refreshSessions()
            // A chat holding a photo message stays subscribed after it is left (see ChatModel.leave).
            for chat in chats.values where chat.isVisible || chat.heldPhotoMessage != nil { await chat.open(using: client) }
        }
    }

    private func handle(_ event: BridgeEvent) {
        switch event {
        case let .sessionUpdate(sessionId, update):
            chats[sessionId]?.apply(update)
        case let .permissionRequest(request):
            permissions.removeAll { $0.requestId == request.requestId }
            permissions.append(request)
            arrivedSinceAttach.insert(request.requestId)
            chats[request.sessionId]?.add(permission: request)
            notify(alerts.permission(request))
            recordWidget()
        case let .permissionResolved(requestId, sessionId):
            permissions.removeAll { $0.requestId == requestId }
            chats[sessionId]?.removePermission(requestId)
            ActivityNotifier.shared.withdrawAsk(requestId)
            recordWidget()
        case let .sessionStatus(status):
            if let index = sessions.firstIndex(where: { $0.sessionId == status.sessionId }) {
                sessions[index] = sessions[index].with(status: status)
            }
            chats[status.sessionId]?.apply(status: status)
            notify(alerts.status(sessionId: status.sessionId, running: status.running))
            recordWidget()
        case let .disconnected(reason):
            client = nil
            listKnown = false
            waitingKnown = false
            listError = nil
            status = .failed(reason)
            // A drop right after attaching waits before the next dial (see ReconnectBackoff).
            ensureConnected(after: backoff.dropped(at: Self.clockSeconds))
        }
    }

    private func notify(_ alert: ActivityAlerts.Alert?) {
        guard let alert else { return }
        ActivityNotifier.shared.post(alert, session: sessionLabel(alert.sessionId), host: host.name)
    }

    private func sessionLabel(_ sessionId: String) -> String {
        if let chat = chats[sessionId] { return chat.title }
        guard let summary = sessions.first(where: { $0.sessionId == sessionId }) else { return "세션" }
        if let title = summary.title, !title.isEmpty { return title }
        return URL(fileURLWithPath: summary.cwd).lastPathComponent
    }

    /// First page of gjc's saved sessions, newest first (the list the TUI `/resume` shows).
    func refreshSessions() async {
        guard let client = connectedClient else { return }
        do {
            let list = try await client.listSessions(query: searchQuery)
            alerts.sessions(list.sessions).forEach { notify($0) }
            sessions = list.sessions
            nextCursor = list.nextCursor
            listError = nil
            if searchQuery.isEmpty {
                cache.save(sessions, hostId: host.hostId)
                listKnown = true
                recordWidget()
            }
        } catch {
            handleListFailure(error)
        }
    }

    /// A cancelled request changes nothing, a drop is left to the event stream, an error reply only marks the list.
    private func handleListFailure(_ error: Error) {
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        switch SessionListFailure.classify(error) {
        case .cancelled, .disconnected: break
        case .remote: listError = message
        case .transport: status = .failed(message)
        }
    }

    /// Writes this host's state for the widget, but only while connected with the full picture: a list filtered by
    /// a search or missing the waiting asks would show the widget a false "nothing waiting".
    func recordWidget() {
        guard status == .connected, listKnown, waitingKnown, searchQuery.isEmpty else { return }
        WidgetStore.observe(host: host, sessions: sessions, waiting: permissions)
    }

    /// Server-side title/id/cwd search; the bridge filters, the phone does not hold every session.
    func search(_ query: String) async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed != searchQuery else { return }
        searchQuery = trimmed
        await refreshSessions()
    }

    func loadMoreSessions() async {
        guard let client = connectedClient, let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await client.listSessions(query: searchQuery, cursor: cursor)
            let known = Set(sessions.map(\.sessionId))
            alerts.sessions(page.sessions).forEach { notify($0) }
            sessions += page.sessions.filter { !known.contains($0.sessionId) }
            nextCursor = page.nextCursor
            listError = nil
        } catch {
            handleListFailure(error)
        }
    }

    /// Copies a session (gjc `session/fork`) and returns the open copy.
    func fork(sessionId: String) async throws -> ChatModel {
        guard let client = connectedClient else { throw BridgeError.disconnected }
        let snapshot = try await client.forkSession(sessionId)
        let source = sessions.first { $0.sessionId == sessionId }
        let chat = ChatModel(sessionId: snapshot.sessionId, cwd: snapshot.cwd, title: source?.title.map { "\($0) (포크)" }, connection: self)
        chat.apply(snapshot: snapshot)
        chats[snapshot.sessionId] = chat
        sessions.insert(SessionSummary(sessionId: snapshot.sessionId, cwd: snapshot.cwd, title: chat.title,
                                       updatedAt: ISO8601DateFormatter().string(from: Date()), running: false), at: 0)
        return chat
    }

    /// Deletes the saved session on the host. The bridge refuses while a turn is running.
    func delete(sessionId: String) async throws {
        guard let client = connectedClient else { throw BridgeError.disconnected }
        try await client.deleteSession(sessionId)
        chats[sessionId] = nil
        if activeChat?.sessionId == sessionId { activeChat = nil }
        sessions.removeAll { $0.sessionId == sessionId }
        cache.save(sessions, hostId: host.hostId)
    }

    /// Mirrors a successful `/rename` into the list and the offline cache right away. The host already wrote the
    /// title (gjc appends a `header_patch`); this only spares the phone a stale row until the next refresh.
    func renamed(sessionId: String, title: String) {
        guard let index = sessions.firstIndex(where: { $0.sessionId == sessionId }) else { return }
        let old = sessions[index]
        sessions[index] = SessionSummary(sessionId: old.sessionId, cwd: old.cwd, title: title, updatedAt: old.updatedAt,
                                         running: old.running, tokensPerSecond: old.tokensPerSecond)
        if searchQuery.isEmpty { cache.save(sessions, hostId: host.hostId) }
    }

    func present(_ chat: ChatModel) { route = .chat(chat) }

    func requestNewChat(cwd: String?) { route = .newChat(cwd: cwd) }

    func requestSessions() { route = .sessions }

    func consumeRoute() -> HomeRoute? {
        defer { route = nil }
        return route
    }

    func chat(for session: SessionSummary) -> ChatModel {
        if let chat = chats[session.sessionId] { return chat }
        let chat = ChatModel(sessionId: session.sessionId, cwd: session.cwd, title: session.title, connection: self)
        chats[session.sessionId] = chat
        return chat
    }

    func createSession(cwd: String?) async throws -> ChatModel {
        guard let client = connectedClient else { throw BridgeError.disconnected }
        let snapshot = try await client.newSession(cwd: cwd?.isEmpty == false ? cwd : nil)
        let chat = ChatModel(sessionId: snapshot.sessionId, cwd: snapshot.cwd, title: nil, connection: self)
        chat.apply(snapshot: snapshot)
        chats[snapshot.sessionId] = chat
        sessions.insert(SessionSummary(sessionId: snapshot.sessionId, cwd: snapshot.cwd, title: nil,
                                       updatedAt: ISO8601DateFormatter().string(from: Date()), running: false), at: 0)
        return chat
    }
}
