import Foundation

/// What a failed session-list request means for the connection. Only a transport failure ends it: a cancelled
/// request and an error reply from a live bridge leave it up.
public enum SessionListFailure: Equatable, Sendable {
    /// The calling task was cancelled; nothing failed.
    case cancelled
    /// The socket dropped; the event stream reports it.
    case disconnected
    /// The bridge answered the request with an error: the connection is fine, only the list failed.
    case remote
    /// Any other transport or protocol failure: the connection is no longer usable.
    case transport

    public static func classify(_ error: Error) -> SessionListFailure {
        if error is CancellationError { return .cancelled }
        switch error as? BridgeError {
        case .disconnected?: return .disconnected
        case .remote?: return .remote
        default: return .transport
        }
    }
}
