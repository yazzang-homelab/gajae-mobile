import GjcMobileCore
import SwiftUI
import UIKit

/// Circular context-window meter (Claude Code's context indicator; gjc `/context`).
struct ContextRing: View {
    let context: ContextUsage?

    var body: some View {
        let fraction = context?.fraction ?? 0
        ZStack {
            Circle().stroke(Palette.shellLine, lineWidth: 3)
            Circle().trim(from: 0, to: fraction)
                .stroke(color(fraction), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text(context.map { "\(Int($0.percent.rounded()))" } ?? "–")
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .foregroundStyle(Palette.cream)
        }
        .frame(width: 26, height: 26)
        .accessibilityLabel(context.map { "컨텍스트 \(Int($0.percent.rounded()))퍼센트 사용" } ?? "컨텍스트 정보 없음")
    }

    private func color(_ fraction: Double) -> Color {
        switch fraction {
        case ..<0.6: Palette.visorGreen
        case ..<0.85: Palette.strawGold
        default: Palette.gajaeRed
        }
    }
}

/// `/` command palette above the composer (ChatGPT/Claude composer suggestion list).
struct SlashPalette: View {
    let commands: [SlashCommand]
    let onPick: (SlashCommand) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(commands) { command in
                    Button { onPick(command) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("/\(command.name)").font(.callout.monospaced())
                                .foregroundStyle(command.isRunnable ? Palette.cream : Palette.muted)
                            if let hint = command.argumentHint {
                                Text(hint).font(.caption.monospaced()).foregroundStyle(Palette.muted)
                            }
                            Spacer(minLength: 8)
                            Text(command.summary).font(.caption).foregroundStyle(Palette.muted).lineLimit(1)
                            if case .skill = command.kind {
                                Image(systemName: "sparkles").font(.caption2).foregroundStyle(Palette.strawGold)
                            } else if !command.isRunnable {
                                Image(systemName: "desktopcomputer").font(.caption2).foregroundStyle(Palette.muted)
                            }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Divider().overlay(Palette.shellLine)
                }
            }
        }
        .frame(maxHeight: 240)
        .card()
    }
}

/// One-line live todo strip (Claude Code's task list, gjc `todo_write`). Tap opens the full list.
struct TodoStrip: View {
    let todos: [TodoPhase]
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                Image(systemName: "checklist").foregroundStyle(Palette.strawGold)
                Text("\(todos.doneCount)/\(todos.taskCount)").font(.caption.monospacedDigit()).foregroundStyle(Palette.muted)
                Text(todos.current?.content ?? (todos.doneCount == todos.taskCount ? "할 일 완료" : "대기 중"))
                    .font(.caption).foregroundStyle(Palette.cream).lineLimit(1)
                Spacer()
                ProgressView(value: Double(todos.doneCount), total: Double(max(todos.taskCount, 1)))
                    .tint(Palette.visorGreen).frame(width: 50)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .card()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("할 일 \(todos.taskCount)개 중 \(todos.doneCount)개 완료")
    }
}

struct InfoSheetView: View {
    let chat: ChatModel
    let topic: InfoTopic
    @Environment(\.dismiss) private var dismiss
    @State private var objective = ""

    var body: some View {
        NavigationStack {
            List { content }
                .scrollContentBackground(.hidden)
                .background(Palette.ink)
                .navigationTitle(topic.title)
                .navigationBarTitleDisplayMode(.inline)
                .refreshable { await chat.refresh(topic) }
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("닫기") { dismiss() } }
                }
        }
        .presentationDetents([.medium, .large])
        .task { await chat.refresh(topic) }
    }

    @ViewBuilder private var content: some View {
        switch topic {
        case .context:
            if let ctx = chat.context {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        ProgressView(value: ctx.fraction).tint(ctx.fraction < 0.85 ? Palette.visorGreen : Palette.gajaeRed)
                        Text("\(ctx.tokens.compactTokens) / \(ctx.contextWindow.compactTokens) 토큰 (\(String(format: "%.1f", ctx.percent))%)")
                            .font(.callout.monospacedDigit())
                        if ctx.estimated { Text("추정치입니다. 다음 응답 뒤 실측값으로 바뀝니다.").font(.caption).foregroundStyle(Palette.muted) }
                    }
                    row("남은 토큰", ctx.remainingTokens.compactTokens)
                    if let chars = ctx.systemPromptChars { row("시스템 프롬프트", "\(chars.compactTokens)자") }
                    row("끼어들기 대기", "\(ctx.steeringQueueDepth)")
                    row("후속 메시지 대기", "\(ctx.followUpQueueDepth)")
                }
                .listRowBackground(Palette.shell)
                Section {
                    Button { Task { await chat.perform(.control(op: "compaction.run", input: [:], confirm: false, notice: "컨텍스트를 압축했습니다.")) } } label: {
                        Label("지금 압축", systemImage: "arrow.down.right.and.arrow.up.left")
                    }
                    Button(role: .destructive) { Task { await chat.perform(.control(op: "context.clear", input: [:], confirm: true, notice: "컨텍스트를 비웠습니다.")) } } label: {
                        Label("컨텍스트 비우기", systemImage: "trash")
                    }
                }
                .listRowBackground(Palette.shell)
            } else {
                empty("컨텍스트 정보를 불러오지 못했습니다.")
            }
            usageSection
        case .usage, .session:
            if topic == .session, let meta = chat.metadata {
                Section("세션") {
                    row("ID", meta["sessionId"]?.string ?? chat.sessionId, mono: true)
                    row("디렉터리", meta["cwd"]?.string ?? chat.cwd, mono: true)
                    if let kind = meta["kind"]?.string { row("종류", kind) }
                    if let option = chat.configOption(.model) { row("모델", option.currentChoiceName ?? "-") }
                }
                .listRowBackground(Palette.shell)
            }
            usageSection
        case .jobs:
            if let jobs = chat.jobs {
                Section("실행 중 \(jobs.running.count)") { jobRows(jobs.running) }.listRowBackground(Palette.shell)
                Section("최근 \(jobs.recent.count)") { jobRows(jobs.recent) }.listRowBackground(Palette.shell)
                if jobs.queuedDeliveries > 0 { row("전달 대기", "\(jobs.queuedDeliveries)").listRowBackground(Palette.shell) }
            } else {
                empty("백그라운드 작업 정보를 불러오지 못했습니다.")
            }
        case .todos:
            if chat.todos.isEmpty { empty("할 일이 없습니다. 에이전트가 todo_write로 만들면 여기에 나타납니다.") }
            ForEach(Array(chat.todos.enumerated()), id: \.offset) { _, phase in
                Section(phase.name.isEmpty ? "할 일" : phase.name) {
                    ForEach(Array(phase.tasks.enumerated()), id: \.offset) { _, task in
                        HStack(alignment: .firstTextBaseline) {
                            Image(systemName: icon(task.status)).foregroundStyle(task.isDone ? Palette.visorGreen : Palette.strawGold)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(task.content).strikethrough(task.status == "abandoned")
                                ForEach(task.notes, id: \.self) { Text($0).font(.caption).foregroundStyle(Palette.muted) }
                            }
                        }
                    }
                }
                .listRowBackground(Palette.shell)
            }
        case .goal:
            goalContent
        }
    }

    @ViewBuilder private var goalContent: some View {
        if let goal = chat.goal, goal.enabled, let text = goal.objective {
            Section("현재 목표") {
                Text(text)
                if let status = goal.status { row("상태", status) }
            }
            .listRowBackground(Palette.shell)
            Section {
                Button { Task { await chat.operateGoal("pause") } } label: { Label("일시정지", systemImage: "pause.circle") }
                Button { Task { await chat.operateGoal("resume") } } label: { Label("재개", systemImage: "play.circle") }
                Button { Task { await chat.operateGoal("complete") } } label: { Label("완료 처리", systemImage: "checkmark.circle") }
                Button(role: .destructive) {
                    Task { await chat.perform(.control(op: "mode.goal.operate", input: ["op": "drop"], confirm: true, notice: "목표를 포기했습니다.")) }
                } label: { Label("포기", systemImage: "xmark.circle") }
            }
            .listRowBackground(Palette.shell)
        } else {
            if let message = chat.goal?.message { empty(message) }
            Section("새 목표") {
                TextField("이 세션이 끝까지 해낼 목표", text: $objective, axis: .vertical)
                Button("목표 설정") {
                    let text = objective.trimmingCharacters(in: .whitespacesAndNewlines)
                    Task { await chat.operateGoal("create", objective: text) }
                    objective = ""
                }
                .disabled(objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .listRowBackground(Palette.shell)
        }
    }

    @ViewBuilder private var usageSection: some View {
        if let usage = chat.usage {
            Section("토큰 사용량") {
                row("입력", usage.input.compactTokens)
                row("출력", usage.output.compactTokens)
                row("캐시 읽기", usage.cacheRead.compactTokens)
                row("캐시 쓰기", usage.cacheWrite.compactTokens)
                row("합계", usage.totalTokens.compactTokens)
                if usage.premiumRequests > 0 { row("프리미엄 요청", "\(usage.premiumRequests)") }
                row("비용", usage.cost > 0 ? String(format: "$%.4f", usage.cost) : "구독(0)")
            }
            .listRowBackground(Palette.shell)
        }
    }

    private func jobRows(_ jobs: [JobsSnapshot.Job]) -> some View {
        ForEach(Array(jobs.enumerated()), id: \.offset) { _, job in
            row(job.label, job.status)
        }
    }

    private func row(_ label: String, _ value: String, mono: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(Palette.muted)
            Spacer()
            Text(value).font(mono ? .caption.monospaced() : .callout.monospacedDigit())
                .foregroundStyle(Palette.cream).multilineTextAlignment(.trailing).textSelection(.enabled)
        }
    }

    private func empty(_ text: String) -> some View {
        Text(text).font(.callout).foregroundStyle(Palette.muted).listRowBackground(Palette.shell)
    }

    private func icon(_ status: String) -> String {
        switch status {
        case "completed": "checkmark.circle.fill"
        case "in_progress": "circle.lefthalf.filled"
        case "abandoned": "xmark.circle"
        default: "circle"
        }
    }
}

/// Searchable model/effort/mode picker (ChatGPT's model picker; gjc `/model`, `/effort`, `/plan`).
struct ConfigPickerSheet: View {
    let chat: ChatModel
    let target: ConfigTarget
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                if let option = chat.configOption(target) {
                    ForEach(groups(option), id: \.name) { group in
                        Section(group.name) {
                            ForEach(group.choices, id: \.self) { choice in
                                Button {
                                    Task {
                                        await chat.setConfig(option, value: choice.value)
                                        dismiss()
                                    }
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(choice.name).foregroundStyle(Palette.cream)
                                            if choice.name != choice.value {
                                                Text(choice.value).font(.caption2.monospaced()).foregroundStyle(Palette.muted)
                                            }
                                        }
                                        Spacer()
                                        if option.currentValue?.string == choice.value {
                                            Image(systemName: "checkmark").foregroundStyle(Palette.visorGreen)
                                        }
                                    }
                                }
                            }
                        }
                        .listRowBackground(Palette.shell)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.ink)
            .searchable(text: $query, prompt: "검색")
            .navigationTitle(target.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("닫기") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private struct ChoiceGroup {
        let name: String
        let choices: [ConfigOption.Choice]
    }

    private func groups(_ option: ConfigOption) -> [ChoiceGroup] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let visible = option.choices.filter { q.isEmpty || $0.name.lowercased().contains(q) || $0.value.lowercased().contains(q) }
        var order: [String] = []
        var map: [String: [ConfigOption.Choice]] = [:]
        for choice in visible {
            let key = choice.group ?? ""
            if map[key] == nil { order.append(key) }
            map[key, default: []].append(choice)
        }
        return order.map { ChoiceGroup(name: $0, choices: map[$0] ?? []) }
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    let text: String

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [text], applicationActivities: nil)
    }

    func updateUIViewController(_: UIActivityViewController, context: Context) {}
}

/// Shows how long a cold resume has been waiting; gjc's session host can take ~40s on a busy host.
struct ResumeProgress: View {
    let startedAt: Date

    var body: some View {
        TimelineView(.periodic(from: startedAt, by: 1)) { timeline in
            let seconds = Int(timeline.date.timeIntervalSince(startedAt))
            VStack(spacing: 8) {
                ProgressView().tint(Palette.gajaeRed)
                Text("세션을 여는 중… \(seconds)초").font(.callout.monospacedDigit()).foregroundStyle(Palette.cream)
                if seconds >= 8 {
                    Text("호스트가 gjc 세션 프로세스를 다시 띄우고 있습니다. 바쁜 호스트에서는 최대 1분 걸립니다.")
                        .font(.caption).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                }
            }
            .frame(maxWidth: .infinity).padding(24)
        }
    }
}
