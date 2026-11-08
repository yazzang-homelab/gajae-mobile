package dev.gajae.gjcmobile.core

/**
 * A prompt this phone sent, kept until its turn ends. The bridge names each phone turn (`session.prompt` reply
 * `turnId`) and repeats the name on that turn's `x_gjcm_turn_end`, so only the phone that sent a prompt takes it
 * back when its turn ends `undelivered` (stopped before gjc ran it: the message never reached the model).
 * Bridges without `turnId` never end a turn `undelivered`; nothing is kept for them.
 */
data class SentPrompt<M>(val message: M, val turnId: String) {
    enum class Settled {
        /** Its turn end has not arrived yet. */
        WAITING,

        /** Its turn ended and the model got the message, or its end is no longer known: nothing to give back. */
        DONE,

        /** Its turn ended before gjc ran it: put the message back in the composer. */
        GIVE_BACK,
    }

    /**
     * Where the prompt stands after [updates] arrived: live ones ([turnOver] false), or an open snapshot's with
     * [turnOver] set when no turn runs. A turn that is over without its end among them ended out of the bridge's
     * buffer (or with a bridge that restarted), so it is not known to be undelivered.
     */
    fun settle(updates: List<SequencedUpdate>, turnOver: Boolean): Settled {
        val end = updates.firstOrNull { it.update["sessionUpdate"].str == "x_gjcm_turn_end" && it.update["turnId"].str == turnId }
        return when {
            end != null -> if (end.update["undelivered"].bool == true) Settled.GIVE_BACK else Settled.DONE
            turnOver -> Settled.DONE
            else -> Settled.WAITING
        }
    }
}
