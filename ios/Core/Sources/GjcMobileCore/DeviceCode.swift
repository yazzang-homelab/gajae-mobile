import Crypto
import Foundation

// gjcm-code-v1 device code, phone side. Mirrors bridge/src/device-code.ts (verified by fixtures/cpace-vector.json).
//
//   bits (MSB first) = type(4) ‖ addr(n) ‖ [port(16)] ‖ secret(20) ‖ check(k ≥ 4, up to the character boundary)
//   type: high bit = explicit port (absent means 7787); low 3 bits = address range
//     001 Tailscale 100.64.0.0/10 (22)  010 10.0.0.0/8 (24)  011 172.16.0.0/12 (20)  100 192.168.0.0/16 (16)
//     000, 101–111 reserved → unsupported
//   check = top k bits of SHA-256("gjcm-code-v1" ‖ m ‖ first m bits packed MSB first, zero padded)
// The whole normalized string (check included) is the CPace password; the check only catches typos before dialing.

public enum CodeRange: String, Sendable, Equatable {
    case tailscale
    case ten
    case oneSevenTwo
    case oneNineTwo
}

public struct CodeAddress: Equatable, Sendable {
    public let ip: String
    public let port: Int
    public let range: CodeRange
}

public struct DecodedCode: Equatable, Sendable {
    /// Normalized code: uppercase, no separators. This is the CPace password.
    public let code: String
    public let address: CodeAddress
    /// `ws://ip:port/ws`
    public let endpoint: URL
}

public enum DeviceCodeError: Error, Equatable, Sendable {
    /// Wrong character, length or check. `position` is the 1-based place of the first character outside the alphabet.
    case format(position: Int?)
    /// A reserved address type: a newer code format than this app knows.
    case unsupported
}

public enum DeviceCode {
    public static let alphabet = Array("23456789ABCDEFGHJKLMNPQRSTUVWXYZ")
    public static let defaultPort = 7787
    public static let secretBits = 20
    /// The longest code: Tailscale or 10/8 address with an explicit port.
    public static let maxLength = 14

    private static let checkLabel = Data("gjcm-code-v1".utf8)
    private static let explicitPortBit = 0b1000

    private struct RangeSpec {
        let type: Int
        let range: CodeRange
        let base: UInt32
        let prefixBits: Int
    }

    private static let ranges: [RangeSpec] = [
        RangeSpec(type: 0b001, range: .tailscale, base: ipv4(100, 64, 0, 0), prefixBits: 10),
        RangeSpec(type: 0b010, range: .ten, base: ipv4(10, 0, 0, 0), prefixBits: 8),
        RangeSpec(type: 0b011, range: .oneSevenTwo, base: ipv4(172, 16, 0, 0), prefixBits: 12),
        RangeSpec(type: 0b100, range: .oneNineTwo, base: ipv4(192, 168, 0, 0), prefixBits: 16),
    ]

    private static func ipv4(_ a: UInt32, _ b: UInt32, _ c: UInt32, _ d: UInt32) -> UInt32 {
        (a << 24) | (b << 16) | (c << 8) | d
    }

    private static func ipText(_ n: UInt32) -> String {
        "\(n >> 24).\((n >> 16) & 0xFF).\((n >> 8) & 0xFF).\(n & 0xFF)"
    }

    // MARK: bits

    private static func readBits(_ bits: [UInt8], from: Int, width: Int) -> Int {
        var value = 0
        for i in 0 ..< width { value = value * 2 + Int(bits[from + i]) }
        return value
    }

    private static func pushBits(_ bits: inout [UInt8], _ value: Int, width: Int) {
        for i in stride(from: width - 1, through: 0, by: -1) { bits.append(UInt8((value >> i) & 1)) }
    }

    private static func packMsbFirst(_ bits: [UInt8]) -> Data {
        var out = [UInt8](repeating: 0, count: (bits.count + 7) / 8)
        for (i, bit) in bits.enumerated() where bit != 0 { out[i >> 3] |= UInt8(0x80 >> (i & 7)) }
        return Data(out)
    }

    private static func checkBits(_ payload: [UInt8], count k: Int) -> [UInt8] {
        var hash = SHA256()
        hash.update(data: checkLabel)
        hash.update(data: Data([UInt8(payload.count)]))
        hash.update(data: packMsbFirst(payload))
        let digest = Array(hash.finalize())
        return (0 ..< k).map { (digest[$0 >> 3] >> UInt8(7 - ($0 & 7))) & 1 }
    }

    private static func payloadBits(_ spec: RangeSpec, explicitPort: Bool) -> Int {
        4 + (32 - spec.prefixBits) + (explicitPort ? 16 : 0) + secretBits
    }

    /// Characters for m payload bits: room for at least 4 check bits.
    private static func codeLength(_ m: Int) -> Int { (m + 4 + 4) / 5 }

    // MARK: normalize / format

    /// Hyphen plus exactly JavaScript's `\s` set, as the bridge's normalizer drops them; nothing else separates
    /// (U+200B and U+0085 are rejected).
    static func isSeparator(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x2D, 0x09 ... 0x0D, 0x20, 0xA0, 0x1680, 0x2000 ... 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    /// Uppercases ASCII a–z only: Unicode case mapping would turn ß into SS and ſ into S.
    static func asciiUppercased(_ scalar: Unicode.Scalar) -> Unicode.Scalar {
        (0x61 ... 0x7A).contains(scalar.value) ? Unicode.Scalar(scalar.value - 0x20)! : scalar
    }

    /// Uppercase ASCII letters, drop separators (hyphen and JS whitespace); any other character outside the alphabet
    /// (0 O 1 I …) is rejected with its 1-based position among the characters kept so far.
    public static func normalize(_ input: String) -> Result<String, DeviceCodeError> {
        var code = ""
        for raw in input.unicodeScalars {
            if isSeparator(raw) { continue }
            let scalar = asciiUppercased(raw)
            guard scalar.isASCII, alphabet.contains(Character(scalar)) else {
                return .failure(.format(position: code.count + 1))
            }
            code.unicodeScalars.append(scalar)
        }
        return .success(code)
    }

    /// Groups of four: K7M2-9QXD-HP.
    public static func formatted(_ code: String) -> String {
        var groups: [String] = []
        var current = ""
        for ch in code {
            if current.count == 4 {
                groups.append(current)
                current = ""
            }
            current.append(ch)
        }
        if !current.isEmpty { groups.append(current) }
        return groups.joined(separator: "-")
    }

    // MARK: decode

    public static func decode(_ input: String) -> Result<DecodedCode, DeviceCodeError> {
        let code: String
        switch normalize(input) {
        case let .success(value): code = value
        case let .failure(error): return .failure(error)
        }
        if code.isEmpty { return .failure(.format(position: nil)) }
        var bits: [UInt8] = []
        for ch in code {
            let value = alphabet.firstIndex(of: ch) ?? 0
            pushBits(&bits, value, width: 5)
        }
        let type = readBits(bits, from: 0, width: 4)
        guard let spec = ranges.first(where: { $0.type == type & 0b111 }) else { return .failure(.unsupported) }
        let explicitPort = type & explicitPortBit != 0
        let m = payloadBits(spec, explicitPort: explicitPort)
        guard code.count == codeLength(m) else { return .failure(.format(position: nil)) }
        guard checkBits(Array(bits[0 ..< m]), count: code.count * 5 - m) == Array(bits[m...]) else {
            return .failure(.format(position: nil))
        }
        let hostBits = 32 - spec.prefixBits
        let ip = ipText(spec.base &+ UInt32(readBits(bits, from: 4, width: hostBits)))
        let port = explicitPort ? readBits(bits, from: 4 + hostBits, width: 16) : defaultPort
        // Port 0 cannot be dialled, and an explicit 7787 has a shorter canonical code: no bridge prints either.
        guard port != 0, !(explicitPort && port == defaultPort), let endpoint = URL(string: "ws://\(ip):\(port)/ws") else {
            return .failure(.format(position: nil))
        }
        return .success(DecodedCode(code: code, address: CodeAddress(ip: ip, port: port, range: spec.range), endpoint: endpoint))
    }

    // MARK: encode (tests and tools)

    /// The code for an address and a 20-bit secret. Throws `.unsupported` for an address outside the four ranges.
    public static func encode(ip: String, port: Int, secret: Int) throws -> String {
        let octets = ip.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ ($0 ?? -1) >= 0 && $0! <= 255 }),
              (1 ... 65535).contains(port), (0 ..< (1 << secretBits)).contains(secret)
        else { throw DeviceCodeError.format(position: nil) }
        let o = octets.map { UInt32($0!) }
        let address = ipv4(o[0], o[1], o[2], o[3])
        guard let spec = ranges.first(where: { address >> UInt32(32 - $0.prefixBits) == $0.base >> UInt32(32 - $0.prefixBits) }) else {
            throw DeviceCodeError.unsupported
        }
        let explicitPort = port != defaultPort
        var bits: [UInt8] = []
        pushBits(&bits, (explicitPort ? explicitPortBit : 0) | spec.type, width: 4)
        pushBits(&bits, Int(address &- spec.base), width: 32 - spec.prefixBits)
        if explicitPort { pushBits(&bits, port, width: 16) }
        pushBits(&bits, secret, width: secretBits)
        let m = bits.count
        let length = codeLength(m)
        bits += checkBits(bits, count: length * 5 - m)
        return String((0 ..< length).map { alphabet[readBits(bits, from: $0 * 5, width: 5)] })
    }

    /// Whether `ip` lies in Tailscale's 100.64.0.0/10.
    public static func isTailscale(_ ip: String) -> Bool {
        let parts = ip.split(separator: ".").compactMap { Int($0) }
        return parts.count == 4 && parts[0] == 100 && (64 ... 127).contains(parts[1])
    }
}

/// What the code field shows for the text typed or pasted into it.
public struct CodeInputState: Equatable, Sendable {
    /// Uppercase, four-character groups joined by hyphens, at most `DeviceCode.maxLength` characters.
    public let display: String
    /// The characters without separators: the code to decode.
    public let code: String
    /// 1-based position of the first character outside the alphabet, if any.
    public let invalidPosition: Int?
    public let invalidCharacter: Character?
}

public enum CodeInputFormatter {
    /// Uppercases ASCII, drops hyphens and whitespace as `DeviceCode.normalize` does (so a pasted `k7m2 9qxd-hp` works), caps the length and regroups by four.
    /// Characters outside the alphabet stay visible so the user can see which one is wrong; the first is reported.
    public static func format(_ text: String) -> CodeInputState {
        var kept: [Character] = []
        var invalidPosition: Int?
        var invalidCharacter: Character?
        for raw in text.unicodeScalars {
            if DeviceCode.isSeparator(raw) { continue }
            let scalar = DeviceCode.asciiUppercased(raw)
            if kept.count == DeviceCode.maxLength { break }
            let ch = Character(scalar)
            kept.append(ch)
            if invalidPosition == nil, !(scalar.isASCII && DeviceCode.alphabet.contains(ch)) {
                invalidPosition = kept.count
                invalidCharacter = ch
            }
        }
        let code = String(kept)
        return CodeInputState(
            display: DeviceCode.formatted(code),
            code: code,
            invalidPosition: invalidPosition,
            invalidCharacter: invalidCharacter
        )
    }
}
