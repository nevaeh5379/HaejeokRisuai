package io.github.nevaeh5379.androidhaejeokrisuai.generation

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.forModelMode

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
        triggerPrompt: NativeTriggerPromptInjection = NativeTriggerPromptInjection(),
    ): String {
        val preparedPrompt = preparePrompt(
            settings, character, history, authorNote, greetingIndex, variables, triggerPrompt,
        )
        return dispatchPreparedPrompt(
            settings.forModelMode("model"), character, history, authorNote, greetingIndex, variables, triggerPrompt, preparedPrompt,
        )
    }

    internal suspend fun generateExplicitPrompt(
        settings: GenerationSettings,
        character: CharacterProfile,
        history: List<MessageRecord>,
        authorNote: String,
        greetingIndex: Int,
        variables: Map<String, String>,
        prompt: List<NativePromptMessage>,
        modelMode: String = "model",
    ): String {
        val preparedPrompt = prepareExplicitPrompt(
            settings, character, history, authorNote, greetingIndex, variables, prompt,
        )
        return dispatchPreparedPrompt(
            settings.forModelMode(modelMode), character, history, authorNote, greetingIndex, variables,
            NativeTriggerPromptInjection(), preparedPrompt,
        )
    }

    internal fun prepareExplicitPrompt(
        settings: GenerationSettings,
        character: CharacterProfile,
        history: List<MessageRecord>,
        authorNote: String,
        greetingIndex: Int,
        variables: Map<String, String>,
        prompt: List<NativePromptMessage>,
    ): List<NativePromptMessage> {
        val requestTrigger = NativeTriggerProcessor.run(
            mode = "request",
            settings = settings,
            character = character,
            messages = history,
            variables = variables,
            chatId = history.lastOrNull()?.chatId.orEmpty(),
            authorNote = authorNote,
            greetingIndex = greetingIndex,
            requestState = prompt,
        )
        return NativeContextWindow.trim(
            requestTrigger.requestState ?: prompt,
            settings.maxContext,
            settings.maxResponse,
        )
    }

    private suspend fun dispatchPreparedPrompt(
        settings: GenerationSettings,
        character: CharacterProfile,
        history: List<MessageRecord>,
        authorNote: String,
        greetingIndex: Int,
        variables: Map<String, String>,
        triggerPrompt: NativeTriggerPromptInjection,
        preparedPrompt: List<NativePromptMessage>,
    ): String = when {
        settings.aiModel.startsWith("gemini", ignoreCase = true) -> gemini.generate(
            settings, character, history, authorNote, greetingIndex, variables, triggerPrompt, preparedPrompt,
        )
        settings.aiModel.startsWith("claude", ignoreCase = true) -> anthropic.generate(
            settings, character, history, authorNote, greetingIndex, variables, triggerPrompt, preparedPrompt,
        )
        else -> openAiCompatible.generate(
            settings, character, history, authorNote, greetingIndex, variables, triggerPrompt, preparedPrompt,
        )
    }

    internal fun preparePrompt(
        settings: GenerationSettings,
        character: CharacterProfile,
        history: List<MessageRecord>,
        authorNote: String = "",
        greetingIndex: Int = -1,
        variables: Map<String, String> = emptyMap(),
        triggerPrompt: NativeTriggerPromptInjection = NativeTriggerPromptInjection(),
    ): List<NativePromptMessage> {
        val basePrompt = NativePromptBuilder.build(
            settings, character, history, authorNote, greetingIndex, variables, triggerPrompt,
        )
        val requestTrigger = NativeTriggerProcessor.run(
            mode = "request",
            settings = settings,
            character = character,
            messages = history,
            variables = variables,
            chatId = history.lastOrNull()?.chatId.orEmpty(),
            authorNote = authorNote,
            greetingIndex = greetingIndex,
            requestState = basePrompt,
        )
        return requestTrigger.requestState ?: basePrompt
    }
}
