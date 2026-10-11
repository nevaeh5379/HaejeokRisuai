package io.github.nevaeh5379.androidhaejeokrisuai.generation

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord

internal object NativeDisplayProcessor {
    fun requiredHistoryDepth(character: CharacterProfile): Int? {
        var maximum = 0
        for (trigger in character.triggerScripts) {
            if (trigger.type != "display") continue
            for (condition in trigger.conditions) {
                if (condition["type"]?.toString() != "exists") continue
                val depth = (condition["depth"] as? Number)?.toInt() ?: 0
                if (depth <= 0) return null
                maximum = maxOf(maximum, depth)
            }
        }
        return maximum
    }

    fun process(
        data: String,
        settings: GenerationSettings,
        character: CharacterProfile,
        history: List<MessageRecord>,
        variables: Map<String, String>,
        chatId: String,
        authorNote: String = "",
        greetingIndex: Int = -1,
        messageCount: Int = history.size,
    ): String {
        val trigger = NativeTriggerProcessor.run(
            mode = "display",
            settings = settings,
            character = character,
            messages = history,
            variables = variables,
            chatId = chatId,
            authorNote = authorNote,
            greetingIndex = greetingIndex,
            displayState = data,
            messageCount = messageCount,
        )
        val displayData = trigger.displayState ?: data
        return NativeRegexProcessor.process(
            data = displayData,
            mode = "editdisplay",
            settings = settings,
            character = character,
            parserContext = NativeRisuParserContext(
                settings = settings,
                character = character,
                history = history,
                authorNote = authorNote,
                greetingIndex = greetingIndex,
                variables = variables,
                messageCount = messageCount,
            ),
        )
    }
}
