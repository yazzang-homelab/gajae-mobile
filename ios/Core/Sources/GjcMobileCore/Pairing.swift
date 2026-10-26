import Crypto
import Foundation

/// QR payload from `gjcm-bridge pair`: `gjcm://pair?o=<base64url(JSON)>`.
public struct PairingOffer: Codable, Equatable, Sendable {
    public let v: Int
    public let hostId: String
    public let name: String
    public let hostKey: String
    public let endpoints: [String]
    public let pairingId: String
    public let secret: String
    public let exp: String

    public enum ParseError: Error, Equatable {
        case notGjcmURL
        case missingOffer
        case unsupportedVersion
        case malformed
        case expired
    }

    public static func parse(_ text: String, now: Date = Date()) throws -> PairingOffer {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme == "gjcm" else {
            throw ParseError.notGjcmURL
        }
        guard let encoded = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "o" })?.value,
            let data = Data(base64URL: encoded)
        else { throw ParseError.missingOffer }
        guard let offer = try? JSONDecoder().decode(PairingOffer.self, from: data) else { throw ParseError.malformed }
        guard offer.v == 1 else { throw ParseError.unsupportedVersion }
        guard let hostKey = Data(base64URL: offer.hostKey), hostKey.count == 32,
              let secret = Data(base64URL: offer.secret), secret.count == 32,
              !offer.endpoints.isEmpty
        else { throw ParseError.malformed }
        if let expiry = ISO8601DateFormatter.withFractions.date(from: offer.exp) ?? ISO8601DateFormatter().date(from: offer.exp),
           expiry < now {
            throw ParseError.expired
        }
        return offer
    }
}

/// A host this phone has paired with. Persisted in the Keychain by the app.
public struct PairedHost: Codable, Hashable, Identifiable, Sendable {
    public var id: String { hostId }
    public let hostId: String
    public var name: String
    public let hostKey: String
    public var endpoints: [String]
    public var lastEndpoint: String?
    public let pairedAt: Date

    public init(hostId: String, name: String, hostKey: String, endpoints: [String], lastEndpoint: String? = nil, pairedAt: Date = Date()) {
        self.hostId = hostId
        self.name = name
        self.hostKey = hostKey
        self.endpoints = endpoints
        self.lastEndpoint = lastEndpoint
        self.pairedAt = pairedAt
    }

    public init(offer: PairingOffer) {
        self.init(hostId: offer.hostId, name: offer.name, hostKey: offer.hostKey, endpoints: offer.endpoints)
    }

    /// Endpoint that last worked first, then the advertised order.
    public var endpointsToTry: [String] {
        guard let lastEndpoint else { return endpoints }
        return [lastEndpoint] + endpoints.filter { $0 != lastEndpoint }
    }
}

/// The phone's static X25519 identity (one per install, shared across hosts).
public struct DeviceIdentity: Sendable {
    public let privateKey: Curve25519.KeyAgreement.PrivateKey

    public init(privateKey: Curve25519.KeyAgreement.PrivateKey = .init()) {
        self.privateKey = privateKey
    }

    public init(rawPrivateKey: Data) throws {
        privateKey = try .init(rawRepresentation: rawPrivateKey)
    }

    public var rawPrivateKey: Data { privateKey.rawRepresentation }
    public var publicKey: Data { privateKey.publicKey.rawRepresentation }
}

extension ISO8601DateFormatter {
    static let withFractions: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
