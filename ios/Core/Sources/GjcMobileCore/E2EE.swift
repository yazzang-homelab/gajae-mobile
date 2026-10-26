import Crypto
import Foundation

/// gjcm-e2ee-v1, phone side. Mirrors bridge/src/crypto.ts byte for byte
/// (verified by the shared vector in fixtures/e2ee-vector.json).
public enum E2EE {
    public static let label = "gjcm-e2ee-v1"
    static let aad = Data("gjcm1".utf8)
    static let counterBytes = 8
    static let tagBytes = 16

    public struct SessionKeys: Equatable, Sendable {
        public let c2s: Data
        public let s2c: Data
    }

    public struct Transcript: Sendable {
        public var deviceKey: Data
        public var hostKey: Data
        public var clientEph: Data
        public var serverEph: Data
        public var clientNonce: Data
        public var serverNonce: Data

        public init(deviceKey: Data, hostKey: Data, clientEph: Data, serverEph: Data, clientNonce: Data, serverNonce: Data) {
            self.deviceKey = deviceKey
            self.hostKey = hostKey
            self.clientEph = clientEph
            self.serverEph = serverEph
            self.clientNonce = clientNonce
            self.serverNonce = serverNonce
        }
    }

    public static func clientKeys(
        device: Curve25519.KeyAgreement.PrivateKey,
        clientEph: Curve25519.KeyAgreement.PrivateKey,
        transcript t: Transcript
    ) throws -> SessionKeys {
        let serverEph = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: t.serverEph)
        let host = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: t.hostKey)
        var ikm = Data()
        ikm.append(try clientEph.sharedSecretFromKeyAgreement(with: serverEph).rawData) // ee
        ikm.append(try clientEph.sharedSecretFromKeyAgreement(with: host).rawData) // es
        ikm.append(try device.sharedSecretFromKeyAgreement(with: host).rawData) // ss
        return deriveSessionKeys(ikm: ikm, transcript: t)
    }

    static func deriveSessionKeys(ikm: Data, transcript t: Transcript) -> SessionKeys {
        var info = Data(label.utf8)
        info.append(t.deviceKey)
        info.append(t.hostKey)
        info.append(t.clientEph)
        info.append(t.serverEph)
        let okm = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm),
            salt: t.clientNonce + t.serverNonce,
            info: info,
            outputByteCount: 64
        ).rawData
        return SessionKeys(c2s: okm.prefix(32), s2c: okm.suffix(32))
    }

    public static func pairingProof(secret: Data, deviceKey: Data, clientEph: Data) -> Data {
        var message = Data("gjcm-pair-v1".utf8)
        message.append(deviceKey)
        message.append(clientEph)
        return Data(HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: secret)))
    }
}

public enum E2EEError: Error, Equatable {
    case frameTooShort
    case replayedFrame
    case authenticationFailed
}

/// Directional AES-256-GCM framing: 8-byte BE counter ‖ ciphertext ‖ tag, nonce = 0x00000000 ‖ counter.
public struct FrameCipher: Sendable {
    private let sendKey: SymmetricKey
    private let recvKey: SymmetricKey
    private var sendCounter: UInt64 = 0
    private var recvNext: UInt64 = 0

    public init(sendKey: Data, recvKey: Data) {
        self.sendKey = SymmetricKey(data: sendKey)
        self.recvKey = SymmetricKey(data: recvKey)
    }

    public mutating func seal(_ plaintext: Data) throws -> Data {
        let header = Self.header(sendCounter)
        sendCounter += 1
        let box = try AES.GCM.seal(plaintext, using: sendKey, nonce: try Self.nonce(header), authenticating: E2EE.aad)
        return header + box.ciphertext + box.tag
    }

    public mutating func open(_ frame: Data) throws -> Data {
        let bytes = Data(frame)
        guard bytes.count >= E2EE.counterBytes + E2EE.tagBytes else { throw E2EEError.frameTooShort }
        let header = bytes.prefix(E2EE.counterBytes)
        let counter = header.reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        guard counter >= recvNext else { throw E2EEError.replayedFrame }
        let box = try AES.GCM.SealedBox(
            nonce: Self.nonce(header),
            ciphertext: bytes.dropFirst(E2EE.counterBytes).dropLast(E2EE.tagBytes),
            tag: bytes.suffix(E2EE.tagBytes)
        )
        do {
            let plaintext = try AES.GCM.open(box, using: recvKey, authenticating: E2EE.aad)
            recvNext = counter + 1
            return plaintext
        } catch {
            throw E2EEError.authenticationFailed
        }
    }

    static func header(_ counter: UInt64) -> Data {
        withUnsafeBytes(of: counter.bigEndian) { Data($0) }
    }

    static func nonce(_ header: Data) throws -> AES.GCM.Nonce {
        try AES.GCM.Nonce(data: Data(count: 4) + header)
    }
}

extension SharedSecret {
    var rawData: Data { withUnsafeBytes { Data($0) } }
}

extension SymmetricKey {
    var rawData: Data { withUnsafeBytes { Data($0) } }
}

public extension Data {
    init?(base64URL text: String) {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }

    var base64URL: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    var sha256Hex: String {
        SHA256.hash(data: self).map { String(format: "%02x", $0) }.joined()
    }
}
