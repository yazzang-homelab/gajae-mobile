import GjcMobileCore
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ChatView: View {
    @Bindable var chat: ChatModel
    @State private var showFiles = false
    @State private var showPhotos = false
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            transcript
            if let request = chat.permissions.first {
                PermissionCard(request: request) { option in
                    Task { await chat.respond(request, option: option) }
                }
                .padding(.horizontal).padding(.top, 8)
            }
            composer
        }
        .background(Palette.ink)
        .overlay {
            if let conversation = chat.btw { BtwBubbleView(chat: chat, conversation: conversation) }
        }
        .animation(.spring(duration: 0.25), value: chat.btw != nil)
        // Typing `/btw ` pops the composer out into the side-chat bubble, carrying what follows.
        .onChange(of: chat.draft) { _, draft in
            guard chat.attachments.isEmpty, let rest = BtwConversation.trigger(in: draft) else { return }
            chat.draft = ""
            composerFocused = false
            chat.openBtw()
            chat.btwDraft = rest
        }
        .navigationTitle(chat.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { titleButton }
            ToolbarItemGroup(placement: .primaryAction) {
                Button { Task { await chat.perform(.showInfo(.context)) } } label: { ContextRing(context: chat.context) }
                    .accessibilityHint("컨텍스트와 사용량 보기")
                SessionMenu(chat: chat)
            }
        }
        .onAppear {
            chat.isVisible = true
            Task { await chat.open() }
        }
        .onDisappear { chat.leave() }
        .sheet(item: $chat.infoSheet) { sheet in InfoSheetView(chat: chat, topic: sheet.topic) }
        .sheet(item: $chat.configPicker) { target in ConfigPickerSheet(chat: chat, target: target) }
        .sheet(isPresented: $chat.showModelSheet) { ModelSettingsSheet(chat: chat) }
        .sheet(isPresented: Binding(get: { chat.shareText != nil }, set: { if !$0 { chat.shareText = nil } })) {
            ShareSheet(text: chat.shareText ?? "")
        }
        .alert(chat.confirmation?.title ?? "", isPresented: Binding(get: { chat.confirmation != nil }, set: { if !$0 { chat.confirmation = nil } }),
               presenting: chat.confirmation) { pending in
            Button("실행", role: .destructive) { Task { await chat.confirm(pending) } }
            Button("취소", role: .cancel) {}
        } message: { pending in Text(pending.message) }
        .alert("세션 이름", isPresented: $chat.renaming) {
            TextField("이름", text: $chat.renameDraft)
            Button("저장") { Task { await chat.rename() } }
            Button("취소", role: .cancel) {}
        }
        .attachmentPickers(showPhotos: $showPhotos, showFiles: $showFiles) { chat.attachments.append($0) } onError: { chat.errorMessage = $0 }
    }

    private var titleButton: some View {
        Button { Task { await chat.perform(.showInfo(.session)) } } label: {
            VStack(spacing: 0) {
                Text(chat.title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.cream).lineLimit(1)
                HStack(spacing: 4) {
                    Circle().fill(chat.connected ? Palette.visorGreen : Palette.gajaeRed).frame(width: 6, height: 6)
                    Text(chat.configOption(.model)?.currentChoiceName ?? displayPath(chat.cwd))
                        .font(.caption2).foregroundStyle(Palette.muted).lineLimit(1)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(chat.title), \(chat.connected ? "연결됨" : "연결 끊김")")
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if chat.loading, let started = chat.loadStartedAt { ResumeProgress(startedAt: started) }
                    ForEach(chat.transcript.items) { item in TranscriptRow(item: item) }
                    if chat.running {
                        HStack(spacing: 8) {
                            ProgressView().tint(Palette.visorGreen)
                            Text(chat.transcript.phase.flatMap { $0 == "idle" ? nil : $0 } ?? "작업 중").font(.caption).foregroundStyle(Palette.muted)
                            Spacer()
                            if chat.hasQueuedSteer {
                                Button { Task { await chat.interrupt() } } label: { Label("끼어들기", systemImage: "arrow.turn.down.right") }
                                    .font(.caption).buttonStyle(.borderedProminent).tint(Palette.strawGold)
                                    .disabled(chat.sending)
                                    .accessibilityHint("진행 중인 턴을 멈추고 대기 중인 지시를 바로 보냅니다")
                            }
                            Button("중단", role: .destructive) { Task { await chat.cancel() } }
                                .font(.caption).buttonStyle(.bordered)
                        }
                        .padding(.horizontal, 4)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: chat.transcript.items.count) { _, _ in
                withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: chat.transcript.lastSeq) { _, _ in
                withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if let message = chat.errorMessage {
                HStack(alignment: .top) {
                    Text(message).font(.caption).foregroundStyle(Palette.gajaeRed)
                    Spacer()
                    Button { chat.errorMessage = nil } label: { Image(systemName: "xmark").font(.caption) }
                        .foregroundStyle(Palette.muted).accessibilityLabel("오류 닫기")
                }
            }
            let suggestions = chat.paletteSuggestions
            if !suggestions.isEmpty {
                SlashPalette(commands: suggestions) { chat.pick($0) }
            } else {
                statusStrips
            }
            if !chat.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(chat.attachments) { attachment in
                            AttachmentChip(attachment: attachment) {
                                chat.attachments.removeAll { $0.id == attachment.id }
                            }
                        }
                    }
                }
            }
            if let progress = chat.uploadProgress, progress < 1 {
                ProgressView(value: progress).tint(Palette.strawGold)
            }
            HStack(alignment: .bottom, spacing: 8) {
                Menu {
                    Button { showPhotos = true } label: { Label("사진", systemImage: "photo") }
                    Button { showFiles = true } label: { Label("파일", systemImage: "doc") }
                    Divider()
                    Button { chat.draft = "/" } label: { Label("명령", systemImage: "slash.circle") }
                } label: {
                    Image(systemName: "plus.circle").font(.title3).padding(8)
                }
                .disabled(chat.running)
                .accessibilityLabel("첨부와 명령")
                TextField(chat.running ? "끼어들 지시 (진행 중인 턴에 전달)" : "gjc에게 지시 · / 명령", text: $chat.draft, axis: .vertical)
                    .lineLimit(1 ... 6)
                    .focused($composerFocused)
                    .textInputAutocapitalization(.never)
                    .padding(10)
                    .card(stroke: composerFocused ? Palette.gajaeRed : Palette.shellLine)
                sendButton
            }
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(Palette.ink)
    }

    @ViewBuilder private var statusStrips: some View {
        if let goal = chat.goal, goal.enabled, let objective = goal.objective {
            Button { Task { await chat.perform(.showInfo(.goal)) } } label: {
                HStack(spacing: 8) {
                    Image(systemName: "target").foregroundStyle(Palette.gajaeRed)
                    Text(objective).font(.caption).foregroundStyle(Palette.cream).lineLimit(1)
                    Spacer()
                    if let status = goal.status { Text(status).font(.caption2).foregroundStyle(Palette.muted) }
                }
                .padding(.horizontal, 12).padding(.vertical, 8).card()
            }
            .buttonStyle(.plain)
        }
        if chat.todos.taskCount > 0 {
            TodoStrip(todos: chat.todos) { Task { await chat.perform(.showInfo(.todos)) } }
        }
        if !chat.queued.isEmpty {
            HStack(spacing: 6) {
                Image(systemName: "text.badge.plus").foregroundStyle(Palette.strawGold)
                Text("전달 대기 \(chat.queued.count)건: \(chat.queued.last?.text ?? "")").font(.caption).foregroundStyle(Palette.muted).lineLimit(1)
                Spacer()
            }
        }
    }

    @ViewBuilder private var sendButton: some View {
        if chat.running {
            Menu {
                Button { Task { await chat.steer(followUp: false) } } label: { Label("지금 끼어들기", systemImage: "arrow.turn.down.right") }
                Button { Task { await chat.steer(followUp: true) } } label: { Label("턴이 끝나면 보내기", systemImage: "clock.arrow.circlepath") }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.title).foregroundStyle(chat.canSend ? Palette.strawGold : Palette.muted)
            } primaryAction: {
                Task { await chat.submit() }
            }
            .disabled(!chat.canSend)
            .accessibilityLabel("끼어들기 (길게 눌러 대기열)")
        } else {
            Button {
                Task { await chat.submit() }
            } label: {
                Image(systemName: chat.sending ? "hourglass" : "arrow.up.circle.fill").font(.title)
            }
            .disabled(!chat.canSend)
            .accessibilityLabel("보내기")
        }
    }
}

/// Photo library and file pickers shared by the chat composer and the new-chat composer: picked items become
/// `PendingAttachment`s (photos re-encoded to fit the inline image budget, other files sent as resources).
struct AttachmentPickers: ViewModifier {
    @Binding var showPhotos: Bool
    @Binding var showFiles: Bool
    let onAdd: (PendingAttachment) -> Void
    let onError: (String) -> Void
    @State private var photoItems: [PhotosPickerItem] = []

    func body(content: Content) -> some View {
        content
            .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: 4, matching: .images)
            .onChange(of: photoItems) { _, items in
                guard !items.isEmpty else { return }
                photoItems = []
                Task { await addPhotos(items) }
            }
            .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                if case let .success(urls) = result { addFiles(urls) }
            }
    }

    private func describe(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    private func addPhotos(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            do {
                onAdd(try ImagePreparer.attachment(from: data))
            } catch {
                onError(describe(error))
            }
        }
    }

    private func addFiles(_ urls: [URL]) {
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                guard data.count <= AttachmentLimits.maxFileBytes else {
                    throw AttachmentError.tooLarge(name: url.lastPathComponent, limit: AttachmentLimits.maxFileBytes)
                }
                let type = UTType(filenameExtension: url.pathExtension)
                if let type, type.conforms(to: .image), data.count <= AttachmentLimits.maxImageBytes,
                   let image = try? ImagePreparer.attachment(from: data, name: url.lastPathComponent) {
                    onAdd(image)
                } else {
                    onAdd(PendingAttachment(
                        name: url.lastPathComponent,
                        payload: .file(data, mimeType: type?.preferredMIMEType ?? "application/octet-stream")
                    ))
                }
            } catch {
                onError(describe(error))
            }
        }
    }
}

extension View {
    func attachmentPickers(
        showPhotos: Binding<Bool>, showFiles: Binding<Bool>,
        onAdd: @escaping (PendingAttachment) -> Void, onError: @escaping (String) -> Void
    ) -> some View {
        modifier(AttachmentPickers(showPhotos: showPhotos, showFiles: showFiles, onAdd: onAdd, onError: onError))
    }
}

/// Re-encodes photos as JPEG with the long edge capped, so they fit the inline image budget.
@MainActor
enum ImagePreparer {
    static func attachment(from data: Data, name: String = "사진.jpg") throws -> PendingAttachment {
        guard let image = UIImage(data: data) else { throw AttachmentError.tooLarge(name: name, limit: 0) }
        let maxEdge = CGFloat(AttachmentLimits.maxImageEdge)
        let longest = max(image.size.width, image.size.height)
        let scale = min(1, maxEdge / longest)
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        for quality in [0.85, 0.7, 0.5] {
            if let jpeg = resized.jpegData(compressionQuality: quality), jpeg.count <= AttachmentLimits.maxImageBytes {
                return PendingAttachment(name: name, payload: .image(jpeg, mimeType: "image/jpeg"))
            }
        }
        throw AttachmentError.tooLarge(name: name, limit: AttachmentLimits.maxImageBytes)
    }
}

struct AttachmentChip: View {
    let attachment: PendingAttachment
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            switch attachment.payload {
            case let .image(data, _):
                if let image = UIImage(data: data) {
                    Image(uiImage: image).resizable().scaledToFill().frame(width: 28, height: 28).clipShape(RoundedRectangle(cornerRadius: 6))
                }
            case .file:
                Image(systemName: "doc").foregroundStyle(Palette.strawGold)
            }
            Text(attachment.name).font(.caption).lineLimit(1).frame(maxWidth: 120)
            Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.byteCount), countStyle: .file))
                .font(.caption2).foregroundStyle(Palette.muted)
            Button(action: onRemove) { Image(systemName: "xmark.circle.fill") }
                .foregroundStyle(Palette.muted)
                .accessibilityLabel("\(attachment.name) 제거")
        }
        .padding(6).card()
    }
}

private extension PermissionMode {
    var symbol: String {
        switch self {
        case .prompt: "hand.raised"
        case .allow: "checkmark.shield"
        case .deny: "xmark.shield"
        }
    }
}

/// Session actions: the gjc builtins that are menus rather than prompts on a phone.
struct SessionMenu: View {
    let chat: ChatModel
    @AppStorage(ThoughtView.showKey) private var showThinking = false

    var body: some View {
        Menu {
            Section {
                // Presenting a sheet synchronously from a toolbar Menu action is dropped while the menu is
                // still dismissing; going through a Task (like every other item here) lets it present.
                Button { Task { await chat.perform(.pickConfig(.model)) } } label: {
                    Label(modelSummary, systemImage: "cpu")
                }
                // gjc TUI Ctrl+T: each tap flips between showing reasoning in full and folding it away.
                Button { showThinking.toggle() } label: {
                    Label(showThinking ? "추론 보기: 켬" : "추론 보기: 끔", systemImage: showThinking ? "brain.filled.head.profile" : "brain.head.profile")
                }
                if let mode = chat.configOption(.mode), !mode.choices.isEmpty {
                    Button { Task { await chat.perform(.pickConfig(.mode)) } } label: {
                        Label("\(mode.name): \(mode.currentChoiceName ?? "-")", systemImage: "switch.2")
                    }
                }
                Button { Task { await chat.setFast(!(chat.fastMode ?? false)) } } label: {
                    Label(chat.fastMode == true ? "빠른 모드: 켬" : "빠른 모드: 끔", systemImage: chat.fastMode == true ? "hare.fill" : "hare")
                }
                // Each tap moves to the next mode, like the TUI's mode-cycling hotkeys.
                if let mode = chat.permissionMode {
                    Button { Task { await chat.cyclePermissionMode() } } label: {
                        Label("권한모드: \(mode.label)", systemImage: mode.symbol)
                    }
                }
            }
            Section {
                action("컨텍스트·사용량", "gauge.with.dots.needle.33percent", .showInfo(.context))
                action("할 일", "checklist", .showInfo(.todos))
                action("목표", "target", .showInfo(.goal))
                action("백그라운드 작업", "gearshape.2", .showInfo(.jobs))
            }
            Section {
                action("압축", "arrow.down.right.and.arrow.up.left", .control(op: "compaction.run", input: [:], confirm: false, notice: "컨텍스트를 압축했습니다."))
                action("이름 바꾸기", "pencil", .askRename)
                action("포크", "arrow.triangle.branch", .forkSession)
                action("새 세션", "square.and.pencil", .newSession)
                action("마지막 답변 복사", "doc.on.doc", .copyLastAnswer)
                action("대화 공유", "square.and.arrow.up", .shareTranscript)
                action("HTML 내보내기(호스트)", "doc.richtext", .control(op: "session.export_html", input: [:], confirm: false, notice: "HTML로 내보냈습니다."))
            }
            Section {
                Button(role: .destructive) { Task { await chat.perform(.control(op: "context.clear", input: [:], confirm: true, notice: "컨텍스트를 비웠습니다.")) } } label: {
                    Label("컨텍스트 비우기", systemImage: "eraser")
                }
                Button(role: .destructive) { Task { await chat.perform(.deleteSession) } } label: {
                    Label("세션 삭제", systemImage: "trash")
                }
                .disabled(chat.running)
            }
            Section { Text(chat.cwd) }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .disabled(!chat.connected)
        .accessibilityLabel("세션 메뉴")
    }

    private func action(_ title: String, _ image: String, _ slash: SlashAction) -> some View {
        Button { Task { await chat.perform(slash) } } label: { Label(title, systemImage: image) }
    }

    private var modelSummary: String {
        let model = chat.configOption(.model)?.currentChoiceName ?? "모델"
        guard let effort = chat.configOption(.thinking)?.currentChoiceName else { return model }
        return "\(model) · \(effort)"
    }
}
