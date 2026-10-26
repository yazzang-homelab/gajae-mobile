import GjcMobileCore
import SwiftUI

/// App root: the selected host's home, with hosts and sessions in one leading drawer that slides in from the
/// left (sidebar button, or a swipe from the left edge) instead of a sheet rising from the bottom.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("selectedHostId") private var selectedHostId = ""
    @State private var sidebarOpen = false
    /// Live finger travel while dragging the drawer (positive = towards open).
    @State private var dragTranslation: CGFloat = 0
    @State private var showPairing = false
    @State private var demoError: String?

    private var selectedHost: PairedHost? {
        model.hosts.first { $0.hostId == selectedHostId } ?? model.hosts.first
    }

    private var selectedConnection: HostConnection? { selectedHost.map { model.connection(for: $0) } }

    var body: some View {
        GeometryReader { geometry in
            let width = min(geometry.size.width * 0.86, 360)
            let offset = drawerOffset(width: width)
            let progress = (offset + width) / width
            ZStack(alignment: .leading) {
                NavigationStack {
                    main
                        .overlay(alignment: .leading) { edgeSwipeArea(width: width) }
                }
                Color.black.opacity(0.5 * progress)
                    .ignoresSafeArea()
                    .allowsHitTesting(sidebarOpen)
                    .onTapGesture { setSidebar(false) }
                    .gesture(closeDrag(width: width))
                    .accessibilityHidden(true)
                NavigationStack {
                    SidebarView(
                        connection: selectedConnection,
                        onSelectHost: select,
                        // The list only ever shows the selected host's sessions.
                        onSelect: { chat in
                            if let connection = selectedConnection { connection.activeChat = chat }
                            setSidebar(false)
                        },
                        onNewChat: { cwd in
                            if let connection = selectedConnection {
                                connection.draftCwd = cwd
                                connection.activeChat = nil
                            }
                            setSidebar(false)
                        },
                        onAddHost: { showPairing = true },
                        onClose: { setSidebar(false) }
                    )
                }
                .frame(width: width)
                .background(Palette.ink)
                .overlay(alignment: .trailing) { Rectangle().fill(Palette.shellLine).frame(width: 1).ignoresSafeArea() }
                .offset(x: offset)
                .accessibilityHidden(!sidebarOpen)
            }
        }
        .sheet(isPresented: $showPairing) {
            PairingView { host in
                showPairing = false
                selectedHostId = host.hostId
                setSidebar(false)
            }
        }
        .onChange(of: model.pairingURL) { _, url in if url != nil { showPairing = true } }
        .onChange(of: model.requestedHostId) { _, id in
            guard let id else { return }
            selectedHostId = id
            model.requestedHostId = nil
            showPairing = false
            setSidebar(false)
        }
        .onAppear { model.appBecameActive() }
    }

    @ViewBuilder private var main: some View {
        if let host = selectedHost {
            HostHomeView(connection: model.connection(for: host), onOpenSidebar: { setSidebar(true) })
                .id(host.hostId)
        } else {
            emptyState
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { setSidebar(true) } label: { Image(systemName: "sidebar.left") }
                            .accessibilityLabel("사이드바")
                    }
                }
        }
    }

    private func select(_ host: PairedHost) {
        guard host.hostId != selectedHost?.hostId else { return }
        selectedHostId = host.hostId
        model.connection(for: host).ensureConnected()
    }

    private func setSidebar(_ open: Bool) {
        withAnimation(.snappy(duration: 0.28)) {
            sidebarOpen = open
            dragTranslation = 0
        }
    }

    private func drawerOffset(width: CGFloat) -> CGFloat {
        let base = sidebarOpen ? 0 : -width
        return min(0, max(-width, base + dragTranslation))
    }

    /// Opening swipe from the left edge of the content (below the navigation bar, so its buttons stay tappable).
    private func edgeSwipeArea(width: CGFloat) -> some View {
        Color.clear
            .frame(width: sidebarOpen ? 0 : 18)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 12)
                    .onChanged { value in dragTranslation = max(0, value.translation.width) }
                    .onEnded { value in
                        setSidebar(value.translation.width > width * 0.35 || value.predictedEndTranslation.width > width * 0.6)
                    }
            )
    }

    /// Closing drag on the dimmed content beside the open drawer (rows inside the drawer keep their swipe actions).
    private func closeDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in dragTranslation = min(0, value.translation.width) }
            .onEnded { value in
                setSidebar(!(value.translation.width < -width * 0.3 || value.predictedEndTranslation.width < -width * 0.5))
            }
    }

    private var emptyState: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()
            VStack(spacing: 18) {
                Image("Mascot").resizable().scaledToFit().frame(maxWidth: 220)
                Text("연결된 호스트가 없습니다").font(.headline).foregroundStyle(Palette.cream)
                Text("호스트에서 `gjcm-bridge pair`를 실행하고\n표시된 QR 코드를 스캔하세요.")
                    .font(.subheadline).multilineTextAlignment(.center).foregroundStyle(Palette.muted)
                Button { showPairing = true } label: {
                    Label("QR 스캔", systemImage: "qrcode.viewfinder").frame(maxWidth: 220).padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                if DemoHost.offerURL != nil {
                    Button {
                        Task {
                            // The pairing sheet opens on pairingURL and pairs with it right away.
                            if let link = try? await DemoHost.pairingLink() { model.pairingURL = link } else { demoError = DemoHost.failure }
                        }
                    } label: {
                        Label("컴퓨터 없이 데모로 체험", systemImage: "play.circle").frame(maxWidth: 220).padding(.vertical, 6)
                    }
                    .buttonStyle(.bordered).tint(Palette.strawGold)
                    if let demoError { Text(demoError).font(.footnote).foregroundStyle(Palette.gajaeRed) }
                }
            }
            .padding()
        }
        .navigationTitle("가재코드")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct HostRow: View {
    let connection: HostConnection

    var body: some View {
        HStack(spacing: 12) {
            StatusDot(status: connection.status)
            VStack(alignment: .leading, spacing: 3) {
                Text(connection.host.name).font(.headline).foregroundStyle(Palette.cream)
                Text(subtitle).font(.caption.monospaced()).foregroundStyle(Palette.muted).lineLimit(1)
            }
        }
        .padding(.vertical, 4)
    }

    private var subtitle: String {
        switch connection.status {
        case .connected:
            if let agent = connection.info?.agentInfo {
                return "\(agent.title ?? agent.name) \(agent.version ?? "")"
            }
            return connection.host.lastEndpoint ?? "연결됨"
        case .connecting: return "연결 중…"
        case .idle: return "대기"
        case let .failed(reason): return reason
        }
    }
}

struct StatusDot: View {
    let status: HostConnection.Status

    var body: some View {
        Circle().fill(color).frame(width: 10, height: 10)
            .accessibilityLabel(label)
    }

    private var color: Color {
        switch status {
        case .connected: Palette.visorGreen
        case .connecting: Palette.strawGold
        case .idle: Palette.muted
        case .failed: Palette.gajaeRed
        }
    }

    private var label: String {
        switch status {
        case .connected: "연결됨"
        case .connecting: "연결 중"
        case .idle: "대기"
        case .failed: "연결 실패"
        }
    }
}
