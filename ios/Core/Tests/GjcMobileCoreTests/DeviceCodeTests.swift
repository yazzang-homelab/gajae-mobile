import Foundation
import XCTest
@testable import GjcMobileCore

/// codes.valid / reject / normalize in fixtures/cpace-vector.json, shared with the bridge and Android.
final class DeviceCodeTests: XCTestCase {
    private func codes() throws -> JSONValue { try XCTUnwrap(try Fixtures.json("cpace-vector.json")["codes"]) }

    private func rangeName(_ range: CodeRange) -> String { range.rawValue }

    func testValidCodesDecodeAndEncodeBack() throws {
        let c = try codes()
        XCTAssertEqual(String(DeviceCode.alphabet), c["alphabet"]?.string)
        XCTAssertEqual(DeviceCode.defaultPort, c["defaultPort"]?.int)
        let valid = try XCTUnwrap(c["valid"]?.array)
        XCTAssertGreaterThan(valid.count, 8)
        for item in valid {
            let code = try XCTUnwrap(item["code"]?.string)
            let ip = try XCTUnwrap(item["ip"]?.string)
            let port = try XCTUnwrap(item["port"]?.int)
            let secret = try XCTUnwrap(item["secret"]?.int)
            let decoded = try DecodedCode.parse(code)
            XCTAssertEqual(decoded.code, code)
            XCTAssertEqual(decoded.address.ip, ip, code)
            XCTAssertEqual(decoded.address.port, port, code)
            XCTAssertEqual(rangeName(decoded.address.range), item["range"]?.string, code)
            XCTAssertEqual(decoded.endpoint.absoluteString, "ws://\(ip):\(port)/ws", code)
            XCTAssertEqual(DeviceCode.formatted(code), item["formatted"]?.string, code)
            XCTAssertEqual(try DeviceCode.encode(ip: ip, port: port, secret: secret), code)
            // The formatted, lowercase and padded spellings are the same code.
            XCTAssertEqual(try DecodedCode.parse(" " + DeviceCode.formatted(code).lowercased() + " ").code, code)
        }
    }

    func testRejectedCodesReportTheBridgesErrorsAndPositions() throws {
        let reject = try XCTUnwrap(try codes()["reject"]?.array)
        XCTAssertGreaterThan(reject.count, 10)
        for item in reject {
            let input = try XCTUnwrap(item["input"]?.string)
            let expected: DeviceCodeError
            switch item["error"]?.string {
            case "code_unsupported": expected = .unsupported
            case "code_format": expected = .format(position: item["position"]?.int)
            default: return XCTFail("unknown error in fixture: \(String(describing: item["error"]))")
            }
            switch DeviceCode.decode(input) {
            case let .success(decoded): XCTFail("\(input) decoded as \(decoded)")
            case let .failure(error): XCTAssertEqual(error, expected, input)
            }
        }
    }

    func testNormalizeUppercasesAndDropsSeparators() throws {
        for item in try XCTUnwrap(try codes()["normalize"]?.array) {
            let input = try XCTUnwrap(item["input"]?.string)
            XCTAssertEqual(DeviceCode.normalize(input), .success(try XCTUnwrap(item["code"]?.string)), input)
        }
        XCTAssertEqual(DeviceCode.normalize("L"), .success("L"))
        XCTAssertEqual(DeviceCode.normalize("k7m2\t9qxd\n-hp"), .success("K7M29QXDHP"))
        XCTAssertEqual(DeviceCode.normalize("K7-M0"), .failure(.format(position: 4)))
        XCTAssertEqual(DeviceCode.normalize("é"), .failure(.format(position: 1)))
    }

    func testEncodeRejectsAddressesAndValuesThatDoNotFit() {
        XCTAssertThrowsError(try DeviceCode.encode(ip: "8.8.8.8", port: 7787, secret: 1)) { XCTAssertEqual($0 as? DeviceCodeError, .unsupported) }
        XCTAssertThrowsError(try DeviceCode.encode(ip: "100.100.1.2", port: 0, secret: 1))
        XCTAssertThrowsError(try DeviceCode.encode(ip: "100.100.1.2", port: 7787, secret: 1 << 20))
        XCTAssertThrowsError(try DeviceCode.encode(ip: "100.100.1", port: 7787, secret: 1))
    }

    func testExplicitPortAndLengthsPerRange() throws {
        let cases: [(ip: String, port: Int, length: Int)] = [
            ("100.100.1.2", 7787, 10), ("100.100.1.2", 9000, 14),
            ("10.1.2.3", 7787, 11), ("10.1.2.3", 9000, 14),
            ("172.16.5.4", 7787, 10), ("172.16.5.4", 9000, 13),
            ("192.168.0.10", 7787, 9), ("192.168.0.10", 9000, 12),
        ]
        for item in cases {
            let code = try DeviceCode.encode(ip: item.ip, port: item.port, secret: 0xABCDE)
            XCTAssertEqual(code.count, item.length, "\(item)")
            let decoded = try DecodedCode.parse(code)
            XCTAssertEqual(decoded.address.ip, item.ip)
            XCTAssertEqual(decoded.address.port, item.port)
        }
    }

    func testTailscaleRange() {
        XCTAssertTrue(DeviceCode.isTailscale("100.64.0.1"))
        XCTAssertTrue(DeviceCode.isTailscale("100.127.255.255"))
        XCTAssertFalse(DeviceCode.isTailscale("100.128.0.1"))
        XCTAssertFalse(DeviceCode.isTailscale("192.168.0.1"))
    }
}
