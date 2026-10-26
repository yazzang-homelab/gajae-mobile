import Foundation
import GjcMobileCore
import Security

/// Device identity and paired hosts live in the Keychain (this device only, never synced or backed up),
/// as Orca's mobile app does with WHEN_UNLOCKED_THIS_DEVICE_ONLY. AfterFirstUnlock lets the app
/// reconnect when it returns from background before the user unlocks again.
enum Keychain {
    private static let service = "dev.gajae.gjcmobile"

    static func read(_ account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    @discardableResult
    static func write(_ data: Data, account: String) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if SecItemUpdate(base as CFDictionary, attributes as CFDictionary) == errSecSuccess { return true }
        return SecItemAdd(base.merging(attributes) { $1 } as CFDictionary, nil) == errSecSuccess
    }
}

struct SecureStore {
    private let deviceAccount = "device-key"
    private let hostsAccount = "paired-hosts"

    func deviceIdentity() -> DeviceIdentity {
        if let raw = Keychain.read(deviceAccount), let identity = try? DeviceIdentity(rawPrivateKey: raw) {
            return identity
        }
        let identity = DeviceIdentity()
        Keychain.write(identity.rawPrivateKey, account: deviceAccount)
        return identity
    }

    func hosts() -> [PairedHost] {
        guard let data = Keychain.read(hostsAccount) else { return [] }
        return (try? JSONDecoder().decode([PairedHost].self, from: data)) ?? []
    }

    func save(hosts: [PairedHost]) {
        if let data = try? JSONEncoder().encode(hosts) { Keychain.write(data, account: hostsAccount) }
    }
}

/// Non-secret cache so the session list renders instantly before the host answers.
/// The canonical sessions stay on the host in ~/.gjc/agent/sessions.
struct SessionCache {
    private var directory: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("session-cache", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func load(hostId: String) -> [SessionSummary] {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("\(hostId).json")) else { return [] }
        return (try? JSONDecoder().decode([SessionSummary].self, from: data)) ?? []
    }

    func save(_ sessions: [SessionSummary], hostId: String) {
        guard let data = try? JSONEncoder().encode(sessions) else { return }
        try? data.write(to: directory.appendingPathComponent("\(hostId).json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func remove(hostId: String) {
        try? FileManager.default.removeItem(at: directory.appendingPathComponent("\(hostId).json"))
    }
}
