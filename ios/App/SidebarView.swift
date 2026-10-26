import GjcMobileCore
import SwiftUI

/// The leading drawer (ChatGPT/Claude app pattern): paired hosts on top, then the selected host's gjc saved
/// sessions (the TUI `/resume` list). Picking a host swaps the list in place; picking a session closes the drawer.
struct SidebarView: View {
    @Environment(AppModel.self) private var model
    let connection: HostConnection?
    let onSelectHost: (PairedHost) -> Void
    let onSelect: (ChatModel) -> Void
    let onNewChat: (String?) -> Void
    let onAddHost: () -> Void
    let onClose: () -> Void
    @State private var showNew = false
    @State private var newCwd = ""
    @State private var error: String?
    @State private var query = ""
    @State private var pendingDelete: SessionSummary?
    @State private var pendingForget: PairedHost?

    var body: some View {
        List {
            hostsSection
            if let connection { sessionSections(connection) }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Palette.ink)
        .navigationTitle("가재코드")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await connection?.refreshSessions() }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(action: onClose) { Image(systemName: "xmark") }
                    .accessibilityLabel("사이드바 닫기")
            }
            ToolbarItem(placement: .primaryAction) {
                Button(action: onAddHost) { Image(systemName: "qrcode.viewfinder") }
                    .accessibilityLabel("호스트 페어링")
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "세션 검색 · 제목·ID·디렉터리")
        .task(id: query) {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await connection?.search(query)
        }
        .onChange(of: connection?.host.hostId) { _, _ in query = "" }
        .alert("새 세션", isPresented: $showNew) {
            TextField("작업 디렉터리", text: $newCwd)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("시작") { onNewChat(newCwd.isEmpty ? nil : newCwd) }
            Button("취소", role: .cancel) {}
        } message: {
            Text("호스트에서 gjc가 실행될 디렉터리입니다. 첫 메시지를 보낼 때 세션이 만들어집니다.")
        }
        .alert("오류", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("확인", role: .cancel) {}
        } message: { Text(error ?? "") }
        .confirmationDialog("이 세션을 삭제할까요?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                            titleVisibility: .visible, presenting: pendingDelete) { session in
            Button("삭제", role: .destructive) { Task { await delete(session) } }
            Button("취소", role: .cancel) {}
        } message: { session in
            Text("\(session.title ?? session.sessionId)\n호스트의 gjc 세션 기록이 지워집니다.")
        }
        .confirmationDialog("이 호스트를 삭제할까요?", isPresented: Binding(get: { pendingForget != nil }, set: { if !$0 { pendingForget = nil } }),
                            titleVisibility: .visible, presenting: pendingForget) { host in
            Button("삭제", role: .destructive) { model.forget(host) }
            Button("취소", role: .cancel) {}
        } message: { host in
            Text("\(host.name)\n이 기기의 페어링만 지워집니다. 다시 쓰려면 QR로 다시 페어링하세요.")
        }
    }

    private var hostsSection: some View {
        Section("호스트") {
            ForEach(model.hosts) { host in
                let hostConnection = model.connection(for: host)
                Button { onSelectHost(host) } label: {
                    HStack {
                        HostRow(connection: hostConnection)
                        Spacer()
                        if !hostConnection.permissions.isEmpty {
                            Image(systemName: "hand.raised.fill").foregroundStyle(Palette.strawGold)
                                .accessibilityLabel("승인 대기 \(hostConnection.permissions.count)건")
                        }
                        if host.hostId == connection?.host.hostId {
                            Image(systemName: "checkmark").foregroundStyle(Palette.gajaeRed).accessibilityLabel("선택됨")
                        }
                    }
                }
                .buttonStyle(.plain)
                .listRowBackground(host.hostId == connection?.host.hostId ? Palette.shellLine : Palette.shell)
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) { pendingForget = host } label: { Label("삭제", systemImage: "trash") }
                }
                .contextMenu {
                    Button(role: .destructive) { pendingForget = host } label: { Label("호스트 삭제", systemImage: "trash") }
                }
            }
            Button(action: onAddHost) {
                Label("호스트 추가", systemImage: "plus.circle").foregroundStyle(Palette.strawGold)
            }
            .listRowBackground(Palette.shell)
        }
    }

    @ViewBuilder
    private func sessionSections(_ connection: HostConnection) -> some View {
        Section {
            Button { onNewChat(connection.activeChat?.cwd) } label: {
                Label("새 채팅", systemImage: "square.and.pencil").foregroundStyle(Palette.cream)
            }
            .listRowBackground(Palette.shell)
            Button {
                newCwd = connection.info?.defaultCwd ?? ""
                showNew = true
            } label: {
                Label("다른 디렉터리에서 새 세션", systemImage: "folder.badge.plus").foregroundStyle(Palette.muted)
            }
            .listRowBackground(Palette.shell)
            if case let .failed(reason) = connection.status {
                Label(reason, systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(Palette.gajaeRed)
                    .listRowBackground(Palette.shell)
            }
        }
        if !connection.permissions.isEmpty {
            Section("승인 대기") {
                ForEach(connection.permissions) { request in
                    Button {
                        if let session = connection.sessions.first(where: { $0.sessionId == request.sessionId }) {
                            onSelect(connection.chat(for: session))
                        }
                    } label: {
                        Label(request.title, systemImage: "hand.raised.fill").foregroundStyle(Palette.strawGold)
                    }
                    .listRowBackground(Palette.shell)
                }
            }
        }
        Section {
            ForEach(connection.sessions) { session in
                Button { onSelect(connection.chat(for: session)) } label: { SessionRow(session: session) }
                    .listRowBackground(session.sessionId == connection.activeChat?.sessionId ? Palette.shellLine : Palette.shell)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) { pendingDelete = session } label: { Label("삭제", systemImage: "trash") }
                            .disabled(session.running == true)
                    }
                    .swipeActions(edge: .leading) {
                        Button { Task { await fork(session, on: connection) } } label: { Label("포크", systemImage: "arrow.triangle.branch") }
                            .tint(Palette.strawGold)
                    }
                    .contextMenu {
                        Button { Task { await fork(session, on: connection) } } label: { Label("포크", systemImage: "arrow.triangle.branch") }
                        Button { UIPasteboard.general.string = session.sessionId } label: { Label("세션 ID 복사", systemImage: "number") }
                        Button { UIPasteboard.general.string = session.cwd } label: { Label("디렉터리 복사", systemImage: "folder") }
                        Button(role: .destructive) { pendingDelete = session } label: { Label("삭제", systemImage: "trash") }
                    }
                    .onAppear {
                        if session.sessionId == connection.sessions.last?.sessionId {
                            Task { await connection.loadMoreSessions() }
                        }
                    }
            }
            if connection.loadingMore {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Palette.shell)
            }
        } header: {
            Text(connection.searchQuery.isEmpty ? "\(connection.host.name) · 최근 세션" : "'\(connection.searchQuery)' 검색 결과")
        } footer: {
            if connection.nextCursor == nil, !connection.sessions.isEmpty {
                Text("세션 \(connection.sessions.count)개 · 호스트 ~/.gjc/agent/sessions").font(.caption2)
            }
        }
    }

    private func fork(_ session: SessionSummary, on connection: HostConnection) async {
        do {
            onSelect(try await connection.fork(sessionId: session.sessionId))
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func delete(_ session: SessionSummary) async {
        guard let connection else { return }
        do {
            try await connection.delete(sessionId: session.sessionId)
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

extension ChatModel: Hashable {
    nonisolated static func == (lhs: ChatModel, rhs: ChatModel) -> Bool { lhs.sessionId == rhs.sessionId }
    nonisolated func hash(into hasher: inout Hasher) { hasher.combine(sessionId) }
}

func displayPath(_ path: String) -> String {
    let parts = path.split(separator: "/")
    return parts.count > 3 ? "…/" + parts.suffix(3).joined(separator: "/") : path
}

struct SessionRow: View {
    let session: SessionSummary

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(session.title ?? "제목 없음").foregroundStyle(Palette.cream).lineLimit(2)
                HStack(spacing: 6) {
                    // The pulsing icon already says "working"; the text carries the live rate (bridge
                    // `session.status`, once a second) while running, and how stale the session is when idle.
                    if session.running == true {
                        Text(rateLabel).foregroundStyle(Palette.visorGreen).monospacedDigit()
                    } else if let date = session.updatedDate {
                        TimelineView(.periodic(from: .now, by: 60)) { context in Text(Self.age(of: date, now: context.date)) }
                    }
                    Text(displayPath(session.cwd)).font(.caption2.monospaced()).lineLimit(1).truncationMode(.head)
                }
                .font(.caption2).foregroundStyle(Palette.muted)
            }
            Spacer()
            if session.running == true {
                Image(systemName: "circle.dotted.circle").foregroundStyle(Palette.visorGreen)
                    .symbolEffect(.pulse)
                    .accessibilityLabel("실행 중")
            }
        }
        // The whole row is the tap target: a `.plain` button only hit-tests drawn pixels, so the Spacer gap
        // between the title and the running icon used to ignore taps.
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var rateLabel: String {
        guard let rate = session.tokensPerSecond, rate > 0 else { return "≈– tok/s" }
        return "≈\(Int(rate.rounded())) tok/s"
    }

    /// Coarse on purpose: enough to tell a fresh session from an old one, never ticking seconds.
    static func age(of date: Date, now: Date = .now) -> String {
        let minutes = Int(now.timeIntervalSince(date) / 60)
        switch minutes {
        case ..<1: return "방금"
        case ..<60: return "\(minutes)분 전"
        case ..<(60 * 24): return "\(minutes / 60)시간 전"
        case ..<(60 * 24 * 30): return "\(minutes / (60 * 24))일 전"
        default: return date.formatted(.dateTime.year().month().day())
        }
    }
}
