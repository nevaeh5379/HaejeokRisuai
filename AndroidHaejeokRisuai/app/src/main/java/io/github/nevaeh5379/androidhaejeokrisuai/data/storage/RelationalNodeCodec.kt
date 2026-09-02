package io.github.nevaeh5379.androidhaejeokrisuai.data.storage

import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

internal data class RelationalNodeRow(
    val nodeId: Int,
    val parentNodeId: Int?,
    val nodeOrder: Int,
    val objectKey: String?,
    val objectKeyEncoded: String?,
    val valueType: String,
    val textValue: String?,
    val encodedTextValue: String?,
    val numberValue: Double?,
    val booleanValue: Int?,
)

internal object RelationalNodeCodec {
    private const val MAX_DEPTH = 256

    @OptIn(ExperimentalEncodingApi::class)
    private fun encodeUtf16(value: String): String {
        val bytes = ByteArray(value.length * 2)
        value.forEachIndexed { index, char ->
            val code = char.code
            bytes[index * 2] = (code and 0xff).toByte()
            bytes[index * 2 + 1] = (code ushr 8).toByte()
        }
        return Base64.Default.encode(bytes)
    }

    @OptIn(ExperimentalEncodingApi::class)
    private fun decodeUtf16(value: String): String {
        val bytes = Base64.Default.decode(value)
        require(bytes.size % 2 == 0) { "Invalid UTF-16 relational node value" }
        return buildString(bytes.size / 2) {
            var index = 0
            while (index < bytes.size) {
                val code = (bytes[index].toInt() and 0xff) or ((bytes[index + 1].toInt() and 0xff) shl 8)
                append(code.toChar())
                index += 2
            }
        }
    }

    private fun isSqlTextSafe(value: String): Boolean {
        if ('\u0000' in value) return false
        var index = 0
        while (index < value.length) {
            val char = value[index]
            when {
                char.isHighSurrogate() -> {
                    if (index + 1 >= value.length || !value[index + 1].isLowSurrogate()) return false
                    index += 2
                }
                char.isLowSurrogate() -> return false
                else -> index++
            }
        }
        return true
    }

    private fun encodeText(value: String): Pair<String?, String?> =
        if (isSqlTextSafe(value)) value to null else null to encodeUtf16(value)

    private fun decodeText(text: String?, encoded: String?): String =
        if (encoded != null) decodeUtf16(encoded) else text.orEmpty()

    fun flatten(value: Any?): List<RelationalNodeRow> {
        val rows = mutableListOf<RelationalNodeRow>()
        fun append(current: Any?, parent: Int?, order: Int, key: String?, depth: Int) {
            require(depth <= MAX_DEPTH) { "Relational value exceeds maximum depth" }
            val nodeId = rows.size
            val (keyText, keyEncoded) = key?.let(::encodeText) ?: (null to null)
            var type = "null"
            var text: String? = null
            var encoded: String? = null
            var number: Double? = null
            var boolean: Int? = null
            when (current) {
                null -> Unit
                is Boolean -> { type = "boolean"; boolean = if (current) 1 else 0 }
                is Number -> {
                    type = "number"
                    val n = current.toDouble()
                    if (n.isFinite()) number = n else text = when {
                        n.isNaN() -> "NaN"
                        n > 0 -> "Infinity"
                        else -> "-Infinity"
                    }
                }
                is String -> { type = "string"; val pair = encodeText(current); text = pair.first; encoded = pair.second }
                is List<*> -> type = "array"
                is Map<*, *> -> type = "object"
                else -> throw IllegalArgumentException("Unsupported relational value type: ${current::class}")
            }
            rows += RelationalNodeRow(nodeId, parent, order, keyText, keyEncoded, type, text, encoded, number, boolean)
            when (current) {
                is List<*> -> current.forEachIndexed { i, child -> append(child, nodeId, i, null, depth + 1) }
                is Map<*, *> -> current.entries.forEachIndexed { i, entry -> append(entry.value, nodeId, i, entry.key.toString(), depth + 1) }
            }
        }
        append(value, null, 0, null, 0)
        return rows
    }

    fun rebuild(input: List<RelationalNodeRow>): Any? {
        require(input.isNotEmpty()) { "Relational value has no root node" }
        val rows = input.sortedBy { it.nodeId }
        require(rows.first().nodeId == 0 && rows.first().parentNodeId == null) { "Relational value has an invalid root node" }
        val children = rows.drop(1).groupBy { it.parentNodeId }.mapValues { (_, value) -> value.sortedBy { it.nodeOrder } }
        fun build(row: RelationalNodeRow, depth: Int): Any? {
            require(depth <= MAX_DEPTH) { "Relational value exceeds maximum depth" }
            return when (row.valueType) {
                "null", "undefined" -> null
                "boolean" -> row.booleanValue != 0
                "number" -> when (row.textValue) {
                    "NaN" -> Double.NaN
                    "Infinity" -> Double.POSITIVE_INFINITY
                    "-Infinity" -> Double.NEGATIVE_INFINITY
                    else -> row.numberValue ?: 0.0
                }
                "string" -> decodeText(row.textValue, row.encodedTextValue)
                "array" -> children[row.nodeId].orEmpty().map { build(it, depth + 1) }
                "object" -> linkedMapOf<String, Any?>().apply {
                    children[row.nodeId].orEmpty().forEach { child ->
                        put(decodeText(child.objectKey, child.objectKeyEncoded), build(child, depth + 1))
                    }
                }
                else -> error("Unknown relational node type: ${row.valueType}")
            }
        }
        return build(rows.first(), 0)
    }
}
