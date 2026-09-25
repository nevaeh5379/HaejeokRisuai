package io.github.nevaeh5379.androidhaejeokrisuai.importing

import android.util.Base64
import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterImportPayload
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets

object CharacterCardImporter {
    private const val MAX_METADATA_BYTES = 5 * 1024 * 1024
    private val PNG_SIGNATURE = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

    fun parse(fileName: String, bytes: ByteArray): CharacterImportPayload {
        val isPng = bytes.size >= PNG_SIGNATURE.size && PNG_SIGNATURE.indices.all { bytes[it] == PNG_SIGNATURE[it] }
        val jsonBytes = if (isPng) {
            val encoded = extractCardMetadata(bytes)
                ?: throw IllegalArgumentException("PNG does not contain a chara or ccv3 character-card chunk")
            val decoded = Base64.decode(encoded, Base64.DEFAULT)
            require(decoded.size <= MAX_METADATA_BYTES) { "Character card metadata exceeds 5 MiB" }
            decoded
        } else {
            require(fileName.lowercase().endsWith(".json")) { "Only PNG and JSON character cards are supported yet" }
            require(bytes.size <= MAX_METADATA_BYTES) { "Character card JSON exceeds 5 MiB" }
            bytes
        }
        val root = JSONObject(String(jsonBytes, StandardCharsets.UTF_8))
        return fromJson(root, imageBytes = bytes.takeIf { isPng })
    }

    internal fun extractCardMetadata(png: ByteArray): String? {
        require(png.size >= 8 && PNG_SIGNATURE.indices.all { png[it] == PNG_SIGNATURE[it] }) { "Invalid PNG signature" }
        var offset = 8
        var chara: String? = null
        var ccv3: String? = null
        while (offset + 12 <= png.size) {
            val length = readUInt32(png, offset)
            require(length >= 0 && length <= MAX_METADATA_BYTES) { "PNG metadata chunk is too large" }
            val dataStart = offset + 8
            val dataEnd = dataStart + length
            val chunkEnd = dataEnd + 4
            require(dataEnd >= dataStart && chunkEnd <= png.size) { "Malformed PNG chunk length" }
            val type = String(png, offset + 4, 4, StandardCharsets.US_ASCII)
            if (type == "tEXt") {
                var separator = dataStart
                while (separator < dataEnd && png[separator].toInt() != 0) separator++
                if (separator < dataEnd) {
                    val key = String(png, dataStart, separator - dataStart, StandardCharsets.ISO_8859_1)
                    if (key == "chara" || key == "ccv3") {
                        val value = String(png, separator + 1, dataEnd - separator - 1, StandardCharsets.ISO_8859_1)
                        if (value.length <= MAX_METADATA_BYTES) {
                            if (key == "ccv3") ccv3 = value else chara = value
                        }
                    }
                }
            }
            if (type == "IEND") break
            offset = chunkEnd
        }
        return ccv3 ?: chara
    }

    private fun fromJson(root: JSONObject, imageBytes: ByteArray?): CharacterImportPayload {
        val spec = root.optString("spec")
        val data = if (spec == "chara_card_v2" || spec == "chara_card_v3") {
            root.optJSONObject("data") ?: throw IllegalArgumentException("Character card has no data object")
        } else root
        val name = firstNonBlank(data, "name", "char_name") ?: "unknown name"
        val firstMessage = firstNonBlank(data, "first_mes", "char_greeting") ?: "unknown first message"
        val description = firstNonBlank(data, "description", "char_persona").orEmpty()
        val extensions = data.optJSONObject("extensions") ?: JSONObject()
        val risu = extensions.optJSONObject("risuai") ?: JSONObject()
        val storageData = linkedMapOf<String, Any?>(
            "type" to "character",
            "name" to name,
            "firstMessage" to firstMessage,
            "desc" to description,
            "notes" to "",
            "chatPage" to 0,
            "viewScreen" to risu.optString("viewScreen", "none"),
            "bias" to jsonValue(risu.optJSONArray("bias") ?: JSONArray()),
            "emotionImages" to emptyList<Any?>(),
            "globalLore" to convertCharacterBook(data.optJSONObject("character_book")),
            "sdData" to jsonValue(risu.optJSONArray("sdData") ?: JSONArray()),
            "utilityBot" to risu.optBoolean("utilityBot", false),
            "customscript" to jsonValue(risu.optJSONArray("customScripts") ?: JSONArray()),
            "triggerscript" to jsonValue(risu.optJSONArray("triggerscript") ?: JSONArray()),
            "exampleMessage" to data.optString("mes_example", ""),
            "creatorNotes" to data.optString("creator_notes", ""),
            "systemPrompt" to data.optString("system_prompt", ""),
            "postHistoryInstructions" to "",
            "alternateGreetings" to jsonValue(data.optJSONArray("alternate_greetings") ?: JSONArray()),
            "tags" to jsonValue(data.optJSONArray("tags") ?: JSONArray()),
            "creator" to data.optString("creator", ""),
            "characterVersion" to data.opt("character_version")?.takeUnless { it === JSONObject.NULL }?.toString().orEmpty(),
            "personality" to data.optString("personality", ""),
            "scenario" to data.optString("scenario", ""),
            "firstMsgIndex" to -1,
            "replaceGlobalNote" to data.optString("post_history_instructions", ""),
            "additionalText" to risu.optString("additionalText", ""),
            "largePortrait" to if (risu.length() > 0) risu.optBoolean("largePortrait", false) else true,
            "lorePlus" to risu.optBoolean("lorePlus", false),
            "inlayViewScreen" to risu.optBoolean("inlayViewScreen", false),
            "imported" to true,
            "chatFolders" to emptyList<Any?>(),
            "extentions" to sanitizedExtensions(extensions),
        )
        extensions.optJSONObject("depth_prompt")?.let { storageData["depth_prompt"] = jsonValue(it) }
        if (spec == "chara_card_v3") {
            storageData["group_only_greetings"] = jsonValue(data.optJSONArray("group_only_greetings") ?: JSONArray())
            storageData["nickname"] = data.optString("nickname", "")
            storageData["source"] = jsonValue(data.optJSONArray("source") ?: JSONArray())
            storageData["creation_date"] = nullableNumber(data.opt("creation_date")) ?: 0
            storageData["modification_date"] = nullableNumber(data.opt("modification_date")) ?: 0
        }
        return CharacterImportPayload(name = name, data = storageData, imageBytes = imageBytes)
    }

    private fun convertCharacterBook(book: JSONObject?): List<Map<String, Any?>> {
        if (book == null) return emptyList()
        val entries = book.optJSONArray("entries") ?: return emptyList()
        return buildList {
            for (index in 0 until entries.length()) {
                val entry = entries.optJSONObject(index) ?: continue
                val extensions = entry.optJSONObject("extensions") ?: JSONObject()
                val secondary = jsonStringList(entry.optJSONArray("secondary_keys"))
                add(
                    linkedMapOf(
                        "key" to jsonStringList(entry.optJSONArray("keys")).joinToString(", "),
                        "secondkey" to secondary.joinToString(", "),
                        "insertorder" to entry.optInt("insertion_order", 0),
                        "comment" to firstNonBlank(entry, "name", "comment").orEmpty(),
                        "content" to entry.optString("content", ""),
                        "mode" to entry.optString("mode", "normal"),
                        "alwaysActive" to entry.optBoolean("constant", false),
                        "selective" to entry.optBoolean("selective", false),
                        "extentions" to jsonObjectValue(extensions) +
                            ("risu_case_sensitive" to entry.optBoolean("case_sensitive", false)),
                        "activationPercent" to nullableNumber(extensions.opt("risu_activationPercent")),
                        "loreCache" to jsonValue(extensions.opt("risu_loreCache")),
                        "useRegex" to entry.optBoolean("use_regex", false),
                        "folder" to entry.optString("folder").takeIf { it.isNotBlank() },
                    ),
                )
            }
        }
    }

    private fun sanitizedExtensions(extensions: JSONObject): Map<String, Any?> {
        val result = jsonObjectValue(extensions).toMutableMap()
        result.remove("risuai")
        result.remove("depth_prompt")
        return result
    }

    private fun jsonStringList(array: JSONArray?): List<String> = buildList {
        if (array == null) return@buildList
        for (index in 0 until array.length()) array.optString(index).takeIf { it.isNotBlank() }?.let(::add)
    }

    private fun jsonValue(value: Any?): Any? = when (value) {
        null, JSONObject.NULL -> null
        is JSONObject -> jsonObjectValue(value)
        is JSONArray -> buildList { for (index in 0 until value.length()) add(jsonValue(value.opt(index))) }
        else -> value
    }

    private fun jsonObjectValue(value: JSONObject): Map<String, Any?> = buildMap {
        val keys = value.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            put(key, jsonValue(value.opt(key)))
        }
    }

    private fun firstNonBlank(obj: JSONObject, vararg keys: String): String? =
        keys.asSequence().map { obj.optString(it) }.firstOrNull { it.isNotBlank() }

    private fun nullableNumber(value: Any?): Number? = when (value) {
        is Number -> value
        is String -> value.toDoubleOrNull()
        else -> null
    }

    private fun readUInt32(bytes: ByteArray, offset: Int): Int {
        val value = ((bytes[offset].toLong() and 0xff) shl 24) or
            ((bytes[offset + 1].toLong() and 0xff) shl 16) or
            ((bytes[offset + 2].toLong() and 0xff) shl 8) or
            (bytes[offset + 3].toLong() and 0xff)
        require(value <= Int.MAX_VALUE) { "PNG chunk is too large" }
        return value.toInt()
    }
}
