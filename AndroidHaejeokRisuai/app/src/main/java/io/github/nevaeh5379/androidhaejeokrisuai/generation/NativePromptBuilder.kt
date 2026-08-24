package io.github.nevaeh5379.androidhaejeokrisuai.generation

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord

data class NativePromptMessage(val role: String, val content: String)

object NativePromptBuilder {
    fun build(
        settings: GenerationSettings,
        character: CharacterProfile,
        history: List<MessageRecord>,
        authorNote: String = "",
        greetingIndex: Int = -1,
        variables: Map<String, String> = emptyMap(),
    ): List<NativePromptMessage> {
        val parserContext = NativeRisuParserContext(
            settings = settings,
            character = character,
            history = history,
            authorNote = authorNote,
            greetingIndex = greetingIndex,
            variables = variables,
        )
        val buckets = linkedMapOf<String, MutableList<NativePromptMessage>>()
        fun add(bucket: String, role: String = "system", text: String) {
            val parsed = NativeRisuParser.parse(text, parserContext).trim()
            if (parsed.isNotEmpty()) buckets.getOrPut(bucket) { mutableListOf() }
                .add(NativePromptMessage(role, parsed))
        }
        fun addPromptBlocks(bucket: String, text: String) {
            parsePromptBlocks(NativeRisuParser.parse(text, parserContext)).forEach {
                add(bucket, it.role, it.content)
            }
        }

        val main = if (character.systemPrompt.isNotBlank()) {
            character.systemPrompt.replace("{{original}}", settings.mainPrompt)
        } else settings.mainPrompt
        addPromptBlocks("main", main + if (settings.promptPreprocess && settings.additionalPrompt.isNotBlank()) {
            "\n${settings.additionalPrompt}"
        } else "")

        val description = buildString {
            if (settings.promptPreprocess) append(settings.descriptionPrefix)
            append(character.description)
            if (character.personality.isNotBlank()) {
                append("\n\nDescription of {{char}}: ").append(character.personality)
            }
            if (character.scenario.isNotBlank()) {
                append("\n\nCircumstances and context of the dialogue: ").append(character.scenario)
            }
        }
        add("description", text = description)
        add("personaPrompt", text = settings.personaPrompt)

        parseExampleMessages(character.exampleMessage, parserContext).forEach { example ->
            add("chats", example.role, example.content)
        }
        add("chats", text = "[Start a new chat]")
        val greeting = if (greetingIndex >= 0) {
            character.alternateGreetings.getOrNull(greetingIndex) ?: character.firstMessage
        } else character.firstMessage
        add("chats", role = "assistant", text = greeting)
        history.dropLast(1).forEach { message ->
            if (message.data.isBlank()) return@forEach
            val role = if (message.role == "user") "user" else "assistant"
            add("chats", role, message.data)
        }
        history.lastOrNull()?.let { message ->
            if (message.data.isNotBlank()) {
                val role = if (message.role == "user") "user" else "assistant"
                add("lastChat", role, message.data)
            }
        }
        NativeLorebookProcessor.resolve(character.globalLore, history, settings).forEach { lore ->
            add("lorebook", lore.role, lore.content)
        }
        if (settings.jailbreakToggle) addPromptBlocks("jailbreak", settings.jailbreak)
        val globalNote = if (character.replaceGlobalNote.isNotBlank()) {
            character.replaceGlobalNote.replace("{{original}}", settings.globalNote)
        } else settings.globalNote
        addPromptBlocks("globalNote", globalNote)
        add("authorNote", text = authorNote)

        val result = mutableListOf<NativePromptMessage>()
        val seen = mutableSetOf<String>()
        for (key in settings.formatingOrder + "postEverything") {
            if (!seen.add(key)) continue
            result += buckets[key].orEmpty()
        }
        for ((key, messages) in buckets) if (key !in seen) result += messages
        return mergeAdjacentSystemMessages(result)
    }

    internal fun parseExampleMessages(
        text: String,
        settings: GenerationSettings,
        character: CharacterProfile,
    ): List<NativePromptMessage> = parseExampleMessages(
        text,
        NativeRisuParserContext(settings = settings, character = character),
    )

    private fun parseExampleMessages(
        text: String,
        parserContext: NativeRisuParserContext,
    ): List<NativePromptMessage> {
        if (text.isBlank()) return emptyList()
        val result = mutableListOf<NativePromptMessage>()
        var current: NativePromptMessage? = null
        fun flush() {
            current?.let { result += it.copy(content = NativeRisuParser.parse(it.content, parserContext)) }
            current = null
        }
        val character = parserContext.character
        for (line in text.split('\n')) {
            val trimmed = line.trim()
            val lowered = trimmed.lowercase()
            when {
                lowered == "<start>" -> {
                    flush()
                    result += NativePromptMessage("system", "[Start a new chat]")
                }
                lowered.startsWith("{{char}}:") || lowered.startsWith("<bot>:") ||
                    lowered.startsWith(character.name.lowercase() + ":") -> {
                    flush()
                    current = NativePromptMessage("assistant", trimmed.substringAfter(':').trimStart())
                }
                lowered.startsWith("{{user}}:") || lowered.startsWith("<user>:") -> {
                    flush()
                    current = NativePromptMessage("user", trimmed.substringAfter(':').trimStart())
                }
                current != null -> current = current!!.copy(content = current!!.content + "\n" + trimmed)
            }
        }
        flush()
        return result
    }

    internal fun parsePromptBlocks(text: String): List<NativePromptMessage> {
        if (text.isBlank()) return emptyList()
        val normalized = if (text.startsWith("@@")) text else "@@system\n$text"
        val marker = Regex("@@@?(user|assistant|system)\\n")
        val matches = marker.findAll(normalized).toList()
        return matches.mapIndexedNotNull { index, match ->
            val contentStart = match.range.last + 1
            val contentEnd = matches.getOrNull(index + 1)?.range?.first ?: normalized.length
            val content = normalized.substring(contentStart, contentEnd).trim()
            if (content.isBlank()) null else NativePromptMessage(match.groupValues[1], content)
        }
    }

    private fun mergeAdjacentSystemMessages(messages: List<NativePromptMessage>): List<NativePromptMessage> {
        val result = mutableListOf<NativePromptMessage>()
        for (message in messages) {
            val previous = result.lastOrNull()
            if (message.role == "system" && previous?.role == "system") {
                result[result.lastIndex] = previous.copy(content = previous.content + "\n\n" + message.content)
            } else result += message
        }
        return result
    }
}
