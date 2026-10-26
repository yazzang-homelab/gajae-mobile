import GjcMobileCore
import SwiftUI

/// gjc `/model` and `/effort` on the phone: this session's model and effort, and the model + effort per role
/// (default, executor, architect, planner, critic) that gjc saves in the host's config.yml.
struct ModelSettingsSheet: View {
    let chat: ChatModel
    @Environment(\.dismiss) private var dismiss
    @State private var loadError: String?

    enum Destination: Hashable {
        case session
        case role(String)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink(value: Destination.session) {
                        SettingRow(title: "이 세션",
                                   model: modelName(chat.configOption(.model)?.currentValue?.string),
                                   effort: chat.configOption(.thinking)?.currentChoiceName)
                    }
                } footer: {
                    Text("지금 열린 세션에만 적용됩니다.")
                }
                .listRowBackground(Palette.shell)

                Section {
                    if let roles = chat.modelRoles {
                        ForEach(roles.roles) { role in
                            NavigationLink(value: Destination.role(role.id)) {
                                SettingRow(title: role.name,
                                           model: role.selector.map { modelName($0.model) } ?? "지정 안 함",
                                           effort: role.selector?.thinking)
                            }
                            .disabled(roles.profile != nil)
                        }
                    } else if let loadError {
                        Label(loadError, systemImage: "exclamationmark.triangle").foregroundStyle(Palette.gajaeRed)
                    } else {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                } header: {
                    Text("역할별 모델")
                } footer: {
                    if let profile = chat.modelRoles?.profile {
                        Text("모델 프로필 '\(profile)'이 켜져 있어 역할 모델은 호스트의 /model에서 바꿔야 합니다.")
                    } else {
                        Text("기본은 이 세션과 앞으로 여는 세션에, 나머지는 해당 서브에이전트에 쓰입니다. 호스트 gjc 설정에 저장됩니다.")
                    }
                }
                .listRowBackground(Palette.shell)
            }
            .scrollContentBackground(.hidden)
            .background(Palette.ink)
            .navigationTitle("모델")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("닫기") { dismiss() } } }
            .navigationDestination(for: Destination.self) { destination in
                ModelChoiceView(chat: chat, destination: destination)
            }
            .task { await load() }
            .refreshable { await load() }
        }
        .presentationDetents([.large])
    }

    private func load() async {
        do {
            try await chat.loadModelRoles()
            loadError = nil
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func modelName(_ value: String?) -> String {
        guard let value else { return "-" }
        return chat.configOption(.model)?.choices.first { $0.value == value }?.name ?? value
    }
}

private struct SettingRow: View {
    let title: String
    let model: String
    let effort: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.cream)
            HStack(spacing: 6) {
                Text(model).lineLimit(1)
                if let effort {
                    Text(effort)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Palette.shellLine, in: Capsule())
                }
            }
            .font(.caption).foregroundStyle(Palette.muted)
        }
    }
}

/// Effort chips and a searchable, provider-grouped model list for the session or one role. A choice is
/// applied right away; the row shows progress until the host confirms, and failures stay on screen.
private struct ModelChoiceView: View {
    let chat: ChatModel
    let destination: ModelSettingsSheet.Destination
    @State private var query = ""
    @State private var applying: String?
    @State private var error: String?

    private var role: ModelRoles.Role? {
        guard case let .role(id) = destination else { return nil }
        return chat.modelRoles?.roles.first { $0.id == id }
    }

    private var currentModel: String? {
        switch destination {
        case .session: chat.configOption(.model)?.currentValue?.string
        case .role: role?.selector?.model
        }
    }

    private var currentEffort: String? {
        switch destination {
        case .session: chat.configOption(.thinking)?.currentValue?.string
        case .role: role?.selector?.thinking
        }
    }

    /// gjc's levels as this session's thinking option lists them; roles may also inherit.
    private var efforts: [String] {
        let levels = chat.configOption(.thinking)?.choices.map(\.value) ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        switch destination {
        case .session: return levels
        case .role: return ["inherit"] + levels
        }
    }

    var body: some View {
        List {
            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(Palette.gajaeRed)
                }
                .listRowBackground(Palette.shell)
            }
            Section("추론 강도") {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(efforts, id: \.self) { level in
                            let selected = (currentEffort ?? "inherit") == level
                            Button {
                                apply(model: currentModel, effort: level, key: "effort:\(level)")
                            } label: {
                                HStack(spacing: 4) {
                                    if applying == "effort:\(level)" { ProgressView().controlSize(.mini) }
                                    Text(level == "inherit" ? "상속" : level)
                                }
                                .font(.callout)
                                .padding(.horizontal, 12).padding(.vertical, 6)
                                .foregroundStyle(selected ? Palette.ink : Palette.cream)
                                .background(selected ? Palette.visorGreen : Palette.shellLine, in: Capsule())
                            }
                            .buttonStyle(.plain)
                            .disabled(currentModel == nil)
                            .accessibilityAddTraits(selected ? .isSelected : [])
                        }
                    }
                    .padding(.vertical, 4)
                }
                if currentModel == nil {
                    Text("먼저 모델을 고르세요.").font(.caption).foregroundStyle(Palette.muted)
                }
            }
            .listRowBackground(Palette.shell)

            if let role, role.id != "default", role.value != nil {
                Section {
                    Button(role: .destructive) { clearRole(role) } label: {
                        HStack {
                            Text("지정 해제 — gjc 기본값 사용")
                            Spacer()
                            if applying == "clear" { ProgressView() }
                        }
                    }
                }
                .listRowBackground(Palette.shell)
            }

            ForEach(groups, id: \.name) { group in
                Section(group.name) {
                    ForEach(group.choices, id: \.value) { choice in
                        Button {
                            apply(model: choice.value, effort: currentEffort, key: "model:\(choice.value)")
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(choice.name).foregroundStyle(Palette.cream)
                                    if choice.name != choice.value {
                                        Text(choice.value).font(.caption2.monospaced()).foregroundStyle(Palette.muted)
                                    }
                                }
                                Spacer()
                                if applying == "model:\(choice.value)" {
                                    ProgressView()
                                } else if currentModel == choice.value {
                                    Image(systemName: "checkmark").foregroundStyle(Palette.visorGreen)
                                }
                            }
                        }
                    }
                }
                .listRowBackground(Palette.shell)
            }
        }
        .disabled(applying != nil)
        .scrollContentBackground(.hidden)
        .background(Palette.ink)
        .searchable(text: $query, prompt: "모델 검색")
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var title: String {
        switch destination {
        case .session: "이 세션"
        case .role: role?.name ?? "역할"
        }
    }

    private struct ChoiceGroup {
        let name: String
        let choices: [ConfigOption.Choice]
    }

    /// gjc lists ~1000 models; group them by provider (`provider/...`) so the list is scannable.
    private var groups: [ChoiceGroup] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let choices = chat.configOption(.model)?.choices ?? []
        let visible = choices.filter { q.isEmpty || $0.name.lowercased().contains(q) || $0.value.lowercased().contains(q) }
        var order: [String] = []
        var map: [String: [ConfigOption.Choice]] = [:]
        for choice in visible {
            let key = choice.group ?? choice.value.split(separator: "/", maxSplits: 1).first.map(String.init) ?? ""
            if map[key] == nil { order.append(key) }
            map[key, default: []].append(choice)
        }
        return order.map { ChoiceGroup(name: $0, choices: map[$0] ?? []) }
    }

    private func apply(model: String?, effort: String?, key: String) {
        guard let model else { return }
        run(key) {
            switch destination {
            case .session:
                if model != currentModel { try await chat.setSessionConfig(.model, value: model) }
                if let effort, effort != "inherit", effort != currentEffort { try await chat.setSessionConfig(.thinking, value: effort) }
            case .role:
                guard let role else { return }
                try await chat.setRole(role, to: ModelSelector(model: model, thinking: effort))
            }
        }
    }

    private func clearRole(_ role: ModelRoles.Role) {
        run("clear") { try await chat.setRole(role, to: nil) }
    }

    private func run(_ key: String, _ body: @escaping () async throws -> Void) {
        applying = key
        error = nil
        Task {
            defer { applying = nil }
            do {
                try await body()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}
