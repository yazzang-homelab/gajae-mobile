import BackgroundTasks
import Foundation
import GjcMobileCore
import UIKit

/// Background check for the widget while the app is not on screen (`BGAppRefreshTask`, run when iOS chooses): a
/// short connection per paired host reads the session list and the waiting asks, then closes. The device key never
/// leaves the app; the widget extension only reads `WidgetStore`. A host that cannot be reached keeps its last
/// observation, which the widget turns into "확인 필요" once it is old.
enum WidgetRefresher {
    /// Also listed in Info.plist `BGTaskSchedulerPermittedIdentifiers` (project.yml).
    static let taskIdentifier = "dev.gajae.gjcmobile.widget-refresh"

    /// Asks iOS for the next run no earlier than 15 minutes from now; iOS decides the actual time.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    static func refresh() async {
        let store = SecureStore()
        let hosts = store.hosts()
        WidgetStore.sync(hosts)
        guard !hosts.isEmpty else { return }
        let device = store.deviceIdentity()
        let deviceName = await UIDevice.current.name
        await withTaskGroup(of: Void.self) { group in
            for host in hosts {
                group.addTask {
                    guard let client = try? await BridgeClient.connectAny(host: host, device: device, deviceName: deviceName).0 else { return }
                    if let sessions = try? await client.listSessions().sessions,
                       let waiting = try? await client.pendingPermissions() {
                        WidgetStore.observe(host: host, sessions: sessions, waiting: waiting)
                    }
                    await client.close()
                }
            }
        }
        WidgetStore.redraw()
    }
}
