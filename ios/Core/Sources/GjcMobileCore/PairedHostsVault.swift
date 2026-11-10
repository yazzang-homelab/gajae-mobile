import Foundation

/// What one read of the secure storage found. A read that fails for any reason other than "no such item"
/// (device still locked after a reboot, a transient Keychain error) is `unavailable`, never `notFound`.
public enum StorageRead: Equatable, Sendable {
    case data(Data)
    case notFound
    case unavailable
}

public protocol HostsBlobStorage {
    func read() -> StorageRead
    @discardableResult func write(_ data: Data) -> Bool
}

/// The paired-hosts list on top of the secure storage. An unreadable storage is not an empty list: while the
/// last read was `unavailable`, saving first reads again and merges, so hosts that were stored but could not be
/// loaded are not overwritten by the in-memory list.
public final class PairedHostsVault {
    private let storage: HostsBlobStorage
    private var unreadable = false
    private var forgottenWhileUnreadable: Set<String> = []

    public init(storage: HostsBlobStorage) {
        self.storage = storage
    }

    /// False after a read failed and until a later read or save succeeds; the widget must not be synced from
    /// the (empty) in-memory list meanwhile.
    public var isAvailable: Bool { !unreadable }

    /// Stored hosts; empty when nothing is stored or the storage cannot be read right now (see `isAvailable`).
    public func load() -> [PairedHost] {
        switch storage.read() {
        case .unavailable:
            unreadable = true
            return []
        case .notFound:
            unreadable = false
            return []
        case .data(let data):
            unreadable = false
            return (try? JSONDecoder().decode([PairedHost].self, from: data)) ?? []
        }
    }

    /// Stores `hosts`. While the storage was unreadable, re-reads first: still unreadable writes nothing and
    /// returns nil; otherwise the stored hosts that `hosts` lacks (and that were not forgotten meanwhile) are kept.
    /// The unreadable state and the forgotten set are cleared only once the merged list is written.
    /// Returns the list that is now stored, or nil when nothing was written.
    @discardableResult
    public func save(hosts: [PairedHost], forgetting hostId: String? = nil) -> [PairedHost]? {
        var merged = hosts
        if unreadable {
            if let hostId { forgottenWhileUnreadable.insert(hostId) }
            guard let stored = readStored() else { return nil }
            let known = Set(hosts.map(\.hostId))
            merged = stored.filter { !known.contains($0.hostId) && !forgottenWhileUnreadable.contains($0.hostId) } + hosts
        }
        guard let data = try? JSONEncoder().encode(merged), storage.write(data) else { return nil }
        unreadable = false
        forgottenWhileUnreadable = []
        return merged
    }

    /// The stored hosts, or nil when the storage cannot be read; leaves the unreadable state alone.
    private func readStored() -> [PairedHost]? {
        switch storage.read() {
        case .unavailable: return nil
        case .notFound: return []
        case .data(let data): return (try? JSONDecoder().decode([PairedHost].self, from: data)) ?? []
        }
    }
}

/// The device key on top of the secure storage. A key that cannot be read (not "no such item") is neither
/// replaced nor stored over: this run gets a throwaway key, `isTemporary` says so, and `recover()` reads again.
/// Hosts must not be connected with a throwaway key; the bridge would reject it as an unknown device.
public final class DeviceIdentityVault {
    private let storage: HostsBlobStorage
    public private(set) var isTemporary = false

    public init(storage: HostsBlobStorage) {
        self.storage = storage
    }

    public func identity() -> DeviceIdentity {
        switch storage.read() {
        case .data(let raw):
            if let identity = try? DeviceIdentity(rawPrivateKey: raw) {
                isTemporary = false
                return identity
            }
        case .unavailable:
            isTemporary = true
            return DeviceIdentity()
        case .notFound:
            break
        }
        let identity = DeviceIdentity()
        isTemporary = !storage.write(identity.rawPrivateKey)
        return identity
    }

    /// The stored key once it can be read, or nil while this run still has a throwaway key.
    public func recover() -> DeviceIdentity? {
        guard isTemporary else { return nil }
        let identity = identity()
        return isTemporary ? nil : identity
    }
}
