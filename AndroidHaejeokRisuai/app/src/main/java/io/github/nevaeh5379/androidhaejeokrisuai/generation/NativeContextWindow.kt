package io.github.nevaeh5379.androidhaejeokrisuai.generation

import java.nio.charset.StandardCharsets
import kotlin.math.ceil

/**
 * Conservative tokenizer-independent context guard.
 *
 * The web runtime uses the selected model tokenizer. The native port does not
 * ship every provider tokenizer yet, so this deliberately overestimates text
 * from UTF-8 bytes and removes only prompt messages marked as chat-removable.
 */
internal object NativeContextWindow {
    private const val SAFETY_TOKENS = 50
    private const val MESSAGE_OVERHEAD = 4

    fun trim(
        messages: List<NativePromptMessage>,
        maxContext: Int,
        maxResponse: Int,
    ): List<NativePromptMessage> {
        if (messages.isEmpty()) return messages
        val result = messages.toMutableList()
        val limit = maxContext.coerceAtLeast(1)
        var total = maxResponse.coerceAtLeast(0) + SAFETY_TOKENS + result.sumOf(::estimateTokens)

        while (total > limit) {
            val removableIndexes = result.indices.filter { result[it].removable }
            if (removableIndexes.size <= 1) break
            val index = removableIndexes.first()
            total -= estimateTokens(result[index])
            result.removeAt(index)
        }

        if (total > limit) {
            throw IllegalStateException(
                "Native prompt exceeds maxContext=$limit after trimming older chat messages " +
                    "(estimated $total tokens including maxResponse=$maxResponse)",
            )
        }
        return result
    }

    internal fun estimateTokens(message: NativePromptMessage): Int {
        val bytes = message.content.toByteArray(StandardCharsets.UTF_8).size
        return ceil(bytes / 3.0).toInt().coerceAtLeast(1) + MESSAGE_OVERHEAD
    }
}
