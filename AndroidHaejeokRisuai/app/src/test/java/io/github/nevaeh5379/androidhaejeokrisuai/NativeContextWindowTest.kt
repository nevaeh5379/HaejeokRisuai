package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeContextWindow
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativePromptMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeContextWindowTest {
    @Test
    fun removesOldestChatMessagesBeforeFixedPromptsAndKeepsLatestChat() {
        val fixed = NativePromptMessage("system", "fixed rules that must stay")
        val old = NativePromptMessage("user", "old ".repeat(30), removable = true)
        val middle = NativePromptMessage("assistant", "middle ".repeat(30), removable = true)
        val latest = NativePromptMessage("user", "latest", removable = true)
        val maxContext = 50 + 10 + NativeContextWindow.estimateTokens(fixed) +
            NativeContextWindow.estimateTokens(middle) + NativeContextWindow.estimateTokens(latest)

        val result = NativeContextWindow.trim(listOf(fixed, old, middle, latest), maxContext, 10)

        assertTrue(result.contains(fixed))
        assertFalse(result.contains(old))
        assertTrue(result.contains(middle))
        assertEquals(latest, result.last())
    }

    @Test(expected = IllegalStateException::class)
    fun refusesToDropFixedPromptWhenEvenOneLatestChatCannotFit() {
        NativeContextWindow.trim(
            listOf(
                NativePromptMessage("system", "X".repeat(400)),
                NativePromptMessage("user", "latest", removable = true),
            ),
            maxContext = 80,
            maxResponse = 20,
        )
    }

    @Test
    fun utf8EstimatorIsConservativeForMultibyteText() {
        val english = NativeContextWindow.estimateTokens(NativePromptMessage("user", "a".repeat(90)))
        val korean = NativeContextWindow.estimateTokens(NativePromptMessage("user", "가".repeat(90)))
        assertTrue(korean > english)
    }
}
