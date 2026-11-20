import Crypto
import Foundation

// CPACE-X25519-SHA512, pinned to draft-irtf-cfrg-cpace-21 (gjcm-code-v1, issue #128), phone side.
// Mirrors bridge/src/cpace.ts byte for byte (verified by fixtures/cpace-vector.json).
//
// The phone is initiator A and the bridge is responder B; both only share the typed device code (PRS).
//   A → B  sid, Ya          B → A  Yb
//   A → B  Ta               B → A  Tb and box = AES-256-GCM(kSeal, offer)   (only after Ta checks)
// X25519 is the platform's (it clamps the raw 32-byte scalar itself). The generator comes from Elligator2 over
// GF(2^255-19), computed here with 5×51-bit limbs and no dependency. It touches only public values and the code.

// MARK: field GF(2^255-19)

/// 128-bit accumulator for limb products (UInt128 needs a newer OS than the package targets).
private struct Wide {
    var lo: UInt64 = 0
    var hi: UInt64 = 0

    mutating func addProduct(_ a: UInt64, _ b: UInt64) {
        let (high, low) = a.multipliedFullWidth(by: b)
        let (sum, overflow) = lo.addingReportingOverflow(low)
        lo = sum
        hi = hi &+ high &+ (overflow ? 1 : 0)
    }

    mutating func add(_ value: UInt64) {
        let (sum, overflow) = lo.addingReportingOverflow(value)
        lo = sum
        hi = hi &+ (overflow ? 1 : 0)
    }

    /// The low 51 bits.
    var low51: UInt64 { lo & Fe25519.mask51 }
    /// The value shifted right by 51; the callers keep the accumulator below 2^115, so it fits.
    var carry51: UInt64 { (hi << 13) | (lo >> 51) }
}

/// A field element as five limbs of 51 bits (radix 2^51), little endian. Operations return limbs that are at most a
/// few bits above 51, which the next multiplication or subtraction tolerates. Nothing branches on the value.
struct Fe25519 {
    static let mask51: UInt64 = (1 << 51) - 1

    var x0: UInt64
    var x1: UInt64
    var x2: UInt64
    var x3: UInt64
    var x4: UInt64

    static let zero = Fe25519(x0: 0, x1: 0, x2: 0, x3: 0, x4: 0)
    static let one = Fe25519(x0: 1, x1: 0, x2: 0, x3: 0, x4: 0)

    init(x0: UInt64, x1: UInt64, x2: UInt64, x3: UInt64, x4: UInt64) {
        self.x0 = x0
        self.x1 = x1
        self.x2 = x2
        self.x3 = x3
        self.x4 = x4
    }

    init(small: UInt64) {
        self.init(x0: small, x1: 0, x2: 0, x3: 0, x4: 0)
    }

    /// 32 little-endian bytes; bit 255 is dropped (RFC 7748 decodeUCoordinate). The 255-bit value may be ≥ p;
    /// the arithmetic treats it modulo p.
    init(bytes: [UInt8]) {
        precondition(bytes.count == 32)
        func load(_ offset: Int) -> UInt64 {
            var word: UInt64 = 0
            for i in 0 ..< 8 { word |= UInt64(bytes[offset + i]) << UInt64(8 * i) }
            return word
        }
        let m = Fe25519.mask51
        self.init(
            x0: load(0) & m,
            x1: (load(6) >> 3) & m,
            x2: (load(12) >> 6) & m,
            x3: (load(19) >> 1) & m,
            x4: (load(24) >> 12) & m // bits 204…254: bit 255 falls off here
        )
    }

    /// Propagates carries so every limb is below 2^51 plus a small remainder in limb 0.
    func carried() -> Fe25519 {
        let m = Fe25519.mask51
        var c = x0 >> 51
        let t0 = x0 & m
        let t1a = x1 &+ c
        c = t1a >> 51
        let t1 = t1a & m
        let t2a = x2 &+ c
        c = t2a >> 51
        let t2 = t2a & m
        let t3a = x3 &+ c
        c = t3a >> 51
        let t3 = t3a & m
        let t4a = x4 &+ c
        c = t4a >> 51
        let t4 = t4a & m
        return Fe25519(x0: t0 &+ c &* 19, x1: t1, x2: t2, x3: t3, x4: t4)
    }

    func adding(_ o: Fe25519) -> Fe25519 {
        Fe25519(x0: x0 &+ o.x0, x1: x1 &+ o.x1, x2: x2 &+ o.x2, x3: x3 &+ o.x3, x4: x4 &+ o.x4).carried()
    }

    /// self − o, computed as self + 4p − o so no limb goes negative (o's limbs stay below 2^53).
    func subtracting(_ o: Fe25519) -> Fe25519 {
        let m = Fe25519.mask51
        let fourP0 = 4 &* (m &- 18)
        let fourP = 4 &* m
        return Fe25519(
            x0: x0 &+ fourP0 &- o.x0,
            x1: x1 &+ fourP &- o.x1,
            x2: x2 &+ fourP &- o.x2,
            x3: x3 &+ fourP &- o.x3,
            x4: x4 &+ fourP &- o.x4
        ).carried()
    }

    func multiplied(by b: Fe25519) -> Fe25519 {
        // 2^255 ≡ 19: products that land at limb 5 and above fold back multiplied by 19.
        let b1x19 = b.x1 &* 19
        let b2x19 = b.x2 &* 19
        let b3x19 = b.x3 &* 19
        let b4x19 = b.x4 &* 19

        var r0 = Wide()
        r0.addProduct(x0, b.x0)
        r0.addProduct(x1, b4x19)
        r0.addProduct(x2, b3x19)
        r0.addProduct(x3, b2x19)
        r0.addProduct(x4, b1x19)

        var r1 = Wide()
        r1.addProduct(x0, b.x1)
        r1.addProduct(x1, b.x0)
        r1.addProduct(x2, b4x19)
        r1.addProduct(x3, b3x19)
        r1.addProduct(x4, b2x19)

        var r2 = Wide()
        r2.addProduct(x0, b.x2)
        r2.addProduct(x1, b.x1)
        r2.addProduct(x2, b.x0)
        r2.addProduct(x3, b4x19)
        r2.addProduct(x4, b3x19)

        var r3 = Wide()
        r3.addProduct(x0, b.x3)
        r3.addProduct(x1, b.x2)
        r3.addProduct(x2, b.x1)
        r3.addProduct(x3, b.x0)
        r3.addProduct(x4, b4x19)

        var r4 = Wide()
        r4.addProduct(x0, b.x4)
        r4.addProduct(x1, b.x3)
        r4.addProduct(x2, b.x2)
        r4.addProduct(x3, b.x1)
        r4.addProduct(x4, b.x0)

        var t0 = r0.low51
        var c = r0.carry51
        r1.add(c)
        let t1 = r1.low51
        c = r1.carry51
        r2.add(c)
        let t2 = r2.low51
        c = r2.carry51
        r3.add(c)
        let t3 = r3.low51
        c = r3.carry51
        r4.add(c)
        let t4 = r4.low51
        c = r4.carry51
        t0 = t0 &+ c &* 19
        let c0 = t0 >> 51
        return Fe25519(x0: t0 & Fe25519.mask51, x1: t1 &+ c0, x2: t2, x3: t3, x4: t4)
    }

    func squared() -> Fe25519 { multiplied(by: self) }

    /// self^e for a public little-endian exponent. The exponent is a constant, so branching on its bits leaks
    /// nothing about the field value; every step runs the same multiplications for any input.
    func power(_ exponent: [UInt8]) -> Fe25519 {
        var result = Fe25519.one
        for byte in exponent.reversed() {
            for bit in (0 ..< 8).reversed() {
                result = result.squared()
                if (byte >> UInt8(bit)) & 1 == 1 { result = result.multiplied(by: self) }
            }
        }
        return result
    }

    /// p − 2 = 2^255 − 21, little endian.
    static let inverseExponent: [UInt8] = [0xEB] + [UInt8](repeating: 0xFF, count: 30) + [0x7F]
    /// (p − 1) / 2 = 2^254 − 10, little endian.
    static let legendreExponent: [UInt8] = [0xF6] + [UInt8](repeating: 0xFF, count: 30) + [0x3F]

    /// x^(p−2); zero maps to zero.
    func inverted() -> Fe25519 { power(Fe25519.inverseExponent) }

    /// Limbs of the unique representative in [0, p), each below 2^51.
    func frozenLimbs() -> [UInt64] {
        var t = self
        for _ in 0 ..< 3 { t = t.carried() }
        let m = Fe25519.mask51
        // q = 1 when t ≥ p (t < 2^255 here), else 0: carry out of t + 19.
        var q = (t.x0 &+ 19) >> 51
        q = (t.x1 &+ q) >> 51
        q = (t.x2 &+ q) >> 51
        q = (t.x3 &+ q) >> 51
        q = (t.x4 &+ q) >> 51
        var l0 = t.x0 &+ 19 &* q
        var l1 = t.x1
        var l2 = t.x2
        var l3 = t.x3
        var l4 = t.x4
        l1 = l1 &+ (l0 >> 51)
        l0 &= m
        l2 = l2 &+ (l1 >> 51)
        l1 &= m
        l3 = l3 &+ (l2 >> 51)
        l2 &= m
        l4 = l4 &+ (l3 >> 51)
        l3 &= m
        l4 &= m // subtracting p = adding 19 and dropping bit 255
        return [l0, l1, l2, l3, l4]
    }

    /// Canonical 32-byte little-endian encoding.
    func bytes() -> [UInt8] {
        let l = frozenLimbs()
        let words: [UInt64] = [
            l[0] | (l[1] << 51),
            (l[1] >> 13) | (l[2] << 38),
            (l[2] >> 26) | (l[3] << 25),
            (l[3] >> 39) | (l[4] << 12),
        ]
        var out = [UInt8](repeating: 0, count: 32)
        for (i, word) in words.enumerated() {
            for j in 0 ..< 8 { out[8 * i + j] = UInt8(truncatingIfNeeded: word >> UInt64(8 * j)) }
        }
        return out
    }

    /// 1 when both are the same field element, else 0, without branching on the values.
    func isEqual(_ o: Fe25519) -> UInt64 {
        let a = frozenLimbs()
        let b = o.frozenLimbs()
        var diff: UInt64 = 0
        for i in 0 ..< 5 { diff |= a[i] ^ b[i] }
        // diff == 0 ⇔ equal: (diff | −diff) has its top bit set exactly when diff ≠ 0.
        return 1 &- ((diff | (0 &- diff)) >> 63)
    }

    /// `flag` is 1: a, 0: b (constant-time select).
    static func select(_ flag: UInt64, _ a: Fe25519, _ b: Fe25519) -> Fe25519 {
        let mask = 0 &- flag
        func pick(_ x: UInt64, _ y: UInt64) -> UInt64 { y ^ (mask & (x ^ y)) }
        return Fe25519(x0: pick(a.x0, b.x0), x1: pick(a.x1, b.x1), x2: pick(a.x2, b.x2), x3: pick(a.x3, b.x3), x4: pick(a.x4, b.x4))
    }
}

// MARK: CPace

public enum CPace {
    public static let dsi = Data("CPace255".utf8)
    public static let sInBytes = 128
    /// Channel identifier: roles are fixed (app = A, bridge = B), and the code already names the address.
    public static let ci = Data("gjcm-code-v1".utf8)
    static let sealInfo = Data("gjcm-code-v1 seal".utf8)
    static let sealAAD = Data("gjcm-code-v1".utf8)
    static let tagBytes = 16

    /// LEB128 length prefix (draft A.1.1).
    public static func prependLen(_ data: Data) -> Data {
        var out = Data()
        var length = data.count
        repeat {
            var b = UInt8(length & 0x7F)
            length >>= 7
            if length > 0 { b |= 0x80 }
            out.append(b)
        } while length > 0
        return out + data
    }

    public static func lvCat(_ parts: [Data]) -> Data {
        parts.reduce(into: Data()) { $0.append(prependLen($1)) }
    }

    public static func generatorString(dsi: Data, prs: Data, ci: Data, sid: Data, sInBytes: Int = CPace.sInBytes) -> Data {
        let zpad = max(0, sInBytes - 1 - prependLen(prs).count - prependLen(dsi).count)
        return lvCat([dsi, prs, Data(count: zpad), ci, sid])
    }

    /// Elligator2 onto curve25519 (draft A.5): v = −A / (1 + 2u²), ε = legendre(v³ + A v² + v),
    /// x = ε v − (1 − ε) A/2, which is v for ε = 1 and −v − A for ε = −1. Takes the 32 little-endian bytes of the
    /// input (bit 255 is ignored) and returns the 32 little-endian bytes of x.
    public static func elligator2(_ uBytes: Data) -> Data {
        let u = Fe25519(bytes: [UInt8](uBytes))
        let a = Fe25519(small: 486_662)
        let denominator = Fe25519.one.adding(u.squared().adding(u.squared())) // 1 + 2u², never 0 (−1/2 is a non-square)
        let v = Fe25519.zero.subtracting(a).multiplied(by: denominator.inverted())
        let v2 = v.squared()
        // v³ + A v² + v, never 0, so ε is 1 or p − 1.
        let gv = v2.multiplied(by: v).adding(a.multiplied(by: v2)).adding(v)
        let epsilon = gv.power(Fe25519.legendreExponent)
        let negated = Fe25519.zero.subtracting(v).subtracting(a)
        let x = Fe25519.select(epsilon.isEqual(.one), v, negated)
        return Data(x.bytes())
    }

    /// G.calculate_generator: the X25519 u-coordinate both sides start from.
    public static func calculateGenerator(prs: Data, ci: Data, sid: Data) -> Data {
        let hash = Data(SHA512.hash(data: generatorString(dsi: dsi, prs: prs, ci: ci, sid: sid)))
        return elligator2(hash.prefix(32))
    }

    /// scalar_mult_vfy: X25519(scalar, u), or nil when the key agreement fails (a low-order input) or yields the
    /// all-zero output. Callers abort on nil. Bit 255 of `u` is masked first (RFC 7748).
    public static func x25519(scalar: Data, u: Data) -> Data? {
        guard scalar.count == 32, u.count == 32 else { return nil }
        var point = [UInt8](u)
        point[31] &= 0x7F
        do {
            let privateKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: scalar)
            let publicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: Data(point))
            let out = try privateKey.sharedSecretFromKeyAgreement(with: publicKey).rawData
            // OR-accumulate so the all-zero check does not stop at the first non-zero byte.
            var accumulated: UInt8 = 0
            for byte in out { accumulated |= byte }
            return accumulated == 0 ? nil : out
        } catch {
            return nil
        }
    }

    /// ISK for the initiator/responder setting: H(lv_cat("CPace255_ISK", sid, K) ‖ lv_cat(Ya, ADa) ‖ lv_cat(Yb, ADb)).
    public static func deriveIsk(sid: Data, k: Data, ya: Data, ada: Data, yb: Data, adb: Data) -> Data {
        var hash = SHA512()
        hash.update(data: lvCat([dsi + Data("_ISK".utf8), sid, k]))
        hash.update(data: lvCat([ya, ada]))
        hash.update(data: lvCat([yb, adb]))
        return Data(hash.finalize())
    }

    /// §10.4 key confirmation: mac_key = H("CPaceMac" ‖ sid ‖ ISK); tag = HMAC(mac_key, lv_cat(Y, AD)).
    public static func confirmationTag(sid: Data, isk: Data, y: Data, ad: Data) -> Data {
        var hash = SHA512()
        hash.update(data: Data("CPaceMac".utf8))
        hash.update(data: sid)
        hash.update(data: isk)
        let macKey = SymmetricKey(data: Data(hash.finalize()))
        return Data(HMAC<SHA512>.authenticationCode(for: lvCat([y, ad]), using: macKey))
    }

    public static func sealKey(isk: Data) -> Data {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: isk), salt: Data(), info: sealInfo, outputByteCount: 32).rawData
    }

    /// Seals once per ISK, so the zero nonce never repeats under one key.
    public static func sealBox(isk: Data, plaintext: Data) throws -> Data {
        let key = SymmetricKey(data: sealKey(isk: isk))
        let box = try AES.GCM.seal(plaintext, using: key, nonce: AES.GCM.Nonce(data: Data(count: 12)), authenticating: sealAAD)
        return box.ciphertext + box.tag
    }

    public static func openBox(isk: Data, box: Data) -> Data? {
        let bytes = Data(box)
        guard bytes.count >= tagBytes else { return nil }
        do {
            let key = SymmetricKey(data: sealKey(isk: isk))
            let sealed = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: Data(count: 12)),
                ciphertext: bytes.prefix(bytes.count - tagBytes),
                tag: bytes.suffix(tagBytes)
            )
            return try AES.GCM.open(sealed, using: key, authenticating: sealAAD)
        } catch {
            return nil
        }
    }

    /// Constant-time comparison of two tags.
    public static func tagsEqual(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for (x, y) in zip(a, b) { diff |= x ^ y }
        return diff == 0
    }

    static func randomBytes(_ count: Int) -> Data {
        var rng = SystemRandomNumberGenerator()
        return Data((0 ..< count).map { _ in UInt8.random(in: 0 ... 255, using: &rng) })
    }
}

/// Party A (the phone). `ya` goes out with `sid`; `finish(yb:)` checks B's point and yields Ta plus the checks for
/// B's answer. `sid` and `scalar` can be injected for test vectors only (internal init).
public struct CPaceInitiator: Sendable {
    public let sid: Data
    public let ya: Data
    private let scalar: Data
    private let ad: Data

    /// Nil when the generator is rejected (X25519 aborts). A fresh random sid and scalar.
    public init?(prs: Data, ci: Data = CPace.ci, ad: Data = Data()) {
        self.init(prs: prs, ci: ci, ad: ad, sid: CPace.randomBytes(16), scalar: CPace.randomBytes(32))
    }

    /// Test vectors: the sid and scalar are fixed by the caller.
    init?(prs: Data, ci: Data = CPace.ci, ad: Data = Data(), sid: Data, scalar: Data) {
        guard let ya = CPace.x25519(scalar: scalar, u: CPace.calculateGenerator(prs: prs, ci: ci, sid: sid)) else { return nil }
        self.sid = sid
        self.ya = ya
        self.scalar = scalar
        self.ad = ad
    }

    public struct Session: Sendable {
        public let isk: Data
        public let ta: Data
        let sid: Data
        let yb: Data
        let peerAd: Data

        public func verifyTb(_ tb: Data) -> Bool {
            CPace.tagsEqual(tb, CPace.confirmationTag(sid: sid, isk: isk, y: yb, ad: peerAd))
        }

        public func open(_ box: Data) -> Data? { CPace.openBox(isk: isk, box: box) }
    }

    /// Nil when Yb is invalid (abort).
    public func finish(yb: Data, peerAd: Data = Data()) -> Session? {
        guard yb.count == 32, let k = CPace.x25519(scalar: scalar, u: yb) else { return nil }
        let isk = CPace.deriveIsk(sid: sid, k: k, ya: ya, ada: ad, yb: yb, adb: peerAd)
        return Session(isk: isk, ta: CPace.confirmationTag(sid: sid, isk: isk, y: ya, ad: ad), sid: sid, yb: yb, peerAd: peerAd)
    }
}

/// Party B (the bridge), here only to reproduce the shared vectors and to play the bridge in tests. Mirrors the
/// bridge's `cpaceRespond`: the ISK stays inside, and Tb plus the one-shot seal come only from `confirm`. The session
/// owns one `CPaceConfirmed`, so the one-seal limit holds per session however often `confirm` is called.
final class CPaceResponderSession: @unchecked Sendable {
    let yb: Data
    private let isk: Data
    private let sid: Data
    private let ya: Data
    private let peerAd: Data
    private let confirmed: CPaceConfirmed

    init(yb: Data, isk: Data, tb: Data, sid: Data, ya: Data, peerAd: Data) {
        self.yb = yb
        self.isk = isk
        self.sid = sid
        self.ya = ya
        self.peerAd = peerAd
        confirmed = CPaceConfirmed(isk: isk, tb: tb)
    }

    /// Tb and the seal, handed out only for the right Ta (the same instance every time); nil for a wrong Ta.
    func confirm(_ ta: Data) -> CPaceConfirmed? {
        guard CPace.tagsEqual(ta, CPace.confirmationTag(sid: sid, isk: isk, y: ya, ad: peerAd)) else { return nil }
        return confirmed
    }
}

enum CPaceSealError: Error, Equatable {
    /// kSeal is a fixed-nonce key: it may seal only one message.
    case alreadySealed
}

/// B's side after Ta checked. One kSeal seals exactly one message; the flag is guarded by a lock.
final class CPaceConfirmed: @unchecked Sendable {
    /// Tb proves the responder knew the code too.
    let tb: Data
    private let isk: Data
    private let lock = NSLock()
    private var sealed = false

    init(isk: Data, tb: Data) {
        self.isk = isk
        self.tb = tb
    }

    func seal(_ plaintext: Data) throws -> Data {
        lock.lock()
        let already = sealed
        sealed = true
        lock.unlock()
        if already { throw CPaceSealError.alreadySealed }
        return try CPace.sealBox(isk: isk, plaintext: plaintext)
    }
}

/// Nil when Ya is invalid (abort).
func cpaceRespond(
    prs: Data,
    sid: Data,
    ya: Data,
    ci: Data = CPace.ci,
    ad: Data = Data(),
    peerAd: Data = Data(),
    scalar: Data? = nil
) -> CPaceResponderSession? {
    guard ya.count == 32, !sid.isEmpty else { return nil }
    let scalar = scalar ?? CPace.randomBytes(32)
    guard let yb = CPace.x25519(scalar: scalar, u: CPace.calculateGenerator(prs: prs, ci: ci, sid: sid)),
          let k = CPace.x25519(scalar: scalar, u: ya)
    else { return nil }
    let isk = CPace.deriveIsk(sid: sid, k: k, ya: ya, ada: peerAd, yb: yb, adb: ad)
    return CPaceResponderSession(
        yb: yb,
        isk: isk,
        tb: CPace.confirmationTag(sid: sid, isk: isk, y: yb, ad: ad),
        sid: sid,
        ya: ya,
        peerAd: peerAd
    )
}
