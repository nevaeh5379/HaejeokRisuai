package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.generation.GeminiGenerator
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativePromptMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class GeminiGeneratorTest {
    @Test
    fun firstSystemMessageBecomesSystemInstructionAndRolesAreMapped() {
        val payload = GeminiGenerator().buildRequestPayload(
            listOf(
                NativePromptMessage("system", "system prompt"),
                NativePromptMessage("assistant", "hello"),
                NativePromptMessage("user", "hi"),
            ),
            GenerationSettings(maxResponse = 512, temperature = 0.5, topP = 0.9),
        )
        assertEquals("system prompt", payload.systemInstruction)
        assertEquals("model", payload.contents[0].role)
        assertEquals("hello", payload.contents[0].text)
        assertEquals("user", payload.contents[1].role)
        assertEquals("hi", payload.contents[1].text)
        assertEquals(512, payload.maxOutputTokens)
        assertEquals(0.5, payload.temperature!!, 0.0)
        assertEquals(0.9, payload.topP!!, 0.0)
        assertFalse(payload.contents.isEmpty())
    }

    @Test
    fun disabledTemperatureIsOmittedFromPayload() {
        val payload = GeminiGenerator().buildRequestPayload(
            listOf(NativePromptMessage("user", "hello")),
            GenerationSettings(temperatureEnabled = false),
        )
        assertNull(payload.temperature)
    }
}
