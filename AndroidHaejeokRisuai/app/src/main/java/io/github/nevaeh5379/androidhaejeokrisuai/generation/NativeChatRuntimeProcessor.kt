package io.github.nevaeh5379.androidhaejeokrisuai.generation

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord

data class NativePreparedChatRuntime(
    val messages: List<MessageRecord>,
    val variables: Map<String, String>,
)

object NativeChatRuntimeProcessor {
    fun prepare(
        settings: GenerationSettings,
        character: CharacterProfile,
        messages: List<MessageRecord>,
        authorNote: String = "",
        greetingIndex: Int = -1,
        variables: Map<String, String> = emptyMap(),
    ): NativePreparedChatRuntime {
        val working = messages.toMutableList()
        var currentVariables = variables.toMap()
        for (index in working.indices) {
            val message = working[index]
            if (!needsParsing(message.data)) continue
            val result = NativeRisuParser.parseMutating(
                message.data,
                NativeRisuParserContext(
                    settings = settings,
                    character = character,
                    history = working,
                    authorNote = authorNote,
                    greetingIndex = greetingIndex,
                    variables = currentVariables,
                ),
            )
            currentVariables = result.variables
            working[index] = message.copy(data = result.text)
        }
        return NativePreparedChatRuntime(working, currentVariables)
    }

    private fun needsParsing(text: String): Boolean =
        "{{" in text || "<char>" in text || "<user>" in text
}
