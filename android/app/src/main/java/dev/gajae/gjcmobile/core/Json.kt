package dev.gajae.gjcmobile.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/** Loose accessors over kotlinx JSON trees, mirroring the Swift `JSONValue` subscripts. */
val GjcJson = Json { ignoreUnknownKeys = true }
private val PrettyJson = Json { prettyPrint = true }

operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)?.takeUnless { it is JsonNull }

val JsonElement?.str: String?
    get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

val JsonElement?.int: Int?
    get() = (this as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull?.let { d ->
        if (d == Math.floor(d) && !d.isInfinite()) d.toInt() else null
    }

val JsonElement?.double: Double?
    get() = (this as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull

val JsonElement?.bool: Boolean?
    get() = (this as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

val JsonElement?.array: List<JsonElement>?
    get() = this as? JsonArray

/** Strings as-is, everything else pretty-printed JSON. */
val JsonElement.prettyText: String
    get() = str ?: PrettyJson.encodeToString(JsonElement.serializer(), this)

fun parseJson(text: String): JsonElement = GjcJson.parseToJsonElement(text)

fun JsonElement.encode(): String = GjcJson.encodeToString(JsonElement.serializer(), this)
