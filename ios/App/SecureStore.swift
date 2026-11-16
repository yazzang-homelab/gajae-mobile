import Foundation
import GjcMobileCore
import Security

/// Device identity and paired hosts live in the Keychain (this device only, never synced or backed up),
/// as Orca's mobile app does with WHEN_UNLOCKED_THIS_DEVICE_ONLY. AfterFirstUnlock lets the app
/// reconnect when it returns from background before the user unlocks again.
enum Keychain {
    private static let service = "dev.gajae.gjcmobile"

    static func read(_ account: String) -> StorageRead {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return .notFound }
        guard status == errSecSuccess, let data = result as? Data else { return .unavailable }
        return .data(data)
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

private struct KeychainAccount: HostsBlobStorage {
    let account: String
    func read() -> StorageRead { Keychain.read(account) }
    func write(_ data: Data) -> Bool { Keychain.write(data, account: account) }
}

struct SecureStore {
    private let deviceVault = DeviceIdentityVault(storage: KeychainAccount(account: "device-key"))
    private let vault = PairedHostsVault(storage: KeychainAccount(account: "paired-hosts"))

    func deviceIdentity() -> DeviceIdentity { deviceVault.identity() }

    /// True while this run uses a throwaway key because the stored one could not be read.
    var deviceIsTemporary: Bool { deviceVault.isTemporary }

    /// The stored key once it can be read, or nil while it still cannot.
    func recoverDeviceIdentity() -> DeviceIdentity? { deviceVault.recover() }

    /// False while the hosts could not be read; the empty list from `hosts()` then means "unknown".
    var hostsAvailable: Bool { vault.isAvailable }

    func hosts() -> [PairedHost] { vault.load() }

    /// The list now stored (it can hold hosts the caller could not load), or nil when nothing was written.
    @discardableResult
    func save(hosts: [PairedHost], forgetting hostId: String? = nil) -> [PairedHost]? {
        vault.save(hosts: hosts, forgetting: hostId)
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
