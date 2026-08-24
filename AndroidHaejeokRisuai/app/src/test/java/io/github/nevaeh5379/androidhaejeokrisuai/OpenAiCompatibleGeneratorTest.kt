package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativePromptMessage
import io.github.nevaeh5379.androidhaejeokrisuai.generation.OpenAiCompatibleGenerator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OpenAiCompatibleGeneratorTest {
    private val generator = OpenAiCompatibleGenerator()

    @Test
    fun reverseProxyAutofillsChatCompletionsEndpoint() {
        val target = generator.resolveTarget(
            GenerationSettings(
                aiModel = "reverse_proxy",
                forceReplaceUrl = "https://example.test/api",
                proxyKey = "secret",
                proxyRequestModel = "custom",
                customProxyRequestModel = "my-model",
                autofillRequestUrl = true,
            ),
        )
        assertEquals("https://example.test/api/v1/chat/completions", target.url)
        assertEquals("my-model", target.model)
        assertEquals("secret", target.key)
    }

    @Test
    fun disabledTemperatureIsOmittedFromPurePayload() {
        val settings = GenerationSettings(aiModel = "gpt4o", temperature = 0.8, temperatureEnabled = false)
        val payload = generator.buildRequestPayload(
            listOf(NativePromptMessage("user", "hello")),
            generator.resolveTarget(settings),
            settings,
        )
        assertNull(payload.temperature)
    }

    @Test
    fun openRouterUsesConfiguredModel() {
        val target = generator.resolveTarget(
            GenerationSettings(
                aiModel = "openrouter",
                openrouterRequestModel = "openai/gpt-4o-mini",
                openrouterKey = "router-key",
            ),
        )
        assertEquals("https://openrouter.ai/api/v1/chat/completions", target.url)
        assertEquals("openai/gpt-4o-mini", target.model)
    }
}
