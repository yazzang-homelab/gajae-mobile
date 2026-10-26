import GjcMobileCore
import UserNotifications

/// Posts local notifications for an ask and for working ↔ idle changes. Only works while the app process is alive
/// and connected to the bridge; once iOS suspends the app no events arrive (that needs remote push).
final class ActivityNotifier: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = ActivityNotifier()

    private var center: UNUserNotificationCenter { .current() }

    /// Installs the delegate (so banners also show while the app is open) and asks for permission once.
    func activate() {
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func post(_ alert: ActivityAlerts.Alert, session: String, host: String) {
        let content = UNMutableNotificationContent()
        content.subtitle = host
        switch alert {
        case let .ask(_, _, title):
            content.title = "질문 대기 · \(session)"
            content.body = title
            content.sound = .default
        case .started:
            content.title = "작업 시작 · \(session)"
        case .finished:
            content.title = "작업 끝 · \(session)"
            content.body = "응답을 기다리고 있습니다."
            content.sound = .default
        }
        content.threadIdentifier = alert.sessionId
        let id: String = switch alert {
        case let .ask(_, requestId, _): "ask-\(requestId)"
        // One working/idle banner per session: a newer state replaces the older one.
        case .started, .finished: "status-\(alert.sessionId)"
        }
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    /// Drops the banner of an ask that was answered (here or on another phone).
    func withdrawAsk(_ requestId: String) {
        center.removeDeliveredNotifications(withIdentifiers: ["ask-\(requestId)"])
        center.removePendingNotificationRequests(withIdentifiers: ["ask-\(requestId)"])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}
