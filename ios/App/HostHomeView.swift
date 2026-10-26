import GjcMobileCore
import SwiftUI

/// What a host lands on: a new-chat composer (ChatGPT/Claude app pattern), with hosts and gjc's saved sessions in
/// the leading sidebar (button or `/resume`). The session list is fetched in the background while the user types.
struct HostHomeView: View {
    @Environment(AppModel.self) private var model
    let connection: HostConnection
    let onOpenSidebar: () -> Void

    var body: some View {
        Group {
            if let active = connection.activeChat {
                ChatView(chat: active).id(active.sessionId)
            } else {
                NewChatView(connection: connection,
                            cwd: Binding(get: { connection.draftCwd }, set: { connection.draftCwd = $0 }),
                            onStarted: { connection.activeChat = $0 },
                            onShowSessions: onOpenSidebar)
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(action: onOpenSidebar) {
                    Image(systemName: "sidebar.left")
                        .overlay(alignment: .topTrailing) {
                            // A permission prompt is waiting on some other host or session.
                            if hasPendingElsewhere {
                                Circle().fill(Palette.strawGold).frame(width: 7, height: 7).offset(x: 3, y: -2)
                            }
                        }
                }
                .accessibilityLabel(hasPendingElsewhere ? "사이드바 · 승인 대기 있음" : "사이드바")
            }
            if connection.activeChat != nil {
                ToolbarItem(placement: .topBarLeading) {
                    Button { startNewChat(cwd: connection.activeChat?.cwd) } label: { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel("새 채팅")
                }
            }
        }
        .onChange(of: connection.route) { _, route in
            guard route != nil, let next = connection.consumeRoute() else { return }
            switch next {
            case let .chat(chat): connection.activeChat = chat
            case let .newChat(cwd): startNewChat(cwd: cwd)
            case .sessions: onOpenSidebar()
            }
        }
        .task {
            connection.ensureConnected()
            await connection.refreshSessions()
        }
    }

    private var hasPendingElsewhere: Bool {
        model.connections.values.contains { other in
            other.permissions.contains { $0.sessionId != connection.activeChat?.sessionId }
        }
    }

    private func startNewChat(cwd: String?) {
        connection.draftCwd = cwd
        connection.activeChat = nil
    }
}

/// Composer for a session that does not exist yet. gjc needs 10–20 s to launch a session host, so the session
/// is created on the first send and the chat takes over with the message already queued.
struct NewChatView: View {
    let connection: HostConnection
    @Binding var cwd: String?
    let onStarted: (ChatModel) -> Void
    let onShowSessions: () -> Void
    @State private var draft = ""
    @State private var starting = false
    @State private var startedAt: Date?
    @State private var error: String?
    @State private var editingCwd = false
    @State private var cwdDraft = ""
    @State private var attachments: [PendingAttachment] = []
    @State private var showPhotos = false
    @State private var showFiles = false
    @FocusState private var focused: Bool

    private var effectiveCwd: String { cwd ?? connection.info?.defaultCwd ?? "" }
    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { (!trimmed.isEmpty || !attachments.isEmpty) && !starting && connection.status == .connected }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 18) {
                    Image("Mascot").resizable().scaledToFit().frame(maxWidth: 120).padding(.top, 32)
                    Text("무엇을 맡길까요?").font(.title3.weight(.semibold)).foregroundStyle(Palette.cream)
                    Button {
                        cwdDraft = effectiveCwd
                        editingCwd = true
                    } label: {
                        Label(effectiveCwd.isEmpty ? "작업 디렉터리" : displayPath(effectiveCwd), systemImage: "folder")
                            .font(.caption.monospaced()).lineLimit(1).truncationMode(.head)
                            .padding(.horizontal, 10).padding(.vertical, 6).card()
                    }
                    .buttonStyle(.plain).foregroundStyle(Palette.muted)
                    .accessibilityHint("작업 디렉터리 바꾸기")
                    recentSessions
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal)
            }
            .scrollDismissesKeyboard(.interactively)
            composer
        }
        .background(Palette.ink)
        .navigationTitle(connection.host.name)
        .navigationBarTitleDisplayMode(.inline)
        .alert("작업 디렉터리", isPresented: $editingCwd) {
            TextField("경로", text: $cwdDraft).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("적용") { cwd = cwdDraft.isEmpty ? nil : cwdDraft }
            Button("취소", role: .cancel) {}
        } message: {
            Text("호스트에서 gjc가 실행될 디렉터리입니다.")
        }
        .onAppear { focused = true }
        .attachmentPickers(showPhotos: $showPhotos, showFiles: $showFiles) { attachments.append($0) } onError: { error = $0 }
    }

    @ViewBuilder private var recentSessions: some View {
        let recent = Array(connection.sessions.prefix(5))
        if !recent.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("최근 세션").font(.caption).foregroundStyle(Palette.muted)
                    Spacer()
                    Button("전체 보기", action: onShowSessions).font(.caption).foregroundStyle(Palette.strawGold)
                }
                .padding(.bottom, 6)
                ForEach(recent) { session in
                    Button { onStarted(connection.chat(for: session)) } label: {
                        SessionRow(session: session).padding(.vertical, 8)
                    }
                    .buttonStyle(.plain)
                    if session.sessionId != recent.last?.sessionId { Divider().overlay(Palette.shellLine) }
                }
            }
            .padding(12).card()
        }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if let error {
                HStack(alignment: .top) {
                    Text(error).font(.caption).foregroundStyle(Palette.gajaeRed)
                    Spacer()
                    Button { self.error = nil } label: { Image(systemName: "xmark").font(.caption) }
                        .foregroundStyle(Palette.muted).accessibilityLabel("오류 닫기")
                }
            }
            if starting, let startedAt {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small).tint(Palette.strawGold)
                    Text("호스트에서 세션을 준비하는 중…")
                    Text(startedAt, style: .timer).monospacedDigit()
                    Spacer()
                }
                .font(.caption).foregroundStyle(Palette.muted)
            }
            let suggestions = SlashCommandCatalog.suggestions(for: draft, skills: [])
            if !suggestions.isEmpty {
                SlashPalette(commands: suggestions) { command in
                    draft = command.argumentHint != nil || !command.isRunnable ? "/\(command.name) " : "/\(command.name)"
                    if command.argumentHint == nil, command.isRunnable { Task { await send() } }
                }
            }
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(attachments) { attachment in
                            AttachmentChip(attachment: attachment) { attachments.removeAll { $0.id == attachment.id } }
                        }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                Menu {
                    Button { showPhotos = true } label: { Label("사진", systemImage: "photo") }
                    Button { showFiles = true } label: { Label("파일", systemImage: "doc") }
                    Divider()
                    Button { draft = "/" } label: { Label("명령", systemImage: "slash.circle") }
                } label: {
                    Image(systemName: "plus.circle").font(.title3).padding(8)
                }
                .disabled(starting)
                .accessibilityLabel("첨부와 명령")
                TextField("gjc에게 지시 · / 명령", text: $draft, axis: .vertical)
                    .lineLimit(1 ... 6)
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .padding(10)
                    .card(stroke: focused ? Palette.gajaeRed : Palette.shellLine)
                    .disabled(starting)
                Button { Task { await send() } } label: {
                    Image(systemName: starting ? "hourglass" : "arrow.up.circle.fill").font(.title)
                }
                .disabled(!canSend)
                .accessibilityLabel("보내기")
            }
            if connection.status != .connected {
                Text(statusText).font(.caption2).foregroundStyle(Palette.muted).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(Palette.ink)
    }

    private var statusText: String {
        switch connection.status {
        case .connecting: "호스트에 연결하는 중…"
        case let .failed(reason): reason
        default: "호스트에 연결되지 않았습니다."
        }
    }

    private func send() async {
        let text = trimmed
        guard !text.isEmpty || !attachments.isEmpty, !starting else { return }
        error = nil
        // Commands that need no session are handled here; everything else runs inside the new session.
        switch attachments.isEmpty ? SlashCommandCatalog.resolve(text) : .notCommand {
        case .run(.openSessions):
            draft = ""
            onShowSessions()
            return
        case .run(.newSession):
            draft = ""
            return
        case let .hostOnly(name, reason):
            error = "/\(name): \(reason)"
            return
        default:
            break
        }
        starting = true
        startedAt = Date()
        defer {
            starting = false
            startedAt = nil
        }
        do {
            let chat = try await connection.createSession(cwd: effectiveCwd.isEmpty ? nil : effectiveCwd)
            chat.draft = text
            chat.attachments = attachments
            draft = ""
            attachments = []
            onStarted(chat)
            await chat.submit()
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
