import Foundation

/// gjc's `/` commands as the phone runs them.
///
/// Over ACP gjc only executes `/skill:<name>`; every builtin (`/context`, `/compact`, `/model`, …) reaches the
/// model as plain text (measured on gjc 0.18.7). The same features exist as `_gjc/sdk/query|control`
/// operations and ACP session methods, so each builtin is mapped to the native call that does the same work.
/// Commands that only make sense in the host terminal (login, theme, ssh, …) are listed with the reason.
public struct SlashCommand: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable {
        case native
        case skill
        case hostOnly(reason: String)
    }

    public var id: String { name }
    public let name: String
    public let summary: String
    public let argumentHint: String?
    public let kind: Kind

    public init(name: String, summary: String, argumentHint: String? = nil, kind: Kind = .native) {
        self.name = name
        self.summary = summary
        self.argumentHint = argumentHint
        self.kind = kind
    }

    public var isRunnable: Bool {
        if case .hostOnly = kind { return false }
        return true
    }
}

public enum InfoTopic: String, Equatable, Sendable, CaseIterable {
    case context, usage, session, jobs, todos, goal

    public var title: String {
        switch self {
        case .context: "컨텍스트"
        case .usage: "사용량"
        case .session: "세션 정보"
        case .jobs: "백그라운드 작업"
        case .todos: "할 일"
        case .goal: "목표"
        }
    }
}

public enum ConfigTarget: String, Equatable, Sendable, Identifiable {
    case model, thinking, mode

    public var id: String { rawValue }

    /// gjc's ACP config option ids/categories (acp-agent.ts: `mode`, `model`, `thinking`/`thought_level`).
    public func matches(_ option: ConfigOption) -> Bool {
        switch self {
        case .model: option.id == "model" || option.category == "model"
        case .thinking: option.id == "thinking" || option.category == "thought_level"
        case .mode: option.id == "mode" || option.category == "mode"
        }
    }
}

public enum SlashAction: Equatable, Sendable {
    case showInfo(InfoTopic)
    /// `_gjc/sdk/control` call; `confirm` asks the user first and is passed through as `confirm:true`.
    case control(op: String, input: JSONValue, confirm: Bool, notice: String)
    case pickConfig(ConfigTarget)
    case setConfig(ConfigTarget, query: String)
    case askRename
    case newSession
    case dropSession
    case deleteSession
    case forkSession
    /// `/btw [질문]`: the side-chat bubble (`turn.btw`), asking `question` right away when it is not empty.
    case openBtw(question: String)
    case openSessions
    case copyLastAnswer
    case shareTranscript
    case showHelp
}

public enum SlashResolution: Equatable, Sendable {
    /// Plain prompt text.
    case notCommand
    case run(SlashAction)
    /// gjc runs it itself over ACP (`/skill:…` and skill aliases): send the text unchanged.
    case sendAsPrompt
    case hostOnly(name: String, reason: String)
    case missingArgument(name: String, hint: String)
    case invalidArgument(name: String, message: String)
    case unknown(name: String)
}

public enum SlashCommandCatalog {
    private static let terminal = "호스트 터미널의 gjc에서만 쓸 수 있습니다."

    /// Top-level gjc builtins (slash-commands/builtin-registry.ts, gjc 0.18.7) in palette order.
    public static let builtins: [SlashCommand] = [
        SlashCommand(name: "context", summary: "컨텍스트 토큰 사용량"),
        SlashCommand(name: "usage", summary: "토큰·비용 사용량"),
        SlashCommand(name: "compact", summary: "컨텍스트를 압축하고 이어서 진행"),
        SlashCommand(name: "model", summary: "세션·역할별 모델 선택", argumentHint: "[모델]"),
        SlashCommand(name: "effort", summary: "세션·역할별 추론 강도", argumentHint: "[low|medium|high…]"),
        SlashCommand(name: "fast", summary: "우선 처리 티어 켜기·끄기", argumentHint: "on|off"),
        SlashCommand(name: "plan", summary: "플랜 모드", kind: .hostOnly(reason: "gjc ACP 세션에는 플랜 모드 수명주기가 없어 원격에서 켤 수 없습니다. PC 터미널에서 실행하세요.")),
        SlashCommand(name: "goal", summary: "목표 보기·설정·일시정지·재개·포기", argumentHint: "[set <목표>|pause|resume|drop]"),
        SlashCommand(name: "todos", summary: "할 일 목록"),
        SlashCommand(name: "session", summary: "세션 정보·삭제", argumentHint: "[info|delete]"),
        SlashCommand(name: "rename", summary: "세션 이름 바꾸기", argumentHint: "[이름]"),
        SlashCommand(name: "btw", summary: "본 대화와 별개로 잠깐 묻기(기록에 안 남음)", argumentHint: "[질문]"),
        SlashCommand(name: "fork", summary: "이 세션을 복제해 새 세션으로 이어가기"),
        SlashCommand(name: "new", summary: "같은 디렉터리에서 새 세션"),
        SlashCommand(name: "clear", summary: "세션은 유지하고 컨텍스트 비우기"),
        SlashCommand(name: "drop", summary: "이 세션을 삭제하고 새 세션 시작"),
        SlashCommand(name: "resume", summary: "다른 세션 열기"),
        SlashCommand(name: "sessions", summary: "세션 목록"),
        SlashCommand(name: "export", summary: "세션을 HTML로 내보내기(호스트에 저장)"),
        SlashCommand(name: "copy", summary: "마지막 답변 복사"),
        SlashCommand(name: "dump", summary: "대화 전체를 텍스트로 공유"),
        SlashCommand(name: "transcript", summary: "대화 전체를 텍스트로 공유"),
        SlashCommand(name: "jobs", summary: "백그라운드 작업 상태"),
        SlashCommand(name: "help", summary: "명령 도움말"),
        SlashCommand(name: "retry", summary: "마지막 턴 재시도", kind: .hostOnly(reason: "모바일에서는 마지막 메시지를 다시 보내세요.")),
        SlashCommand(name: "handoff", summary: "핸드오프 후 새 세션", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "move", summary: "세션 작업 디렉터리 이동", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "star", summary: "세션 별표", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "unstar", summary: "세션 별표 해제", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "tree", summary: "세션 트리 탐색", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "mcp", summary: "MCP 서버 상태", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "extensions", summary: "스킬·훅·MCP 설정", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "agents", summary: "에이전트 대시보드", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "monitors", summary: "모니터·크론 작업", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "memory", summary: "메모리 관리", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "mm", summary: "멘탈 모델", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "routing", summary: "서브에이전트 모델 라우팅", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "credential", summary: "세션 계정 전환", kind: .hostOnly(reason: "구독 인증 정보는 호스트를 떠나지 않습니다.")),
        SlashCommand(name: "login", summary: "OAuth 로그인", kind: .hostOnly(reason: "구독 인증 정보는 호스트를 떠나지 않습니다.")),
        SlashCommand(name: "logout", summary: "OAuth 로그아웃", kind: .hostOnly(reason: "구독 인증 정보는 호스트를 떠나지 않습니다.")),
        SlashCommand(name: "provider", summary: "프로바이더 설정", kind: .hostOnly(reason: "구독 인증 정보는 호스트를 떠나지 않습니다.")),
        SlashCommand(name: "notify", summary: "알림 설정", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "settings", summary: "설정", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "language", summary: "UI 언어", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "theme", summary: "테마", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "pet", summary: "가재 펫", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "hotkeys", summary: "단축키", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "tutorial", summary: "온보딩", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "changelog", summary: "변경 기록", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "ssh", summary: "SSH 호스트 관리", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "aside", summary: "Aside CLI", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "import-session", summary: "외부 대화 가져오기", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "contribute-pr", summary: "PR 작업 프롬프트", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "background", summary: "백그라운드로 분리", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "debug", summary: "디버그 도구", kind: .hostOnly(reason: terminal)),
        SlashCommand(name: "exit", summary: "종료", kind: .hostOnly(reason: "앱에서 나가면 됩니다. 세션은 호스트에 남습니다.")),
    ]

    /// Palette rows for a draft like `/co`: runnable matches first, skills next, host-only last.
    public static func suggestions(for draft: String, skills: [String]) -> [SlashCommand] {
        guard draft.hasPrefix("/"), !draft.contains("\n") else { return [] }
        let typed = String(draft.dropFirst())
        guard !typed.contains(" ") else { return [] }
        let needle = typed.lowercased()
        let skillRows = skills.map { name in
            SlashCommand(name: name.hasPrefix("skill:") ? name : "skill:\(name)", summary: "스킬 실행", argumentHint: "[인자]", kind: .skill)
        }
        let all = builtins + skillRows
        let matching = needle.isEmpty ? all : all.filter { $0.name.lowercased().hasPrefix(needle) || ($0.kind == .skill && $0.name.lowercased().contains(needle)) }
        return matching.filter { $0.kind == .native } + matching.filter { $0.kind == .skill } + matching.filter { !$0.isRunnable }
    }

    public static func resolve(_ text: String, skills: [String] = []) -> SlashResolution {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/"), trimmed.count > 1 else { return .notCommand }
        let body = trimmed.dropFirst()
        let name = body.prefix { !$0.isWhitespace }.lowercased()
        // A path such as `/etc/hosts …` is prose, not a command.
        if name.contains("/") { return .notCommand }
        let args = body.dropFirst(name.count).trimmingCharacters(in: .whitespacesAndNewlines)
        let words = args.split(whereSeparator: \.isWhitespace).map { String($0) }

        if name.hasPrefix("skill:") || skills.contains(name) || skills.contains("skill:\(name)") { return .sendAsPrompt }
        guard let command = builtins.first(where: { $0.name == name }) else { return .unknown(name: name) }
        if case let .hostOnly(reason) = command.kind { return .hostOnly(name: name, reason: reason) }

        switch name {
        case "context": return .run(.showInfo(.context))
        case "usage": return .run(.showInfo(.usage))
        case "todos": return .run(.showInfo(.todos))
        case "jobs": return .run(.showInfo(.jobs))
        case "compact": return .run(.control(op: "compaction.run", input: [:], confirm: false, notice: "컨텍스트를 압축했습니다."))
        case "clear": return .run(.control(op: "context.clear", input: [:], confirm: true, notice: "컨텍스트를 비웠습니다."))
        case "export": return .run(.control(op: "session.export_html", input: [:], confirm: false, notice: "HTML로 내보냈습니다."))
        case "model": return args.isEmpty ? .run(.pickConfig(.model)) : .run(.setConfig(.model, query: args))
        case "effort": return args.isEmpty ? .run(.pickConfig(.thinking)) : .run(.setConfig(.thinking, query: args))
        case "fast":
            switch words.first?.lowercased() {
            case "on": return .run(.control(op: "service_tier.set", input: ["tier": "priority"], confirm: false, notice: "우선 처리 티어를 켰습니다."))
            case "off": return .run(.control(op: "service_tier.set", input: ["tier": "none"], confirm: false, notice: "우선 처리 티어를 껐습니다."))
            case nil: return .missingArgument(name: name, hint: "on|off")
            default: return .invalidArgument(name: name, message: "on 또는 off만 쓸 수 있습니다.")
            }
        case "goal":
            guard let sub = words.first?.lowercased() else { return .run(.showInfo(.goal)) }
            switch sub {
            case "show": return .run(.showInfo(.goal))
            case "set":
                let objective = args.dropFirst(words[0].count).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !objective.isEmpty else { return .missingArgument(name: "goal set", hint: "<목표>") }
                return .run(.control(op: "mode.goal.operate", input: ["op": "create", "objective": .string(objective)], confirm: false, notice: "목표를 설정했습니다."))
            case "pause": return .run(.control(op: "mode.goal.operate", input: ["op": "pause"], confirm: false, notice: "목표를 일시정지했습니다."))
            case "resume": return .run(.control(op: "mode.goal.operate", input: ["op": "resume"], confirm: false, notice: "목표를 재개했습니다."))
            case "drop": return .run(.control(op: "mode.goal.operate", input: ["op": "drop"], confirm: true, notice: "목표를 포기했습니다."))
            default: return .invalidArgument(name: name, message: "set, pause, resume, drop, show 중 하나를 쓰세요.")
            }
        case "session":
            switch words.first?.lowercased() {
            case nil, "info": return .run(.showInfo(.session))
            case "delete": return .run(.deleteSession)
            default: return .invalidArgument(name: name, message: "info 또는 delete를 쓰세요.")
            }
        case "rename":
            return args.isEmpty ? .run(.askRename) : .run(.control(op: "session.rename", input: ["name": .string(args)], confirm: false, notice: "이름을 바꿨습니다."))
        case "btw": return .run(.openBtw(question: args))
        case "fork": return .run(.forkSession)
        case "new": return .run(.newSession)
        case "drop": return .run(.dropSession)
        case "resume", "sessions": return .run(.openSessions)
        case "copy": return .run(.copyLastAnswer)
        case "dump", "transcript": return .run(.shareTranscript)
        case "help": return .run(.showHelp)
        default: return .unknown(name: name)
        }
    }
}

public extension ConfigOption {
    /// Picks the choice a typed `/model sonnet` or `/effort high` means: exact value, exact name, then
    /// a unique case-insensitive substring of value or name. `nil` when nothing or several match.
    func choice(matching query: String) -> Choice? {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return nil }
        if let exact = choices.first(where: { $0.value.lowercased() == q || $0.name.lowercased() == q }) { return exact }
        let partial = choices.filter { $0.value.lowercased().contains(q) || $0.name.lowercased().contains(q) }
        return partial.count == 1 ? partial[0] : nil
    }
}
