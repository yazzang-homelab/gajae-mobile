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
}

class AttachmentTooLarge(name: String, limit: Int) : Exception("$name: ${limit / 1024 / 1024}MB를 넘어 보낼 수 없습니다.")

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
