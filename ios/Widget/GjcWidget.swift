import GjcMobileCore
import SwiftUI
import WidgetKit

/// Home-screen and lock-screen widget: "does the agent need me?" first, then the sessions worth opening. Tapping a
/// row opens that chat (`gjcm://session`), anywhere else opens the app. No approve/deny buttons on purpose: an
/// approval belongs next to the command it allows, and the data here may be minutes old. The lock-screen families
/// show counts only, never session names.
@main
struct GjcWidgetBundle: WidgetBundle {
    var body: some Widget { GjcStatusWidget() }
}

struct GjcStatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "GjcStatus", provider: SnapshotProvider()) { entry in
            StatusView(entry: entry)
                .containerBackground(Palette.ink, for: .widget)
        }
        .configurationDisplayName("가재코드 상태")
        .description("질문·승인 대기와 작업 중인 세션. 오래된 정보는 '확인 필요'로 표시합니다.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct SnapshotEntry: TimelineEntry {
    let date: Date
    let hosts: [WidgetHost]
}

/// Reads the snapshot the app keeps in the App Group container. The app reloads timelines when it records
/// something new; between those, entries every 5 minutes keep "N분 전" current and one lands exactly when a
/// host turns stale.
struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry { SnapshotEntry(date: Date(), hosts: []) }

    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        completion(SnapshotEntry(date: Date(), hosts: load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        let hosts = load()
        let now = Date()
        var dates = (0..<12).map { now.addingTimeInterval(Double($0) * 300) }
        if let stale = WidgetState.nextStaleAt(hosts, now: now) { dates.append(stale) }
        let entries = dates.sorted().map { SnapshotEntry(date: $0, hosts: hosts) }
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(3600))))
    }

    private func load() -> [WidgetHost] {
        let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: WidgetHost.appGroup)?
            .appendingPathComponent(WidgetHost.fileName)
        return WidgetHost.decode(url.flatMap { try? Data(contentsOf: $0) })
    }
}

struct StatusView: View {
    let entry: SnapshotEntry
    @Environment(\.widgetFamily) private var family

    private var maxRows: Int {
        switch family {
        case .systemSmall: 1
        case .systemMedium: 3
        case .systemLarge: 8
        default: 0
        }
    }

    private var state: WidgetState { WidgetState.present(entry.hosts, now: entry.date, maxRows: maxRows) }

    var body: some View {
        let state = state
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text(circleValue(state)).font(.title3.bold())
                    Text(circleCaption(state)).font(.caption2)
                }
            }
            .widgetAccentable()
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                Text("가재코드").font(.caption2).foregroundStyle(.secondary)
                Text(state.headline).font(.headline).widgetAccentable()
                Text(state.summary(now: entry.date)).font(.caption2).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .accessoryInline:
            Text("가재코드 · \(state.summary(now: entry.date))")
        default:
            home(state)
        }
    }

    private func home(_ state: WidgetState) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("가재코드").font(.caption2).foregroundStyle(Palette.muted)
            Text(state.headline)
                .font(.title3.bold())
                .foregroundStyle(headlineColor(state))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(state.summary(now: entry.date)).font(.caption).foregroundStyle(Palette.muted).lineLimit(1)
            if !state.rows.isEmpty {
                Divider().overlay(Palette.shellLine).padding(.vertical, 2)
                ForEach(state.rows) { row in
                    // The small widget takes no Links; its one tap target is the widgetURL below.
                    if family == .systemSmall {
                        rowView(row, multiHost: entry.hosts.count > 1)
                    } else {
                        Link(destination: link(row)) { rowView(row, multiHost: entry.hosts.count > 1) }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // The small widget is one tap target: the most urgent session, or just the app.
        .widgetURL(family == .systemSmall ? state.rows.first.flatMap { $0.kind == .waiting ? link($0) : nil } : nil)
    }

    private func rowView(_ row: WidgetState.Row, multiHost: Bool) -> some View {
        HStack(spacing: 8) {
            Text(multiHost ? "\(row.label) · \(row.hostName)" : row.label)
                .font(.footnote)
                .foregroundStyle(Palette.cream)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(row.status(now: entry.date)).font(.caption).foregroundStyle(color(row.kind)).lineLimit(1)
        }
    }

    private func circleValue(_ state: WidgetState) -> String {
        if !state.paired { return "–" }
        if state.waiting > 0 { return "\(state.waiting)" }
        if state.needsCheck { return "?" }
        return "\(state.running)"
    }

    private func circleCaption(_ state: WidgetState) -> String {
        if !state.paired { return "gjc" }
        if state.waiting > 0 { return "대기" }
        if state.needsCheck { return "확인" }
        return "작업"
    }

    private func headlineColor(_ state: WidgetState) -> Color {
        if state.waiting > 0 { return Palette.gajaeRed }
        if state.needsCheck { return Palette.strawGold }
        if state.running > 0 { return Palette.visorGreen }
        return Palette.cream
    }

    private func color(_ kind: WidgetState.Kind) -> Color {
        switch kind {
        case .waiting: Palette.gajaeRed
        case .unconfirmed: Palette.strawGold
        case .running: Palette.visorGreen
        case .ended: Palette.muted
        }
    }

    private func link(_ row: WidgetState.Row) -> URL {
        var components = URLComponents()
        components.scheme = "gjcm"
        components.host = "session"
        components.queryItems = [
            URLQueryItem(name: "host", value: row.hostId),
            URLQueryItem(name: "id", value: row.sessionId),
            URLQueryItem(name: "cwd", value: row.cwd),
        ]
        return components.url!
    }
}
