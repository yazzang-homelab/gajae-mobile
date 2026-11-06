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
     * Photos sent inline in one prompt, all together. gjc's ACP refuses a prompt whose SDK frame passes 256 KiB
     * (`MAX_PROMPT_FRAME_BYTES`, gjc 0.19.3) and photos travel there as base64 (4/3 their size): 180 KB of JPEG is
     * 234 KiB on the wire, leaving room for the text. Measured 2026-11-06 with claude-opus-5-5, gpt-5.6-sol and
     * claude-haiku-5-5: a phone screenshot or a menu photo re-encoded into 190 KB (or 47 KB, one of four) read as
     * well as the 2048px original; dense small print, such as a bus timetable shot from a step away, did not.
     */
    const val INLINE_IMAGE_BUDGET = 180_000

    /**
     * The byte size each inline photo has to be re-encoded to so that together they fit [budget], in the order
     * given; `null` keeps that photo as it is. Photos under an even share keep their size and leave the rest of it
     * to the larger ones, which share what is left evenly.
     */
    fun inlineImageTargets(sizes: List<Int>, budget: Int = INLINE_IMAGE_BUDGET): List<Int?> {
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
    val inlineBytes = attachments.filter { it.isImage }.sumOf { it.data.size }
    if (inlineBytes > AttachmentLimits.INLINE_IMAGE_BUDGET) throw InlineImagesTooLarge(inlineBytes, AttachmentLimits.INLINE_IMAGE_BUDGET)
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
