package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.generation.AnthropicGenerator
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativePromptMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AnthropicGeneratorTest {
    @Test
    fun leadingSystemPromptAndAnthropicRoleRulesArePreserved() {
        val payload = AnthropicGenerator().buildRequestPayload(
            listOf(
                NativePromptMessage("system", "main system"),
                NativePromptMessage("assistant", "first greeting"),
                NativePromptMessage("user", "hello"),
                NativePromptMessage("system", "late note"),
                NativePromptMessage("assistant", "reply"),
            ),
            GenerationSettings(aiModel = "claude-sonnet-4-6", maxResponse = 600, temperature = 0.7),
        )
        assertEquals("main system", payload.system)
        assertEquals("user", payload.messages.first().role)
        assertEquals("Start", payload.messages.first().text)
        assertTrue(payload.messages.any { it.role == "user" && it.text.contains("System: late note") })
        assertEquals("claude-sonnet-4-6", payload.model)
        assertEquals(600, payload.maxTokens)
    }

    @Test
    fun disabledTemperatureIsOmittedFromPayload() {
        val payload = AnthropicGenerator().buildRequestPayload(
            listOf(NativePromptMessage("user", "hello")),
            GenerationSettings(aiModel = "claude-sonnet-4-6", temperatureEnabled = false),
        )
        assertNull(payload.temperature)
    }
}
