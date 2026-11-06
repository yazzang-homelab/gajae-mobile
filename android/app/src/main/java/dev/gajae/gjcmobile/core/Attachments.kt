package dev.gajae.gjcmobile.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID

object AttachmentLimits {
    /** Inline image ceiling after downscaling. */
    const val MAX_IMAGE_BYTES = 5 * 1024 * 1024
    /** Bridge-side upload ceiling (bridge/src/uploads.ts MAX_UPLOAD_BYTES). */
    const val MAX_FILE_BYTES = 25 * 1024 * 1024
    /** Longest image edge sent to the model. */
    const val MAX_IMAGE_EDGE = 2048
    /**
     * Photos sent inline in one prompt, all together, at most. gjc's ACP refuses a prompt whose SDK frame passes
     * 256 KiB (`MAX_PROMPT_FRAME_BYTES`, gjc 0.19.3) and photos travel there as base64 (4/3 their size): 180 KB of
     * JPEG is 234 KiB on the wire, leaving room for the text. Measured 2026-11-06 with claude-opus-5-5, gpt-5.6-sol
     * and claude-haiku-5-5: a phone screenshot or a menu photo re-encoded into 190 KB (or 47 KB, one of four) read as
     * well as the 2048px original; dense small print, such as a bus timetable shot from a step away, did not.
     */
    const val MAX_INLINE_IMAGE_BYTES = 180_000
    /** The bridge's refusal threshold for a prompt's blocks as JSON (bridge/src/hub.ts `PROMPT_BYTES_LIMIT`). */
    const val PROMPT_BYTES_LIMIT = 256 * 1024 - 1024
    /** Below this per photo the text has left too little room: re-encoding would only produce a blur. */
    internal const val MIN_INLINE_IMAGE_BYTES = 10_000

    /**
     * What the photos of one message may take together next to its text: [MAX_INLINE_IMAGE_BYTES], less what a long
     * text takes of [PROMPT_BYTES_LIMIT]. `null` when the text leaves too little room for [images] photos.
     */
    fun inlineImageBudget(text: String, images: Int, files: Int): Int? {
        // JSON of the blocks: the text escaped, ~60 bytes of block and array per photo, a stored path per file
        // (percent-encoded, so a Korean file name takes three times its length).
        val room = PROMPT_BYTES_LIMIT - jsonStringBytes(text) - 64 - images * 64 - files * 2048
        val budget = minOf(MAX_INLINE_IMAGE_BYTES, room / 4 * 3)
        return if (budget >= images * MIN_INLINE_IMAGE_BYTES) budget else null
    }

    /** Why [inlineImageBudget] gave no room: the photos alone are too many, or the text crowds them out. */
    fun noRoomError(images: Int, files: Int): Exception =
        if (inlineImageBudget("", images, files) == null) TooManyPhotos() else TextCrowdsOutPhotos()

    /** The UTF-8 length of [text] as a JSON string body, the way the bridge measures it. */
    internal fun jsonStringBytes(text: String): Int {
        var bytes = 0
        var index = 0
        while (index < text.length) {
            val code = text.codePointAt(index)
            bytes += when {
                code == 0x22 || code == 0x5C || code == 0x08 || code == 0x09 || code == 0x0A || code == 0x0C || code == 0x0D -> 2
                code < 0x20 -> 6
                code < 0x80 -> 1
                code < 0x800 -> 2
                code < 0x10000 -> 3
                else -> 4
            }
            index += Character.charCount(code)
        }
        return bytes
    }

    /**
     * The byte size each inline photo has to be re-encoded to so that together they fit [budget], in the order
     * given; `null` keeps that photo as it is. Photos under an even share keep their size and leave the rest of it
     * to the larger ones, which share what is left evenly.
     */
    fun inlineImageTargets(sizes: List<Int>, budget: Int): List<Int?> {
        if (sizes.sum() <= budget) return sizes.map { null }
        val targets = MutableList<Int?>(sizes.size) { null }
        var remaining = budget
        var left = sizes.size
        for (index in sizes.indices.sortedBy { sizes[it] }) {
            val share = remaining / left
            if (sizes[index] > share) {
                targets[index] = share
                remaining -= share
            } else {
                remaining -= sizes[index]
            }
            left -= 1
        }
        return targets
    }
}

class AttachmentTooLarge(name: String, limit: Int) : Exception("$name: ${limit / 1024 / 1024}MB를 넘어 보낼 수 없습니다.")

class InlineImagesTooLarge(val bytes: Int, val limit: Int) :
    Exception("사진이 모두 합쳐 ${bytes / 1000}KB라 한 번에 보낼 수 있는 ${limit / 1000}KB를 넘습니다. 사진 수를 줄이세요.")

/** The text leaves too little of gjc's prompt limit for the photos sent with it. */
class TextCrowdsOutPhotos : Exception("글이 길어 사진을 함께 보낼 수 없습니다. 글을 줄이거나 사진을 따로 보내세요.")

/** More photos than fit one prompt at a readable size, whatever the text. */
class TooManyPhotos : Exception("사진이 많아 한 번에 보낼 수 없습니다. 사진 수를 줄이세요.")

/** A photo that could not be decoded, or not re-encoded small enough even at the smallest edge. */
class PhotoCannotShrink(name: String) : Exception("$name: 한 번에 보낼 수 있는 크기로 줄이지 못했습니다. 사진 수를 줄이세요.")

/** A file the user picked in the composer, before it is sent. Images are already downscaled by the app. */
class PendingAttachment(
    val name: String,
    val data: ByteArray,
    val mimeType: String,
    val isImage: Boolean,
    val id: String = UUID.randomUUID().toString(),
)

/** Uploads a file in bridge-sized chunks with an end-to-end SHA-256 check; returns a `resource_link` block. */
suspend fun BridgeClient.upload(data: ByteArray, name: String, mimeType: String, sessionId: String, progress: (Double) -> Unit = {}): JsonElement {
    if (data.size > AttachmentLimits.MAX_FILE_BYTES) throw AttachmentTooLarge(name, AttachmentLimits.MAX_FILE_BYTES)
    val sha = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
    val ticket = request("upload.begin", buildJsonObject {
        put("sessionId", sessionId)
        put("name", name)
        put("size", data.size)
        put("mimeType", mimeType)
        put("sha256", sha)
    })
    val uploadId = ticket["uploadId"].str ?: throw BridgeException.ProtocolViolation("upload ticket")
    val chunkBytes = ticket["chunkBytes"].int?.takeIf { it > 0 } ?: throw BridgeException.ProtocolViolation("upload ticket")
    var offset = 0
    while (offset < data.size) {
        val end = minOf(offset + chunkBytes, data.size)
        request("upload.chunk", buildJsonObject {
            put("uploadId", uploadId)
            put("offset", offset)
            put("data", Base64.getEncoder().encodeToString(data.copyOfRange(offset, end)))
        })
        offset = end
        progress(offset.toDouble() / data.size)
    }
    val stored = request("upload.commit", buildJsonObject { put("uploadId", uploadId) })
    return buildJsonObject {
        put("type", "resource_link")
        put("uri", stored["uri"].str ?: "")
        put("name", stored["name"].str ?: name)
        put("mimeType", stored["mimeType"].str ?: mimeType)
        put("size", stored["size"].int ?: data.size)
    }
}

/** Composer text + attachments as ACP prompt blocks, uploading non-image files first. */
suspend fun BridgeClient.promptBlocks(text: String, attachments: List<PendingAttachment>, sessionId: String, progress: (Double) -> Unit = {}): List<JsonElement> {
    val images = attachments.filter { it.isImage }
    if (images.isNotEmpty()) {
        val budget = AttachmentLimits.inlineImageBudget(text.trim(), images.size, attachments.size - images.size) ?: throw AttachmentLimits.noRoomError(images.size, attachments.size - images.size)
        val inlineBytes = images.sumOf { it.data.size }
        if (inlineBytes > budget) throw InlineImagesTooLarge(inlineBytes, budget)
    }
    val total = maxOf(1, attachments.sumOf { it.data.size })
    var done = 0
    val blocks = mutableListOf<JsonElement>()
    val trimmed = text.trim()
    if (trimmed.isNotEmpty()) blocks += BridgeClient.textBlock(trimmed)
    for (attachment in attachments) {
        if (attachment.isImage) {
            if (attachment.data.size > AttachmentLimits.MAX_IMAGE_BYTES) throw AttachmentTooLarge(attachment.name, AttachmentLimits.MAX_IMAGE_BYTES)
            blocks += BridgeClient.imageBlock(Base64.getEncoder().encodeToString(attachment.data), attachment.mimeType)
        } else {
            val before = done
            blocks += upload(attachment.data, attachment.name, attachment.mimeType, sessionId) { f ->
                progress((before + f * attachment.data.size) / total)
            }
        }
        done += attachment.data.size
        progress(done.toDouble() / total)
    }
    return blocks
}
