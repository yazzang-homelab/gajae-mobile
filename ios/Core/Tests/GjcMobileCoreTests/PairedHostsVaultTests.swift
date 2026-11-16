import XCTest
@testable import GjcMobileCore

private final class FakeStorage: HostsBlobStorage {
    var stored: Data?
    var readFailing = false
    var writeFailing = false
    /// Both reads and writes fail, as with a locked Keychain.
    var failing: Bool {
        get { readFailing && writeFailing }
        set { readFailing = newValue; writeFailing = newValue }
    }
    var writes = 0

    func read() -> StorageRead {
        if readFailing { return .unavailable }
        guard let stored else { return .notFound }
        return .data(stored)
    }

    func write(_ data: Data) -> Bool {
        guard !writeFailing else { return false }
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

    func testReadFailingButWritableStorageIsNotOverwritten() throws {
        // The original defect: reads fail, writes would succeed. Only the re-read guard stops the overwrite.
        let storage = FakeStorage()
        PairedHostsVault(storage: storage).save(hosts: [host("a"), host("b")])
        let before = storage.stored
        let writesBefore = storage.writes

        storage.readFailing = true
        let vault = PairedHostsVault(storage: storage)
        _ = vault.load()
        XCTAssertNil(vault.save(hosts: [host("c")]))
        XCTAssertEqual(storage.stored, before)
        XCTAssertEqual(storage.writes, writesBefore)
        XCTAssertFalse(vault.isAvailable)
    }

    func testAFailedWriteAfterASuccessfulReReadKeepsTheStorageUnavailableAndTheForgetting() throws {
        let storage = FakeStorage()
        PairedHostsVault(storage: storage).save(hosts: [host("a"), host("b")])

        storage.readFailing = true
        let vault = PairedHostsVault(storage: storage)
        _ = vault.load()
        storage.readFailing = false
        storage.writeFailing = true

        XCTAssertNil(vault.save(hosts: [host("c")], forgetting: "a"))
        XCTAssertFalse(vault.isAvailable)

        storage.writeFailing = false
        let saved = try XCTUnwrap(vault.save(hosts: [host("c")]))
        XCTAssertEqual(Set(saved.map(\.hostId)), ["b", "c"])
        XCTAssertTrue(vault.isAvailable)
    }

    func testSavingTheInMemoryListRecoversHostsAndKeepsPairingsMadeWhileUnreadable() throws {
        // What the app does when it becomes active again: the same save, with the list it holds.
        let storage = FakeStorage()
        PairedHostsVault(storage: storage).save(hosts: [host("a"), host("b")])

        storage.readFailing = true
        let vault = PairedHostsVault(storage: storage)
        _ = vault.load()
        storage.readFailing = false

        let saved = try XCTUnwrap(vault.save(hosts: [host("c")]))
        XCTAssertEqual(Set(saved.map(\.hostId)), ["a", "b", "c"])
        XCTAssertEqual(Set(try storedIds(storage)), ["a", "b", "c"])
    }
}

final class DeviceIdentityVaultTests: XCTestCase {
    func testMissingKeyIsCreatedAndStored() throws {
        let storage = FakeStorage()
        let vault = DeviceIdentityVault(storage: storage)
        let identity = vault.identity()
        XCTAssertFalse(vault.isTemporary)
        XCTAssertEqual(storage.stored, identity.rawPrivateKey)
    }

    func testUnreadableKeyIsNotReplacedAndIsTemporary() throws {
        let storage = FakeStorage()
        let original = DeviceIdentity()
        storage.stored = original.rawPrivateKey
        storage.readFailing = true
        let vault = DeviceIdentityVault(storage: storage)
        _ = vault.identity()
        XCTAssertTrue(vault.isTemporary)
        XCTAssertEqual(storage.stored, original.rawPrivateKey)
        XCTAssertEqual(storage.writes, 0)
    }

    func testRecoverReturnsNilWhileStillUnreadableAndTheStoredKeyOnceReadable() throws {
        let storage = FakeStorage()
        let original = DeviceIdentity()
        storage.stored = original.rawPrivateKey
        storage.readFailing = true
        let vault = DeviceIdentityVault(storage: storage)
        _ = vault.identity()
        XCTAssertNil(vault.recover())
        XCTAssertTrue(vault.isTemporary)

        storage.readFailing = false
        let recovered = try XCTUnwrap(vault.recover())
        XCTAssertEqual(recovered.rawPrivateKey, original.rawPrivateKey)
        XCTAssertFalse(vault.isTemporary)
        XCTAssertNil(vault.recover())
    }

    func testAKeyThatCannotBeStoredStaysTemporary() throws {
        let storage = FakeStorage()
        storage.writeFailing = true
        let vault = DeviceIdentityVault(storage: storage)
        _ = vault.identity()
        XCTAssertTrue(vault.isTemporary)
    }
}
