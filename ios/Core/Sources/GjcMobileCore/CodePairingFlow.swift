import Foundation

/// An offer a device code handed over. The code is spent at that point, so the offer is kept: a hello that fails can
/// be retried, and a key-change confirmation can be answered, without asking the host again.
public struct HeldCodeOffer: Equatable, Sendable {
    public let code: String
    public let offer: PairingOffer
    /// The address the code was answered on.
    public let endpoint: String
    /// The user already approved replacing a known host's key, so a retry does not ask again.
    public fileprivate(set) var keyChangeApproved = false

    /// The order the pairing hello dials: the address the code was answered on first, then the offer's endpoints in
    /// their order, each address once.
    public var helloEndpoints: [String] { endpointsDeduplicated([endpoint] + offer.endpoints) }
}

/// The decisions of a device-code pairing around the held offer, without any I/O (the app model does the exchange
/// and the hello). The offer is replaced by the next verified offer and dropped only when the hello succeeds, the
/// host says `pairing_invalid`, the user cancels, or a different code is typed. Any other failure keeps it.
public struct CodeOfferKeeper: Sendable {
    public private(set) var held: HeldCodeOffer?

    public init() {}

    /// A code was submitted. True when the host has to be asked (a different code than the kept offer's, which is
    /// dropped); false when the kept offer is retried. `approvingKeyChange` is the user's answer to the key-change
    /// confirmation of the kept offer, so it only ever applies to that offer: with another code it is ignored, and the
    /// new offer is confirmed on its own.
    public mutating func submit(code: String, approvingKeyChange: Bool = false) -> Bool {
        guard held?.code == code else {
            held = nil
            return true
        }
        if approvingKeyChange { held?.keyChangeApproved = true }
        return false
    }

    /// A verified offer came back for `code`.
    public mutating func keep(code: String, offer: PairingOffer, endpoint: String) {
        held = HeldCodeOffer(code: code, offer: offer, endpoint: endpoint)
    }

    /// The kept offer would replace a known host's key and the user has not approved that: no hello may be sent yet.
    public func needsKeyChangeApproval(among hosts: [PairedHost]) -> Bool {
        guard let held else { return false }
        return !held.offer.isAllowed(among: hosts, keyChangeApproved: held.keyChangeApproved)
    }

    public mutating func helloSucceeded() {
        held = nil
    }

    /// Classifies a failed hello: `pairing_invalid` means the code lapsed, so the offer is dropped; everything else
    /// keeps it for a retry.
    public mutating func helloFailed(_ error: Error) -> CodePairingError {
        if case let BridgeError.rejected(code, _) = error, code == "pairing_invalid" {
            held = nil
            return .pairingExpired
        }
        return .helloFailure(error)
    }

    /// The user cancelled: nothing was saved and the offer is dropped.
    public mutating func discard() {
        held = nil
    }
}
