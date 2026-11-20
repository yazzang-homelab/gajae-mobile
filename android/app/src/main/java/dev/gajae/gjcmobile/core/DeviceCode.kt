package dev.gajae.gjcmobile.core

import java.security.MessageDigest

/**
 * gjcm-code-v1 device code: the bridge address and a 20-bit secret in 9–14 characters the user types
 * (bridge/src/device-code.ts is the canonical implementation; fixtures/cpace-vector.json `codes` pins both).
 *
 *   bits (MSB first) = type(4) ‖ addr(n) ‖ [port(16)] ‖ secret(20) ‖ check(k ≥ 4, up to the character boundary)
 *   type: high bit = explicit port (absent means 7787); low 3 bits = address range
 *     001 Tailscale 100.64.0.0/10 (22)  010 10.0.0.0/8 (24)  011 172.16.0.0/12 (20)  100 192.168.0.0/16 (16)
 *     000, 101–111 reserved → code_unsupported
 *   check = top k bits of SHA-256("gjcm-code-v1" ‖ m ‖ first m bits packed MSB first, zero padded)
 *
 * The whole normalized string (check included) is the CPace password; the check only catches typos before dialing.
 */
enum class CodeRange { TAILSCALE, TEN, ONE_SEVEN_TWO, ONE_NINE_TWO }

data class CodeAddress(val ip: String, val port: Int, val range: CodeRange)

sealed class NormalizeResult {
    data class Ok(val code: String) : NormalizeResult()

    /** [position] is 1-based among the characters kept so far (spaces and hyphens do not count). */
    data class Invalid(val position: Int, val char: String) : NormalizeResult()
}

sealed class DecodeResult {
    data class Ok(val code: String, val address: CodeAddress, val endpoint: String) : DecodeResult()

    /** Wrong length, wrong check, port 0, or a character outside the alphabet ([position] set for the last). */
    data class Format(val position: Int? = null) : DecodeResult()

    /** A reserved type: a newer bridge than this app knows. */
    object Unsupported : DecodeResult() {
        override fun toString() = "Unsupported"
    }
}

object DeviceCode {
    const val ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    const val DEFAULT_PORT = 7787
    const val SECRET_BITS = 20
    private val CHECK_LABEL = "gjcm-code-v1".toByteArray(Charsets.US_ASCII)
    private const val EXPLICIT_PORT = 0b1000

    private class RangeSpec(val type: Int, val range: CodeRange, val base: Long, val prefixBits: Int)

    private val RANGES = listOf(
        RangeSpec(0b001, CodeRange.TAILSCALE, ipv4(100, 64, 0, 0), 10),
        RangeSpec(0b010, CodeRange.TEN, ipv4(10, 0, 0, 0), 8),
        RangeSpec(0b011, CodeRange.ONE_SEVEN_TWO, ipv4(172, 16, 0, 0), 12),
        RangeSpec(0b100, CodeRange.ONE_NINE_TWO, ipv4(192, 168, 0, 0), 16),
    )

    private fun ipv4(a: Int, b: Int, c: Int, d: Int): Long =
        (a.toLong() shl 24) or (b.toLong() shl 16) or (c.toLong() shl 8) or d.toLong()

    private fun ipText(n: Long): String = "${(n shr 24) and 0xff}.${(n shr 16) and 0xff}.${(n shr 8) and 0xff}.${n and 0xff}"

    private fun readBits(bits: List<Int>, from: Int, width: Int): Long {
        var v = 0L
        for (i in 0 until width) v = v * 2 + bits[from + i]
        return v
    }

    private fun packMsbFirst(bits: List<Int>): ByteArray {
        val out = ByteArray((bits.size + 7) / 8)
        bits.forEachIndexed { i, bit -> if (bit != 0) out[i shr 3] = (out[i shr 3].toInt() or (0x80 shr (i and 7))).toByte() }
        return out
    }

    private fun checkBits(payload: List<Int>, k: Int): List<Int> {
        val digest = MessageDigest.getInstance("SHA-256").run {
            update(CHECK_LABEL)
            update(byteArrayOf(payload.size.toByte()))
            update(packMsbFirst(payload))
            digest()
        }
        return List(k) { i -> (digest[i shr 3].toInt() shr (7 - (i and 7))) and 1 }
    }

    private fun payloadBits(spec: RangeSpec, explicitPort: Boolean): Int =
        4 + (32 - spec.prefixBits) + (if (explicitPort) 16 else 0) + SECRET_BITS

    /** Characters for m payload bits: room for at least 4 check bits. */
    private fun codeLength(m: Int): Int = (m + 4 + 4) / 5

    /**
     * What the bridge's normalizer drops: a hyphen and exactly the JS `\s` set. Anything else (U+200B, U+0085, ...) is a
     * character like any other and is rejected when outside the alphabet.
     */
    fun isSeparator(cp: Int): Boolean =
        cp == '-'.code || cp in 0x09..0x0D || cp == 0x20 || cp == 0xA0 || cp == 0x1680 || cp in 0x2000..0x200A ||
            cp == 0x2028 || cp == 0x2029 || cp == 0x202F || cp == 0x205F || cp == 0x3000 || cp == 0xFEFF

    /** Only ASCII a-z are uppercased: Unicode case mapping would turn ß into SS and ſ into S. */
    fun upperAscii(cp: Int): Int = if (cp in 'a'.code..'z'.code) cp - 32 else cp

    /** Uppercase ASCII letters, drop separators; any other character outside the alphabet (0 O 1 I ...) is rejected with its position. */
    fun normalize(input: String): NormalizeResult {
        val code = StringBuilder()
        var i = 0
        while (i < input.length) {
            val raw = input.codePointAt(i)
            i += Character.charCount(raw)
            if (isSeparator(raw)) continue
            val cp = upperAscii(raw)
            if (cp >= 0x80 || ALPHABET.indexOf(cp.toChar()) < 0) {
                return NormalizeResult.Invalid(code.length + 1, String(Character.toChars(cp)))
            }
            code.append(cp.toChar())
        }
        return NormalizeResult.Ok(code.toString())
    }

    /** Groups of four: K7M2-9QXD-HP. */
    fun format(code: String): String = code.chunked(4).joinToString("-")

    fun decode(input: String): DecodeResult {
        val normalized = normalize(input)
        if (normalized is NormalizeResult.Invalid) return DecodeResult.Format(normalized.position)
        val code = (normalized as NormalizeResult.Ok).code
        if (code.isEmpty()) return DecodeResult.Format()
        val bits = ArrayList<Int>(code.length * 5)
        for (ch in code) {
            val v = ALPHABET.indexOf(ch)
            for (i in 4 downTo 0) bits.add((v shr i) and 1)
        }
        val type = readBits(bits, 0, 4).toInt()
        val spec = RANGES.firstOrNull { it.type == (type and 0b111) } ?: return DecodeResult.Unsupported
        val explicitPort = (type and EXPLICIT_PORT) != 0
        val m = payloadBits(spec, explicitPort)
        if (code.length != codeLength(m)) return DecodeResult.Format()
        val expected = checkBits(bits.subList(0, m), code.length * 5 - m)
        if (expected.indices.any { expected[it] != bits[m + it] }) return DecodeResult.Format()
        val hostBits = 32 - spec.prefixBits
        val ip = ipText((spec.base + readBits(bits, 4, hostBits)) and 0xffffffffL)
        val port = if (explicitPort) readBits(bits, 4 + hostBits, 16).toInt() else DEFAULT_PORT
        // Port 0 cannot be dialled, and an explicit 7787 has a shorter canonical code: no bridge prints either.
        if (port == 0 || (explicitPort && port == DEFAULT_PORT)) return DecodeResult.Format()
        return DecodeResult.Ok(code, CodeAddress(ip, port, spec.range), "ws://$ip:$port/ws")
    }

    /** Builds a code (tests; the bridge's `pair` is the real producer). Throws when the address does not fit. */
    fun encode(ip: String, port: Int, secret: Int): String {
        val octets = ip.split('.').map { it.toIntOrNull() ?: throw IllegalArgumentException("not an IPv4 address: $ip") }
        require(octets.size == 4 && octets.all { it in 0..255 }) { "not an IPv4 address: $ip" }
        require(port in 1..65535) { "bad port: $port" }
        require(secret in 0 until (1 shl SECRET_BITS)) { "secret must be 20 bits" }
        val n = ipv4(octets[0], octets[1], octets[2], octets[3])
        val spec = RANGES.firstOrNull { (n shr (32 - it.prefixBits)) == (it.base shr (32 - it.prefixBits)) }
            ?: throw IllegalArgumentException("address outside the code ranges: $ip")
        val explicitPort = port != DEFAULT_PORT
        val bits = ArrayList<Int>()
        fun push(value: Long, width: Int) { for (i in width - 1 downTo 0) bits.add(((value shr i) and 1L).toInt()) }
        push(((if (explicitPort) EXPLICIT_PORT else 0) or spec.type).toLong(), 4)
        push(n - spec.base, 32 - spec.prefixBits)
        if (explicitPort) push(port.toLong(), 16)
        push(secret.toLong(), SECRET_BITS)
        val m = bits.size
        val chars = codeLength(m)
        bits.addAll(checkBits(bits.toList(), chars * 5 - m))
        return buildString { for (i in 0 until chars) append(ALPHABET[readBits(bits, i * 5, 5).toInt()]) }
    }
}

/**
 * The code entry field's text rules. The field's state is the raw characters (separators dropped, ASCII uppercased,
 * at most [MAX_CHARS], a bad character kept so the user can see and fix it); the hyphen after every four characters is
 * only drawn, through [displayText], [originalToTransformed] and [transformedToOriginal]. `L` is a valid character;
 * `0 O 1 I` are not.
 */
object CodeInputFormatter {
    /** The longest code: 4 + 22 + 16 + 20 payload bits plus check. */
    const val MAX_CHARS = 14

    private const val GROUP = 4

    data class Invalid(val position: Int, val char: String)

    /**
     * [chars] is the field state (see the class doc) and [invalid] its first bad character (1-based
     * [Invalid.position]). A character outside the BMP is kept in [chars] as U+FFFD so one char is one position; the
     * field stores only [chars], so the text it shows, and a [format] of it, name that character U+FFFD ([Invalid.char]
     * names the original only in a [format] of the raw input). [truncated] is true when valid-length input held more than
     * [MAX_CHARS] characters and the rest was dropped; [edit] rejects such input.
     */
    data class Result(val chars: String, val invalid: Invalid?, val truncated: Boolean)

    /**
     * The field state after an accepted edit: [chars] and the selection in it, in raw offsets. A reversed selection
     * ([selStart] > [selEnd]) stays reversed.
     */
    data class Edited(val chars: String, val selStart: Int, val selEnd: Int)

    fun format(input: String): Result {
        val kept = StringBuilder()
        var invalid: Invalid? = null
        var truncated = false
        var i = 0
        var count = 0
        while (i < input.length) {
            val raw = input.codePointAt(i)
            i += Character.charCount(raw)
            if (DeviceCode.isSeparator(raw)) continue
            if (count == MAX_CHARS) { truncated = true; break }
            count++
            val cp = DeviceCode.upperAscii(raw)
            if (invalid == null && (cp >= 0x80 || DeviceCode.ALPHABET.indexOf(cp.toChar()) < 0)) {
                invalid = Invalid(count, String(Character.toChars(cp)))
            }
            kept.append(if (cp > 0xFFFF) '\uFFFD' else cp.toChar())
        }
        return Result(kept.toString(), invalid, truncated)
    }

    /**
     * An edit of the field: [text] is what the field holds after the user's input and [selStart]..[selEnd] the
     * selection in it. Returns the normalised state with the selection moved to follow the characters it was beside
     * (a dropped separator or a shortened character no longer pushes the cursor), or null when the input would exceed
     * [MAX_CHARS], in which case the caller keeps the previous value instead of cutting the end off silently.
     */
    fun edit(text: String, selStart: Int, selEnd: Int): Edited? {
        val result = format(text)
        if (result.truncated) return null
        fun follow(offset: Int): Int {
            var o = offset.coerceIn(0, text.length)
            if (o in 1 until text.length && Character.isHighSurrogate(text[o - 1]) && Character.isLowSurrogate(text[o])) o++
            return format(text.substring(0, o)).chars.length
        }
        return Edited(result.chars, follow(selStart), follow(selEnd))
    }

    /** The line under the field: the first bad character, else a refused over-long input; null when there is neither. */
    fun message(invalid: Invalid?, tooLong: Boolean): String? = when {
        invalid != null -> "${invalid.position}번째 글자 '${invalid.char}'는 코드에 쓰지 않습니다. 0·O·1·I는 코드에 없습니다."
        tooLong -> "코드는 최대 ${MAX_CHARS}자입니다. 호스트에 나온 코드만 입력하세요."
        else -> null
    }

    /** [chars] with a hyphen after every four characters, none trailing: K7M2-9QXD-HP. */
    fun displayText(chars: String): String = DeviceCode.format(chars)

    /** Display offset of the cursor at [offset] among the [chars] characters (0..n): one hyphen per full group before it. */
    fun originalToTransformed(offset: Int): Int {
        require(offset >= 0) { "offset must not be negative" }
        return if (offset == 0) 0 else offset + (offset - 1) / GROUP
    }

    /** Character offset (0..[length]) of the display offset [offset]; a cursor next to a hyphen maps to the group boundary. */
    fun transformedToOriginal(offset: Int, length: Int): Int {
        require(offset >= 0) { "offset must not be negative" }
        return (offset - offset / (GROUP + 1)).coerceIn(0, length)
    }
}
