package io.github.nevaeh5379.androidhaejeokrisuai.generation

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord

class NativeGenerationEngine {
    private val openAiCompatible = OpenAiCompatibleGenerator()
    private val gemini = GeminiGenerator()
    private val anthropic = AnthropicGenerator()

    suspend fun generate(
        settings: GenerationSettings,
        character: CharacterProfile,
        history: List<MessageRecord>,
        authorNote: String = "",
        greetingIndex: Int = -1,
        variables: Map<String, String> = emptyMap(),
    ): String = when {
        settings.aiModel.startsWith("gemini", ignoreCase = true) -> gemini.generate(
            settings, character, history, authorNote, greetingIndex, variables,
        )
        settings.aiModel.startsWith("claude", ignoreCase = true) -> anthropic.generate(
            settings, character, history, authorNote, greetingIndex, variables,
        )
        else -> openAiCompatible.generate(settings, character, history, authorNote, greetingIndex, variables)
    }
}
