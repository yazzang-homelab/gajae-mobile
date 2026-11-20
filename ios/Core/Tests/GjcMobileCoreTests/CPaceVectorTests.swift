import Crypto
import Foundation
import XCTest
@testable import GjcMobileCore

/// fixtures/cpace-vector.json is shared with the bridge (TypeScript) and Android: every entry is checked here.
final class CPaceVectorTests: XCTestCase {
    private func vector() throws -> JSONValue { try Fixtures.json("cpace-vector.json") }

    private func hex(_ value: JSONValue?, _ label: String = "") throws -> Data {
        Fixtures.hex(try XCTUnwrap(value?.string, label))
    }

    private func hexString(_ data: Data?) -> String? { data.map(Fixtures.hexString) }

    func testDraftGeneratorStringHashAndPoint() throws {
        let g = try XCTUnwrap(try vector()["draft"]?["generator"])
        let prs = try hex(g["prs"]), ci = try hex(g["ci"]), sid = try hex(g["sid"])
        let generatorString = CPace.generatorString(dsi: CPace.dsi, prs: prs, ci: ci, sid: sid)
        XCTAssertEqual(Fixtures.hexString(generatorString), g["generatorString"]?.string)
        let hash = Data(SHA512.hash(data: generatorString)).prefix(32)
        XCTAssertEqual(Fixtures.hexString(Data(hash)), g["hash"]?.string)
        XCTAssertEqual(Fixtures.hexString(CPace.elligator2(try hex(g["u"]))), g["g"]?.string)
        XCTAssertEqual(Fixtures.hexString(CPace.calculateGenerator(prs: prs, ci: ci, sid: sid)), g["g"]?.string)
    }

    func testDraftExchangeAndIsk() throws {
        let e = try XCTUnwrap(try vector()["draft"]?["exchange"])
        let g = try hex(e["g"]), sid = try hex(e["sid"])
        let ya = try hex(e["ya"]), yb = try hex(e["yb"])
        let adA = try hex(e["ADa"]), adB = try hex(e["ADb"])
        let pointA = try XCTUnwrap(CPace.x25519(scalar: ya, u: g))
        let pointB = try XCTUnwrap(CPace.x25519(scalar: yb, u: g))
        XCTAssertEqual(Fixtures.hexString(pointA), e["Ya"]?.string)
        XCTAssertEqual(Fixtures.hexString(pointB), e["Yb"]?.string)
        let kA = try XCTUnwrap(CPace.x25519(scalar: ya, u: pointB))
        let kB = try XCTUnwrap(CPace.x25519(scalar: yb, u: pointA))
        XCTAssertEqual(kA, kB)
        XCTAssertEqual(Fixtures.hexString(kA), e["K"]?.string)
        let transcript = CPace.lvCat([pointA, adA]) + CPace.lvCat([pointB, adB])
        XCTAssertEqual(Fixtures.hexString(transcript), e["transcriptIr"]?.string)
        let isk = CPace.deriveIsk(sid: sid, k: kA, ya: pointA, ada: adA, yb: pointB, adb: adB)
        XCTAssertEqual(Fixtures.hexString(isk), e["ISK"]?.string)

        // The same exchange through the initiator and the responder.
        let prs = try hex(e["prs"]), ci = try hex(e["ci"])
        let initiator = try XCTUnwrap(CPaceInitiator(prs: prs, ci: ci, ad: adA, sid: sid, scalar: ya))
        XCTAssertEqual(initiator.ya, pointA)
        let responder = try XCTUnwrap(cpaceRespond(prs: prs, sid: sid, ya: pointA, ci: ci, ad: adB, peerAd: adA, scalar: yb))
        XCTAssertEqual(responder.yb, pointB)
        let session = try XCTUnwrap(initiator.finish(yb: pointB, peerAd: adB))
        XCTAssertEqual(session.isk, isk)
        let confirmed = try XCTUnwrap(responder.confirm(session.ta))
        XCTAssertTrue(session.verifyTb(confirmed.tb))
    }

    func testDraftLowOrderPointsAbort() throws {
        let low = try XCTUnwrap(try vector()["draft"]?["lowOrder"])
        let s = try hex(low["s"])
        let cases = try XCTUnwrap(low["cases"]?.array)
        XCTAssertFalse(cases.isEmpty)
        var aborted = 0
        for item in cases {
            let u = try hex(item["u"])
            let out = CPace.x25519(scalar: s, u: u)
            if let q = item["q"]?.string {
                XCTAssertEqual(hexString(out), q, "u=\(item["u"]?.string ?? "")")
            } else {
                XCTAssertNil(out, "u=\(item["u"]?.string ?? "") must abort")
                aborted += 1
            }
        }
        XCTAssertGreaterThan(aborted, 0)
    }

    func testElligator2MapMatchesIncludingFieldBoundaries() throws {
        let map = try XCTUnwrap(try vector()["map"]?.array)
        XCTAssertGreaterThan(map.count, 60)
        for item in map {
            let u = try hex(item["u"])
            XCTAssertEqual(Fixtures.hexString(CPace.elligator2(u)), item["g"]?.string, "u=\(item["u"]?.string ?? "")")
        }
    }

    func testGeneratorMatchesForEveryPrsAndSid() throws {
        let generators = try XCTUnwrap(try vector()["generator"]?.array)
        XCTAssertGreaterThan(generators.count, 200)
        for item in generators {
            let g = CPace.calculateGenerator(prs: try hex(item["prs"]), ci: CPace.ci, sid: try hex(item["sid"]))
            XCTAssertEqual(Fixtures.hexString(g), item["g"]?.string, "prs=\(item["prs"]?.string ?? "")")
        }
    }

    func testX25519MatchesAndAbortsOnLowOrderInput() throws {
        let items = try XCTUnwrap(try vector()["x25519"]?.array)
        var aborted = 0
        for item in items {
            let out = CPace.x25519(scalar: try hex(item["k"]), u: try hex(item["u"]))
            if let expected = item["out"]?.string {
                XCTAssertEqual(hexString(out), expected, "u=\(item["u"]?.string ?? "")")
            } else {
                XCTAssertNil(out, "u=\(item["u"]?.string ?? "") must abort")
                aborted += 1
            }
        }
        XCTAssertGreaterThan(aborted, 0)
    }

    func testFullTransactionFromCodeToSealedOffer() throws {
        let t = try XCTUnwrap(try vector()["transaction"])
        let code = try XCTUnwrap(t["code"]?.string)
        let prs = Data(code.utf8)
        let sid = try hex(t["sid"])
        let scalarA = try hex(t["ya"]), scalarB = try hex(t["yb"])
        let offer = Data(try XCTUnwrap(t["offer"]?.string).utf8)
        XCTAssertEqual(t["ci"]?.string.map { Data($0.utf8) }, CPace.ci)

        let initiator = try XCTUnwrap(CPaceInitiator(prs: prs, sid: sid, scalar: scalarA))
        XCTAssertEqual(Fixtures.hexString(initiator.ya), t["Ya"]?.string)
        let responder = try XCTUnwrap(cpaceRespond(prs: prs, sid: sid, ya: initiator.ya, scalar: scalarB))
        XCTAssertEqual(Fixtures.hexString(responder.yb), t["Yb"]?.string)

        let k = try XCTUnwrap(CPace.x25519(scalar: scalarA, u: responder.yb))
        XCTAssertEqual(Fixtures.hexString(k), t["K"]?.string)

        let session = try XCTUnwrap(initiator.finish(yb: responder.yb))
        XCTAssertEqual(Fixtures.hexString(session.isk), t["ISK"]?.string)
        XCTAssertEqual(Fixtures.hexString(session.ta), t["Ta"]?.string)
        let confirmed = try XCTUnwrap(responder.confirm(session.ta))
        XCTAssertEqual(Fixtures.hexString(confirmed.tb), t["Tb"]?.string)
        XCTAssertTrue(session.verifyTb(confirmed.tb))
        XCTAssertEqual(Fixtures.hexString(CPace.sealKey(isk: session.isk)), t["kSeal"]?.string)

        let box = try confirmed.seal(offer)
        XCTAssertEqual(Fixtures.hexString(box), t["box"]?.string)
        XCTAssertEqual(session.open(box), offer)
        // The offer carries Korean text: the plaintext is UTF-8 bytes, not an escaped form.
        XCTAssertEqual(String(decoding: try XCTUnwrap(session.open(box)), as: UTF8.self), t["offer"]?.string)
    }

    func testWrongTagsAndTamperedBoxesAreRefused() throws {
        let t = try XCTUnwrap(try vector()["transaction"])
        let prs = Data(try XCTUnwrap(t["code"]?.string).utf8)
        let sid = try hex(t["sid"])
        let initiator = try XCTUnwrap(CPaceInitiator(prs: prs, sid: sid, scalar: try hex(t["ya"])))
        let responder = try XCTUnwrap(cpaceRespond(prs: prs, sid: sid, ya: initiator.ya, scalar: try hex(t["yb"])))
        let session = try XCTUnwrap(initiator.finish(yb: responder.yb))
        let confirmed = try XCTUnwrap(responder.confirm(session.ta))
        var tb = confirmed.tb
        tb[tb.startIndex] ^= 1
        XCTAssertFalse(session.verifyTb(tb))
        XCTAssertFalse(session.verifyTb(Data(tb.dropLast())))
        var ta = session.ta
        ta[ta.startIndex + 63] ^= 0x80
        XCTAssertNil(responder.confirm(ta))
        let box = try CPace.sealBox(isk: session.isk, plaintext: Data("offer".utf8))
        var tampered = box
        tampered[tampered.startIndex] ^= 1
        XCTAssertNil(session.open(tampered))
        XCTAssertNil(session.open(Data(box.prefix(10))))
        XCTAssertNil(CPace.openBox(isk: Data(repeating: 7, count: 64), box: box))

        // A wrong code derives a different ISK: the responder's tag check fails.
        let other = try XCTUnwrap(CPaceInitiator(prs: Data("4PUXU36F4W".utf8), sid: sid, scalar: try hex(t["ya"])))
        let otherSession = try XCTUnwrap(other.finish(yb: responder.yb))
        XCTAssertNil(responder.confirm(otherSession.ta))
        XCTAssertFalse(otherSession.verifyTb(confirmed.tb))
    }

    func testInvalidPeerPointsAbortTheInitiator() throws {
        let initiator = try XCTUnwrap(CPaceInitiator(prs: Data("4PUXU36F4W".utf8)))
        XCTAssertNil(initiator.finish(yb: Data(count: 32)))
        XCTAssertNil(initiator.finish(yb: Data(repeating: 1, count: 31)))
        var one = Data(count: 32)
        one[0] = 1
        XCTAssertNil(initiator.finish(yb: one))
        XCTAssertNotNil(initiator.finish(yb: try XCTUnwrap(CPace.x25519(scalar: Data(repeating: 5, count: 32), u: CPace.calculateGenerator(prs: Data("x".utf8), ci: CPace.ci, sid: initiator.sid)))))
    }

    /// The seal's nonce is fixed at zero, so every session must draw fresh scalars: the same sid and Ya replayed
    /// gives a different Yb and ISK.
    func testResponderDrawsAFreshScalarPerSession() throws {
        let prs = Data("4PUXU36F4W".utf8)
        let initiator = try XCTUnwrap(CPaceInitiator(prs: prs))
        let first = try XCTUnwrap(cpaceRespond(prs: prs, sid: initiator.sid, ya: initiator.ya))
        let second = try XCTUnwrap(cpaceRespond(prs: prs, sid: initiator.sid, ya: initiator.ya))
        XCTAssertNotEqual(first.yb, second.yb)
        let sessionA = try XCTUnwrap(initiator.finish(yb: first.yb))
        let sessionB = try XCTUnwrap(initiator.finish(yb: second.yb))
        XCTAssertNotEqual(sessionA.isk, sessionB.isk)
        let boxA = try XCTUnwrap(first.confirm(sessionA.ta)).seal(Data("same".utf8))
        let boxB = try XCTUnwrap(second.confirm(sessionB.ta)).seal(Data("same".utf8))
        XCTAssertNotEqual(boxA, boxB)
    }

    /// One session seals one message however often the right Ta is confirmed: every confirm hands out the same
    /// object, so a second seal fails (it would reuse the fixed nonce).
    func testASessionSealsExactlyOneMessageAcrossConfirms() throws {
        let prs = Data("4PUXU36F4W".utf8)
        let initiator = try XCTUnwrap(CPaceInitiator(prs: prs))
        let responder = try XCTUnwrap(cpaceRespond(prs: prs, sid: initiator.sid, ya: initiator.ya))
        let session = try XCTUnwrap(initiator.finish(yb: responder.yb))
        let first = try XCTUnwrap(responder.confirm(session.ta))
        let second = try XCTUnwrap(responder.confirm(session.ta))
        XCTAssertTrue(first === second)
        XCTAssertEqual(first.tb, second.tb)
        XCTAssertNoThrow(try first.seal(Data("one".utf8)))
        XCTAssertThrowsError(try second.seal(Data("two".utf8))) { XCTAssertEqual($0 as? CPaceSealError, .alreadySealed) }
        XCTAssertThrowsError(try first.seal(Data("three".utf8))) { XCTAssertEqual($0 as? CPaceSealError, .alreadySealed) }
    }
}
