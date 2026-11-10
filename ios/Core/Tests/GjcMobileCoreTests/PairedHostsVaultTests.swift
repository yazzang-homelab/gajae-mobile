import XCTest
@testable import GjcMobileCore

private final class FakeStorage: HostsBlobStorage {
    var stored: Data?
    var failing = false
    var writes = 0

    func read() -> StorageRead {
        if failing { return .unavailable }
        guard let stored else { return .notFound }
        return .data(stored)
    }

    func write(_ data: Data) -> Bool {
        guard !failing else { return false }
        stored = data
        writes += 1
        return true
    }
}

final class PairedHostsVaultTests: XCTestCase {
    private func host(_ id: String) -> PairedHost {
        PairedHost(hostId: id, name: id, hostKey: "key-\(id)", endpoints: ["ws://\(id):1"])
    }

    private func storedIds(_ storage: FakeStorage) throws -> [String] {
        try JSONDecoder().decode([PairedHost].self, from: XCTUnwrap(storage.stored)).map(\.hostId)
    }

    func testMissingItemIsAnAvailableEmptyList() {
        let vault = PairedHostsVault(storage: FakeStorage())
        XCTAssertEqual(vault.load(), [])
        XCTAssertTrue(vault.isAvailable)
    }

    func testReadFailureIsNotAnEmptyList() {
        let storage = FakeStorage()
        storage.failing = true
        let vault = PairedHostsVault(storage: storage)
        XCTAssertEqual(vault.load(), [])
        XCTAssertFalse(vault.isAvailable)
    }

    func testAnUnreadableStorageIsNeverOverwrittenWhileItStaysUnreadable() throws {
        let storage = FakeStorage()
        let seed = PairedHostsVault(storage: storage)
        seed.save(hosts: [host("a"), host("b")])
        let before = storage.stored

        storage.failing = true
        let vault = PairedHostsVault(storage: storage)
        _ = vault.load()
        XCTAssertNil(vault.save(hosts: [host("c")]))
        storage.failing = false
        XCTAssertEqual(storage.stored, before)
        XCTAssertEqual(storage.writes, 1)
    }

    func testPairingAfterAFailedReadKeepsTheStoredHostsOnceReadable() throws {
        let storage = FakeStorage()
        PairedHostsVault(storage: storage).save(hosts: [host("a"), host("b")])

        storage.failing = true
        let vault = PairedHostsVault(storage: storage)
        _ = vault.load()
        storage.failing = false

        let saved = try XCTUnwrap(vault.save(hosts: [host("c")]))
        XCTAssertEqual(Set(saved.map(\.hostId)), ["a", "b", "c"])
        XCTAssertEqual(Set(try storedIds(storage)), ["a", "b", "c"])
        XCTAssertTrue(vault.isAvailable)
    }

    func testTheInMemoryHostWinsOverTheStoredCopyOfTheSameHost() throws {
        let storage = FakeStorage()
        PairedHostsVault(storage: storage).save(hosts: [host("a")])

        storage.failing = true
        let vault = PairedHostsVault(storage: storage)
        _ = vault.load()
        storage.failing = false

        var renamed = host("a")
        renamed.name = "renamed"
        let saved = try XCTUnwrap(vault.save(hosts: [renamed]))
        XCTAssertEqual(saved.map(\.name), ["renamed"])
    }

    func testAHostForgottenWhileUnreadableStaysForgotten() throws {
        let storage = FakeStorage()
        PairedHostsVault(storage: storage).save(hosts: [host("a"), host("b")])

        storage.failing = true
        let vault = PairedHostsVault(storage: storage)
        _ = vault.load()
        XCTAssertNil(vault.save(hosts: [], forgetting: "a"))
        storage.failing = false

        let saved = try XCTUnwrap(vault.save(hosts: [host("c")]))
        XCTAssertEqual(Set(saved.map(\.hostId)), ["b", "c"])
    }

    func testAnAvailableStorageIsSavedAsGivenSoForgettingRemovesTheHost() throws {
        let storage = FakeStorage()
        let vault = PairedHostsVault(storage: storage)
        vault.save(hosts: [host("a"), host("b")])
        vault.save(hosts: [host("b")], forgetting: "a")
        XCTAssertEqual(try storedIds(storage), ["b"])
    }

    func testALaterSuccessfulReadMakesTheVaultAvailableAgain() throws {
        let storage = FakeStorage()
        PairedHostsVault(storage: storage).save(hosts: [host("a")])
        storage.failing = true
        let vault = PairedHostsVault(storage: storage)
        _ = vault.load()
        storage.failing = false
        XCTAssertEqual(vault.load().map(\.hostId), ["a"])
        XCTAssertTrue(vault.isAvailable)
    }
}
