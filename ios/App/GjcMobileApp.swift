import GjcMobileCore
import SwiftUI

@main
struct GjcMobileApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        ActivityNotifier.shared.activate()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .tint(Palette.gajaeRed)
                .onOpenURL(perform: handle)
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active: model.appBecameActive()
                    case .background: model.appWentToBackground()
                    default: break
                    }
                }
        }
        .backgroundTask(.appRefresh(WidgetRefresher.taskIdentifier)) {
            WidgetRefresher.schedule()
            await WidgetRefresher.refresh()
        }
    }

    /// `gjcm://session?…` comes from a widget row; anything else (a `gjcm://pair` QR scanned with the system
    /// camera) is a pairing link.
    private func handle(_ url: URL) {
        guard url.host == "session" else {
            model.pairingURL = url.absoluteString
            return
        }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
        guard let hostId = value("host"), let sessionId = value("id") else { return }
        model.openSession(hostId: hostId, sessionId: sessionId, cwd: value("cwd") ?? "")
    }
}
