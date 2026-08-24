package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.TriggerScript
import io.github.nevaeh5379.androidhaejeokrisuai.generation.AnthropicGenerator
import io.github.nevaeh5379.androidhaejeokrisuai.generation.GeminiGenerator
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeGenerationEngine
import io.github.nevaeh5379.androidhaejeokrisuai.generation.OpenAiCompatibleGenerator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeRequestTriggerDispatchTest {
    private val requestTrigger = TriggerScript(
        comment = "request mutation",
        type = "request",
        effects = listOf(
            mapOf("type" to "v2Header", "indent" to 0),
            mapOf(
                "type" to "v2SetRequestState", "index" to "0", "indexType" to "value",
                "value" to "request-mutated", "valueType" to "value", "indent" to 0,
            ),
            mapOf(
                "type" to "v2SetRequestStateRole", "index" to "0", "indexType" to "value",
                "value" to "assistant", "valueType" to "value", "indent" to 0,
            ),
        ),
    )

    private fun preparedPrompt() = NativeGenerationEngine().preparePrompt(
        settings = GenerationSettings(
            aiModel = "gpt4o",
            mainPrompt = "base system",
            formatingOrder = listOf("main", "lastChat"),
        ),
        character = CharacterProfile(
            id = "c",
            name = "Lua",
            triggerScripts = listOf(requestTrigger),
        ),
        history = listOf(MessageRecord("m", "chat", "user", "hello")),
    )

    @Test
    fun generationEngineAppliesRequestMutationBeforeProviderSerialization() {
        val prompt = preparedPrompt()
        assertEquals("assistant", prompt.first().role)
        assertEquals("request-mutated", prompt.first().content)

        val openAi = OpenAiCompatibleGenerator()
        val openAiPayload = openAi.buildRequestPayload(
            prompt,
            OpenAiCompatibleGenerator.Target("https://example.test", "", "test-model"),
            GenerationSettings(maxResponse = 128, temperature = 0.4),
        )
        assertEquals("assistant", openAiPayload.messages.first().role)
        assertEquals("request-mutated", openAiPayload.messages.first().content)

        val geminiPayload = GeminiGenerator().buildRequestPayload(
            prompt,
            GenerationSettings(aiModel = "gemini-2.5-flash"),
        )
        assertTrue(geminiPayload.contents.any {
            it.role == "model" && it.text == "request-mutated"
        })

        val anthropicPayload = AnthropicGenerator().buildRequestPayload(
            prompt,
            GenerationSettings(aiModel = "claude-sonnet-4-6"),
        )
        assertTrue(anthropicPayload.messages.any {
            it.role == "assistant" && it.text == "request-mutated"
        })
    }
}
