import Foundation

/// A prompt this phone sent, kept until its turn ends. The bridge names each phone turn (`session.prompt` reply
/// `turnId`) and repeats the name on that turn's `x_gjcm_turn_end`, so only the phone that sent a prompt takes it
/// back when its turn ends `undelivered` (stopped before gjc ran it: the message never reached the model).
/// Bridges without `turnId` never end a turn `undelivered`; nothing is kept for them.
public struct SentPrompt<Message: Equatable>: Equatable {
    public enum Settled: Equatable {
        /// Its turn end has not arrived yet.
        case waiting
        /// Its turn ended and the model got the message, or its end is no longer known: nothing to give back.
        case done
        /// Its turn ended before gjc ran it: put the message back in the composer.
        case giveBack
    }

    public let message: Message
    public let turnId: String

    public init(message: Message, turnId: String) {
        self.message = message
        self.turnId = turnId
    }

    /// Where the prompt stands after `updates` arrived: live ones (`turnOver` false), or an open snapshot's with
    /// `turnOver` set when no turn runs. A turn that is over without its end among them ended out of the bridge's
    /// buffer (or with a bridge that restarted), so it is not known to be undelivered.
    public func settle(after updates: [SequencedUpdate], turnOver: Bool) -> Settled {
        for entry in updates
        where entry.update["sessionUpdate"]?.string == "x_gjcm_turn_end" && entry.update["turnId"]?.string == turnId {
            return entry.update["undelivered"]?.bool == true ? .giveBack : .done
        }
        return turnOver ? .done : .waiting
    }
}
