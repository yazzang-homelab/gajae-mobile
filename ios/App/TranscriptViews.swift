import GjcMobileCore
import SwiftUI

struct TranscriptRow: View {
    let item: TranscriptItem

    var body: some View {
        switch item.kind {
        case let .user(text, attachments):
            HStack {
                Spacer(minLength: 40)
                VStack(alignment: .trailing, spacing: 6) {
                    ForEach(attachments, id: \.self) { AttachmentView(attachment: $0) }
                    if !text.isEmpty {
                        SelectableText(text: RichText.plain(text, font: RichText.font(.body), color: Palette.ink))
                            .padding(10)
                            .background(Palette.cream, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                }
            }
        case let .agent(text):
            MarkdownText(text: text)
        case let .thought(text):
            ThoughtView(text: text)
        case let .tool(call):
            ToolCallView(call: call)
        case let .plan(entries):
            PlanView(entries: entries)
        case let .turnEnded(stopReason, error):
            TurnEndView(stopReason: stopReason, error: error)
        case let .notice(text):
            Label(text, systemImage: "info.circle").font(.caption).foregroundStyle(Palette.muted)
        }
    }
}

/// Inline markdown per paragraph; fenced code blocks render monospaced in a card. Every part is
/// drag-selectable and links open in the default browser (`SelectableText`).
struct MarkdownText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                if segment.code {
                    ScrollView(.horizontal, showsIndicators: false) {
                        SelectableText(
                            text: RichText.plain(segment.text, font: RichText.font(.caption1, monospaced: true), color: Palette.cream),
                            wraps: false
                        )
                        .padding(10)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .card()
                } else {
                    SelectableText(text: RichText.markdown(segment.text, color: Palette.cream))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private var segments: [(code: Bool, text: String)] {
        var result: [(Bool, String)] = []
        var inCode = false
        var buffer: [Substring] = []
        func flush() {
            let joined = buffer.joined(separator: "\n")
            if !joined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { result.append((inCode, joined)) }
            buffer = []
        }
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                flush()
                inCode.toggle()
            } else {
                buffer.append(line)
            }
        }
        flush()
        return result
    }
}

struct ThoughtView: View {
    static let showKey = "showThinking"
    let text: String
    /// Global, like the TUI's Ctrl+T: on shows every reasoning block in full, off folds them to one line.
    @AppStorage(ThoughtView.showKey) private var show = false
    @State private var expanded = false

    var body: some View {
        if show {
            VStack(alignment: .leading, spacing: 4) {
                Label("추론", systemImage: "brain").font(.caption).foregroundStyle(Palette.muted)
                thought
            }
        } else {
            DisclosureGroup(isExpanded: $expanded) {
                thought
            } label: {
                Label("추론", systemImage: "brain").font(.caption).foregroundStyle(Palette.muted)
            }
        }
    }

    private var thought: some View {
        SelectableText(text: RichText.markdown(text, style: .caption1, color: Palette.muted))
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ToolCallView: View {
    let call: ToolCall
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 8) {
                    statusIcon
                    Text(call.title).font(.caption.monospaced()).foregroundStyle(Palette.cream).lineLimit(expanded ? nil : 1)
                    Spacer()
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(Palette.muted)
                }
            }
            .buttonStyle(.plain)
            if expanded {
                if let input = call.rawInput {
                    Text(input.prettyText).font(.caption2.monospaced()).foregroundStyle(Palette.muted).textSelection(.enabled)
                }
                if !call.output.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(call.output.suffix(8000)).font(.caption2.monospaced()).foregroundStyle(Palette.cream)
                    }
                    .frame(maxHeight: 260)
                }
            }
        }
        .padding(10)
        .card(stroke: call.status == "failed" ? Palette.gajaeRed : Palette.shellLine)
    }

    @ViewBuilder private var statusIcon: some View {
        switch call.status {
        case "completed": Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.visorGreen)
        case "failed": Image(systemName: "xmark.octagon.fill").foregroundStyle(Palette.gajaeRed)
        default: ProgressView().controlSize(.mini).tint(Palette.strawGold)
        }
    }
}

struct PlanView: View {
    let entries: [PlanEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("계획", systemImage: "list.bullet.clipboard").font(.caption.bold()).foregroundStyle(Palette.strawGold)
            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: icon(entry.status)).font(.caption)
                        .foregroundStyle(entry.status == "completed" ? Palette.visorGreen : Palette.muted)
                    Text(entry.content).font(.caption).foregroundStyle(Palette.cream)
                        .strikethrough(entry.status == "completed", color: Palette.muted)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private func icon(_ status: String) -> String {
        switch status {
        case "completed": "checkmark.square"
        case "in_progress": "arrow.right.square"
        default: "square"
        }
    }
}

struct TurnEndView: View {
    let stopReason: String
    let error: String?

    var body: some View {
        if let error {
            Label(error, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(Palette.gajaeRed)
        } else if stopReason == "cancelled" {
            Label("중단됨", systemImage: "stop.circle").font(.caption).foregroundStyle(Palette.muted)
        } else if stopReason != "end_turn" {
            Label("종료: \(stopReason)", systemImage: "flag").font(.caption).foregroundStyle(Palette.strawGold)
        }
    }
}

struct AttachmentView: View {
    let attachment: Attachment

    var body: some View {
        switch attachment.kind {
        case let .image(_, base64):
            if let data = Data(base64Encoded: base64), let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: 220, maxHeight: 220)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        case let .file(_, _, size):
            Label {
                Text(attachment.name + (size.map { " · " + ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) } ?? ""))
            } icon: { Image(systemName: "doc") }
                .font(.caption).padding(8).card()
        case .embeddedText:
            Label(attachment.name, systemImage: "doc.text").font(.caption).padding(8).card()
        }
    }
}

struct PermissionCard: View {
    let request: PermissionRequest
    let onChoose: (PermissionOption?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("승인 필요", systemImage: "hand.raised.fill").font(.caption.bold()).foregroundStyle(Palette.strawGold)
            Text(request.title).font(.callout.monospaced()).foregroundStyle(Palette.cream)
            if let detail = request.detail {
                ScrollView {
                    Text(detail).font(.caption2.monospaced()).foregroundStyle(Palette.muted)
                        .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                }
                .frame(maxHeight: 120)
            }
            // One full-width row per choice: ask labels are often long sentences that a single row truncates.
            VStack(spacing: 6) {
                ForEach(request.options, id: \.optionId) { option in
                    if option.isAllow {
                        Button { onChoose(option) } label: { optionLabel(option) }.buttonStyle(.borderedProminent)
                            .tint(option.kind == "allow_always" ? Palette.strawGold : Palette.visorGreen)
                    } else {
                        Button(role: .destructive) { onChoose(option) } label: { optionLabel(option) }.buttonStyle(.bordered)
                    }
                }
            }
            .font(.callout)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(stroke: Palette.strawGold)
    }

    private func optionLabel(_ option: PermissionOption) -> some View {
        Text(option.name).multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 2)
    }
}
