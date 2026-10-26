import Foundation
import GjcMobileCore
import Observation
import UIKit

/// What the info sheet shows. `goal` and `todos` also have inline panels; the sheet is the full view.
struct InfoSheet: Identifiable, Equatable {
    var id: String { topic.rawValue }
    let topic: InfoTopic
}

/// A slash action that needs a yes before it runs (`/clear`, `/goal drop`, `/drop`, `/session delete`).
struct PendingConfirmation: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let message: String
    let action: SlashAction
}

@MainActor
@Observable
final class ChatModel: Identifiable {
    nonisolated var id: String { sessionId }
    nonisolated let sessionId: String
    let cwd: String
    private(set) var transcript = SessionTranscript()
    private(set) var permissions: [PermissionRequest] = []
    private(set) var loading = false
    private(set) var loadStartedAt: Date?
    private(set) var sending = false
    private(set) var uploadProgress: Double?
    var draft = ""
    var attachments: [PendingAttachment] = []
    var errorMessage: String?
    var isVisible = false

    // Insights the screen renders natively (gjc `_gjc/sdk/query`).
    private(set) var context: ContextUsage?
    private(set) var usage: UsageTotals?
    private(set) var todos: [TodoPhase] = []
    private(set) var goal: GoalState?
    private(set) var jobs: JobsSnapshot?
    private(set) var metadata: JSONValue?
    private(set) var fastMode: Bool?
    /// Steers and follow-ups this phone handed to gjc during the running turn.
    private var sentQueue: [QueuedMessage] = []
    /// gjc's own queue from `session.status`, including steers typed in the TUI; `nil` until the bridge reports one.
    private var hostQueue: [QueuedMessage]?
    /// When the last report arrived: the clock the grace period runs on, so each report (once a second) re-renders.
    private var hostQueueAt: TimeInterval = 0
    /// What waits on the running turn; `followUp` ones wait for the turn to end.
    var queued: [QueuedMessage] { QueuedMessages.merge(sent: sentQueue, host: hostQueue, now: hostQueueAt) }
    var hasQueuedSteer: Bool { queued.contains { !$0.followUp } }
    var infoSheet: InfoSheet?
    var configPicker: ConfigTarget?
    /// `/model`, `/effort`: this session's model/effort and the per-role models.
    var showModelSheet = false
    private(set) var modelRoles: ModelRoles?
    var confirmation: PendingConfirmation?
    var renaming = false
    var renameDraft = ""
    var shareText: String?
    /// `/btw` side chat shown as a floating bubble; `nil` when closed. Never written to the transcript.
    private(set) var btw: BtwConversation?
    var btwDraft = ""
    /// Bumped on every open/close so an answer that arrives after the bubble closed is dropped.
    @ObservationIgnored private var btwEpoch = 0

    private let initialTitle: String?
    private var renamedTitle: String?
    @ObservationIgnored private weak var connection: HostConnection?

    init(sessionId: String, cwd: String, title: String?, connection: HostConnection) {
        self.sessionId = sessionId
        self.cwd = cwd
        initialTitle = title
        self.connection = connection
    }

    var title: String { renamedTitle ?? transcript.title ?? initialTitle ?? "새 세션" }
    var running: Bool { transcript.running }
    var permissionMode: PermissionMode? { transcript.permissionMode }
    var connected: Bool { connection?.connectedClient != nil }
    private var trimmedDraft: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    var canSend: Bool {
        guard !sending, connected else { return false }
        if running { return !trimmedDraft.isEmpty && attachments.isEmpty }
        return !trimmedDraft.isEmpty || !attachments.isEmpty
    }

    var skillNames: [String] {
        transcript.availableCommands
    }

    var paletteSuggestions: [SlashCommand] {
        SlashCommandCatalog.suggestions(for: draft, skills: skillNames)
    }

    func configOption(_ target: ConfigTarget) -> ConfigOption? {
        transcript.configOptions.first(where: target.matches)
    }

    // MARK: Session lifecycle

    func open(using client: BridgeClient? = nil) async {
        guard let client = client ?? connection?.connectedClient else { return }
        loading = transcript.items.isEmpty
        loadStartedAt = loading ? Date() : nil
        defer {
            loading = false
            loadStartedAt = nil
        }
        do {
            let snapshot = try await client.openSession(sessionId, cwd: cwd, afterSeq: transcript.lastSeq)
            apply(snapshot: snapshot)
            await refreshInsights(using: client)
        } catch {
            show(error)
        }
    }

    /// The bridge answers -32002 when gjc dropped this process's attachment to the session (its session host
    /// restarted or a terminal took the session over). Reopen once and retry instead of surfacing
    /// "SDK session attachment is stale" to the user.
    private func reopening<T>(_ client: BridgeClient, _ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch BridgeError.remote(code: -32002, _) {
            let snapshot = try await client.openSession(sessionId, cwd: cwd, afterSeq: transcript.lastSeq)
            apply(snapshot: snapshot)
            return try await body()
        }
    }

    private func query(_ client: BridgeClient, _ op: String) async throws -> [JSONValue] {
        try await reopening(client) { try await client.sdkQuery(sessionId, op) }
    }

    func apply(snapshot: OpenSnapshot) {
        transcript.apply(snapshot: snapshot)
        permissions = snapshot.permissions
    }

    func apply(_ update: SequencedUpdate) {
        transcript.apply(update)
        switch update.update["sessionUpdate"]?.string {
        case "x_gjcm_turn_end":
            sentQueue = []
            if hostQueue != nil { hostQueue = [] }
            Task { await refreshInsights() }
        case "plan":
            Task { await refreshTodos() }
        default:
            break
        }
    }

    func apply(status: SessionStatus) {
        guard let queue = status.queued else { return }
        hostQueue = queue
        hostQueueAt = Date().timeIntervalSince1970
    }

    func add(permission: PermissionRequest) {
        permissions.removeAll { $0.requestId == permission.requestId }
        permissions.append(permission)
    }

    func removePermission(_ requestId: String) {
        permissions.removeAll { $0.requestId == requestId }
    }

    func leave() {
        isVisible = false
        guard let client = connection?.connectedClient else { return }
        Task { try? await client.closeSession(sessionId) }
    }

    // MARK: Composer

    /// Runs a `/` command natively or sends the draft. While a turn runs, text steers the turn.
    func submit() async {
        let text = trimmedDraft
        if attachments.isEmpty {
            switch SlashCommandCatalog.resolve(text, skills: skillNames) {
            case .notCommand, .sendAsPrompt:
                break
            case let .run(action):
                draft = ""
                await perform(action)
                return
            case let .hostOnly(name, reason):
                errorMessage = "/\(name): \(reason)"
                return
            case let .missingArgument(name, hint):
                errorMessage = "/\(name) \(hint) 형식으로 입력하세요."
                return
            case let .invalidArgument(name, message):
                errorMessage = "/\(name): \(message)"
                return
            case let .unknown(name):
                errorMessage = "/\(name)은(는) 없는 명령입니다. /help로 목록을 보세요."
                return
            }
        }
        if running {
            await steer(followUp: false)
        } else {
            await send()
        }
    }

    private func send() async {
        guard canSend, let client = connection?.connectedClient else { return }
        sending = true
        errorMessage = nil
        let text = draft
        let files = attachments
        defer {
            sending = false
            uploadProgress = nil
        }
        do {
            let blocks = try await client.promptBlocks(text: text, attachments: files, sessionId: sessionId) { fraction in
                Task { @MainActor [weak self] in self?.uploadProgress = fraction }
            }
            try await reopening(client) { try await client.prompt(sessionId, blocks: blocks) }
            transcript.markRunning()
            draft = ""
            attachments = []
        } catch {
            show(error)
        }
    }

    /// `turn.steer` reaches the model at its next step; `turn.follow_up` waits for the turn to end.
    func steer(followUp: Bool) async {
        let text = trimmedDraft
        guard running, !text.isEmpty, let client = connection?.connectedClient else { return }
        sending = true
        defer { sending = false }
        do {
            _ = try await reopening(client) {
                try await client.sdkControl(sessionId, followUp ? "turn.follow_up" : "turn.steer", input: ["text": .string(text)])
            }
            draft = ""
            sentQueue.append(QueuedMessage(text: text, followUp: followUp, sentAt: Date().timeIntervalSince1970))
            transcript.appendNotice(followUp ? "턴이 끝나면 보낼 메시지를 대기열에 넣었습니다." : "진행 중인 턴에 지시를 끼워 넣었습니다.")
        } catch {
            show(error)
        }
    }

    /// "끼어들기": the TUI's Esc with a steer waiting — stop the turn now and send the waiting steers.
    func interrupt() async {
        guard running, hasQueuedSteer, let client = connection?.connectedClient else { return }
        sending = true
        defer { sending = false }
        do {
            _ = try await reopening(client) { try await client.interrupt(sessionId) }
            dropSteers()
            transcript.appendNotice("진행 중인 턴을 중단하고 대기 중인 지시를 바로 보냈습니다.")
        } catch BridgeError.remote(code: -32005, _) {
            dropSteers()
            transcript.appendNotice("대기 중인 지시는 이미 모델에 전달됐습니다.")
        } catch {
            show(error)
        }
    }

    private func dropSteers() {
        sentQueue.removeAll { !$0.followUp }
        hostQueue?.removeAll { !$0.followUp }
    }

    func cancel() async {
        guard let client = connection?.connectedClient else { return }
        try? await client.cancel(sessionId)
    }

    func pick(_ command: SlashCommand) {
        if command.argumentHint != nil || !command.isRunnable {
            draft = "/\(command.name) "
        } else {
            draft = "/\(command.name)"
            Task { await submit() }
        }
    }

    // MARK: Actions

    func perform(_ action: SlashAction) async {
        errorMessage = nil
        switch action {
        case let .showInfo(topic):
            infoSheet = InfoSheet(topic: topic)
        case let .control(op, input, confirm, notice):
            if confirm, confirmation?.action != action {
                confirmation = PendingConfirmation(title: confirmTitle(op: op, input: input), message: "되돌릴 수 없습니다.", action: action)
                return
            }
            confirmation = nil
            await control(op, input: input, confirm: confirm, notice: notice)
        case let .pickConfig(target) where target != .mode:
            showModelSheet = true
        case let .pickConfig(target):
            if configOption(target) == nil {
                errorMessage = "이 세션에는 \(target.label) 설정이 없습니다."
            } else {
                configPicker = target
            }
        case let .setConfig(target, query):
            guard let option = configOption(target) else {
                errorMessage = "이 세션에는 \(target.label) 설정이 없습니다."
                return
            }
            guard let choice = option.choice(matching: query) else {
                errorMessage = "'\(query)'에 맞는 \(target.label)이(가) 없거나 여러 개입니다. 목록에서 고르세요."
                if target == .mode { configPicker = target } else { showModelSheet = true }
                return
            }
            await setConfig(option, value: choice.value)
            transcript.appendNotice("\(option.name): \(choice.name)")
        case .askRename:
            renameDraft = title
            renaming = true
        case .newSession:
            // gjc spends 10–20 s launching a session host; the new-chat composer creates it on the first send.
            connection?.requestNewChat(cwd: cwd)
        case let .openBtw(question):
            openBtw(question: question)
        case .forkSession:
            guard let connection else { return }
            do { connection.present(try await connection.fork(sessionId: sessionId)) } catch { show(error) }
        case .dropSession, .deleteSession:
            if confirmation?.action != action {
                confirmation = PendingConfirmation(
                    title: action == .dropSession ? "이 세션을 삭제하고 새 세션을 시작할까요?" : "이 세션을 삭제할까요?",
                    message: "호스트의 gjc 세션 기록이 지워집니다.", action: action)
                return
            }
            confirmation = nil
            await deleteSelf(startNew: action == .dropSession)
        case .openSessions:
            connection?.requestSessions()
        case .copyLastAnswer:
            if let text = transcript.lastAgentText {
                UIPasteboard.general.string = text
                transcript.appendNotice("마지막 답변을 복사했습니다.")
            } else {
                errorMessage = "복사할 답변이 없습니다."
            }
        case .shareTranscript:
            shareText = transcript.plainText
        case .showHelp:
            draft = "/"
        }
    }

    // MARK: /btw side chat

    func openBtw(question: String = "") {
        if btw == nil {
            btw = BtwConversation()
            btwEpoch += 1
        }
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        btwDraft = text
        Task { await askBtw() }
    }

    func closeBtw() {
        btw = nil
        btwDraft = ""
        btwEpoch += 1
    }

    /// Sends the bubble's draft as a side question, with the answered exchanges as follow-up context.
    func askBtw() async {
        guard var conversation = btw, let client = connection?.connectedClient else { return }
        let input: JSONValue
        switch conversation.ask(btwDraft) {
        case let .success(value): input = value
        case let .failure(rejection):
            errorMessage = rejection.message
            return
        }
        btw = conversation
        btwDraft = ""
        let epoch = btwEpoch
        do {
            let result = try await reopening(client) { try await client.sdkControl(sessionId, "turn.btw", input: input) }
            guard epoch == btwEpoch else { return }
            btw?.finish(result: result)
        } catch {
            guard epoch == btwEpoch else { return }
            btw?.fail((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }

    /// Forks this session and opens the copy with the side chat as its draft, so it can be continued there.
    func forkBtw() async {
        guard let conversation = btw, conversation.hasAnswer, let connection else { return }
        sending = true
        defer { sending = false }
        do {
            let forked = try await connection.fork(sessionId: sessionId)
            forked.draft = conversation.forkDraft
            closeBtw()
            connection.present(forked)
        } catch {
            show(error)
        }
    }

    func confirm(_ pending: PendingConfirmation) async {
        confirmation = pending
        await perform(pending.action)
    }

    private func confirmTitle(op: String, input: JSONValue) -> String {
        switch op {
        case "context.clear": "컨텍스트를 비울까요?"
        case "mode.goal.operate" where input["op"]?.string == "drop": "목표를 포기할까요?"
        default: "\(op) 실행"
        }
    }

    private func control(_ op: String, input: JSONValue, confirm: Bool, notice: String) async {
        guard let client = connection?.connectedClient else { return }
        sending = true
        defer { sending = false }
        do {
            let result = try await reopening(client) { try await client.sdkControl(sessionId, op, input: input, confirm: confirm) }
            transcript.appendNotice(describe(op: op, result: result) ?? notice)
            if op == "session.rename", let name = input["name"]?.string {
                renamedTitle = name
                connection?.renamed(sessionId: sessionId, title: name)
            }
            if op == "service_tier.set" { fastMode = input["tier"]?.string == "priority" }
            await refreshInsights(using: client)
        } catch {
            show(error)
        }
    }

    private func describe(op: String, result: JSONValue) -> String? {
        switch op {
        case "session.export_html":
            return (result["path"]?.string ?? result["file"]?.string).map { "HTML로 내보냈습니다: \($0)" }
        case "compaction.run":
            guard let before = result["tokensBefore"]?.int else { return nil }
            return "컨텍스트를 압축했습니다. 압축 전 \(before.compactTokens) 토큰."
        default:
            return nil
        }
    }

    func rename() async {
        let name = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        await control("session.rename", input: ["name": .string(name)], confirm: false, notice: "이름을 바꿨습니다.")
    }

    func setFast(_ on: Bool) async {
        await control("service_tier.set", input: ["tier": on ? "priority" : "none"], confirm: false,
                      notice: on ? "우선 처리 티어를 켰습니다." : "우선 처리 티어를 껐습니다.")
    }

    /// The session menu's permission-mode item: each tap moves to the next mode (prompt → allow → deny).
    func cyclePermissionMode() async {
        guard let current = permissionMode, let client = connection?.connectedClient else { return }
        let mode = current.next
        sending = true
        defer { sending = false }
        do {
            // The bridge's x_gjcm_permission_mode update moves the menu label, here and on other phones.
            try await reopening(client) { try await client.setPermissionMode(sessionId, mode: mode) }
            transcript.appendNotice("권한모드를 '\(mode.label)'(으)로 바꿨습니다.")
        } catch {
            show(error)
        }
    }

    func operateGoal(_ op: String, objective: String? = nil) async {
        var input: [String: JSONValue] = ["op": .string(op)]
        if let objective { input["objective"] = .string(objective) }
        await control("mode.goal.operate", input: .object(input), confirm: false, notice: "목표: \(op)")
        await refresh(.goal)
    }

    private func deleteSelf(startNew: Bool) async {
        guard let connection else { return }
        do {
            try await connection.delete(sessionId: sessionId)
            connection.requestNewChat(cwd: startNew ? cwd : nil)
        } catch {
            show(error)
        }
    }

    func respond(_ request: PermissionRequest, option: PermissionOption?) async {
        guard let client = connection?.connectedClient else { return }
        do {
            try await client.respondPermission(request.requestId, optionId: option?.optionId)
            removePermission(request.requestId)
        } catch {
            show(error)
        }
    }

    func setConfig(_ option: ConfigOption, value: String) async {
        guard let client = connection?.connectedClient else { return }
        do {
            transcript.setConfigOptions(try await reopening(client) { try await client.setConfig(sessionId, configId: option.id, value: value) })
            await refreshInsights(using: client)
        } catch {
            show(error)
        }
    }

    // MARK: Model roles

    func loadModelRoles() async throws {
        guard let client = connection?.connectedClient else { throw BridgeError.disconnected }
        modelRoles = try await client.modelRoles()
    }

    /// Like gjc's `/model`: the default role also switches this session; subagent roles and image only
    /// apply to sessions and subagents started afterwards.
    func setRole(_ role: ModelRoles.Role, to selector: ModelSelector?) async throws {
        guard let client = connection?.connectedClient else { throw BridgeError.disconnected }
        modelRoles = try await reopening(client) { try await client.setModelRole(sessionId, role: role.id, value: selector) }
        guard role.id == "default", let selector else { return }
        if let option = configOption(.model), option.currentValue?.string != selector.model {
            transcript.setConfigOptions(try await reopening(client) { try await client.setConfig(sessionId, configId: option.id, value: selector.model) })
        }
        if let thinking = selector.thinking, let option = configOption(.thinking), option.currentValue?.string != thinking,
           option.choices.contains(where: { $0.value == thinking }) {
            transcript.setConfigOptions(try await reopening(client) { try await client.setConfig(sessionId, configId: option.id, value: thinking) })
        }
        await refreshInsights(using: client)
    }

    /// Session-only change (gjc's ACP config option), not persisted to a role.
    func setSessionConfig(_ target: ConfigTarget, value: String) async throws {
        guard let client = connection?.connectedClient else { throw BridgeError.disconnected }
        guard let option = configOption(target) else { return }
        transcript.setConfigOptions(try await reopening(client) { try await client.setConfig(sessionId, configId: option.id, value: value) })
        await refreshInsights(using: client)
    }

    // MARK: Insights

    func refreshInsights(using client: BridgeClient? = nil) async {
        guard let client = client ?? connection?.connectedClient else { return }
        context = ContextUsage(try? await query(client, "context.get").first)
        todos = TodoPhase.parse((try? await query(client, "todo.list")) ?? [])
        goal = GoalState(try? await query(client, "goal.list/get").first)
    }

    private func refreshTodos() async {
        guard let client = connection?.connectedClient else { return }
        todos = TodoPhase.parse((try? await query(client, "todo.list")) ?? [])
    }

    func refresh(_ topic: InfoTopic) async {
        guard let client = connection?.connectedClient else { return }
        do {
            switch topic {
            case .context:
                context = ContextUsage(try await query(client, "context.get").first)
                usage = UsageTotals(try await query(client, "usage.get").first)
            case .usage:
                usage = UsageTotals(try await query(client, "usage.get").first)
            case .session:
                metadata = try await query(client, "session.metadata").first
                usage = UsageTotals(try await query(client, "session.stats").first)
            case .jobs:
                jobs = JobsSnapshot(try await query(client, "runtime.jobs.list").first)
            case .todos:
                todos = TodoPhase.parse(try await query(client, "todo.list"))
            case .goal:
                goal = GoalState(try await query(client, "goal.list/get").first)
            }
        } catch {
            show(error)
        }
    }

    private func show(_ error: Error) {
        errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}

extension ConfigTarget {
    var label: String {
        switch self {
        case .model: "모델"
        case .thinking: "추론 강도"
        case .mode: "모드"
        }
    }
}
