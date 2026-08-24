package io.github.nevaeh5379.androidhaejeokrisuai.generation

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.PromptTemplateItem

data class NativePromptMessage(val role: String, val content: String, val removable: Boolean = false)

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
        fun processChatText(text: String): String = NativeRegexProcessor.process(
            data = text,
            mode = "editprocess",
            settings = settings,
            character = character,
            parserContext = parserContext,
        )
        val usingPromptTemplate = settings.promptTemplate != null
        val buckets = linkedMapOf<String, MutableList<NativePromptMessage>>()
        fun add(bucket: String, role: String = "system", text: String) {
            val parsed = NativeRisuParser.parse(text, parserContext).trim()
            if (parsed.isNotEmpty()) buckets.getOrPut(bucket) { mutableListOf() }
                .add(NativePromptMessage(role, parsed, removable = bucket == "chats" || bucket == "lastChat"))
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
        if (!settings.promptSettings.trimStartNewChat) add("chats", text = "[Start a new chat]")
        val greeting = if (greetingIndex >= 0) {
            character.alternateGreetings.getOrNull(greetingIndex) ?: character.firstMessage
        } else character.firstMessage
        add("chats", role = "assistant", text = processChatText(greeting))
        if (usingPromptTemplate) {
            history.forEach { message ->
                if (message.data.isBlank()) return@forEach
                val role = if (message.role == "user") "user" else "assistant"
                add("chats", role, processChatText(message.data))
            }
        } else {
            history.dropLast(1).forEach { message ->
                if (message.data.isBlank()) return@forEach
                val role = if (message.role == "user") "user" else "assistant"
                add("chats", role, processChatText(message.data))
            }
            history.lastOrNull()?.let { message ->
                if (message.data.isNotBlank()) {
                    val role = if (message.role == "user") "user" else "assistant"
                    add("lastChat", role, processChatText(message.data))
                }
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
        val templateDefaultAuthorNote = settings.promptTemplate
            ?.firstOrNull { it.type == "authornote" }
            ?.defaultText
            .orEmpty()
        add("authorNote", text = authorNote.ifBlank { templateDefaultAuthorNote })

        if (settings.promptTemplate != null) {
            return mergeAdjacentSystemMessages(
                NativeContextWindow.trim(
                    formatPromptTemplate(settings.promptTemplate, buckets, parserContext, settings, character),
                    settings.maxContext,
                    settings.maxResponse,
                ),
            )
        }

        val result = mutableListOf<NativePromptMessage>()
        val seen = mutableSetOf<String>()
        for (key in settings.formatingOrder + "postEverything") {
            if (!seen.add(key)) continue
            result += buckets[key].orEmpty()
        }
        for ((key, messages) in buckets) if (key !in seen) result += messages
        return mergeAdjacentSystemMessages(
            NativeContextWindow.trim(result, settings.maxContext, settings.maxResponse),
        )
    }

    private fun formatPromptTemplate(
        rawTemplate: List<PromptTemplateItem>,
        buckets: Map<String, List<NativePromptMessage>>,
        parserContext: NativeRisuParserContext,
        settings: GenerationSettings,
        character: CharacterProfile,
    ): List<NativePromptMessage> {
        val template = if (rawTemplate.any { it.type == "postEverything" }) rawTemplate
            else rawTemplate + PromptTemplateItem(type = "postEverything")
        val result = mutableListOf<NativePromptMessage>()

        fun role(value: String?): String = when (value) {
            "bot", "assistant" -> "assistant"
            "user" -> "user"
            else -> "system"
        }
        fun withRole(messages: List<NativePromptMessage>, forced: String?): List<NativePromptMessage> =
            if (forced == null) messages else messages.map { it.copy(role = role(forced)) }
        fun innerFormat(format: String, slot: String): String {
            if (format.isBlank()) return slot
            val marker = "\uE220"
            val parsed = NativeRisuParser.parse(format.replace("{{slot}}", marker), parserContext)
            return parsed.replace(marker, slot)
        }
        fun addTyped(bucket: String, card: PromptTemplateItem) {
            val prompts = withRole(buckets[bucket].orEmpty(), card.role2).map { message ->
                if (card.innerFormat.isBlank()) message else message.copy(
                    content = innerFormat(card.innerFormat, message.content),
                )
            }
            result += prompts.filter { it.content.isNotBlank() }
        }

        for (card in template) {
            when (card.type) {
                "persona" -> addTyped("personaPrompt", card)
                "description" -> addTyped("description", card)
                "authornote" -> addTyped("authorNote", card)
                "lorebook" -> result += buckets["lorebook"].orEmpty()
                "postEverything" -> {
                    result += buckets["postEverything"].orEmpty()
                    if (settings.promptSettings.postEndInnerFormat.isNotBlank()) {
                        result += NativePromptMessage(
                            "system",
                            NativeRisuParser.parse(settings.promptSettings.postEndInnerFormat, parserContext),
                        )
                    }
                }
                "plain", "jailbreak", "cot" -> {
                    if (card.type == "jailbreak" && !settings.jailbreakToggle) continue
                    if (card.type == "cot") continue // Native chain-of-thought controls are not ported yet.
                    var content = card.text
                    if (card.type2 == "globalNote" && character.replaceGlobalNote.isNotBlank()) {
                        content = character.replaceGlobalNote.replace("{{original}}", content)
                    }
                    content = NativeRisuParser.parse(content, parserContext)
                    if (content.isNotBlank()) result += NativePromptMessage(role(card.role), content)
                }
                "chatML" -> result += parseChatMl(card.text, parserContext)
                "chat" -> {
                    val all = buckets["chats"].orEmpty()
                    var start = card.rangeStart
                    var end = card.rangeEnd ?: all.size
                    if (start == -1000) {
                        start = 0
                        end = all.size
                    }
                    if (start < 0) start = (all.size + start).coerceAtLeast(0)
                    if (end < 0) end = (all.size + end).coerceAtLeast(0)
                    start = start.coerceIn(0, all.size)
                    end = end.coerceIn(0, all.size)
                    if (start < end) {
                        var selected = all.subList(start, end).map { it.copy() }
                        if (settings.promptSettings.sendChatAsSystem && !card.chatAsOriginalOnSystem) {
                            selected = selected.map { message ->
                                if (message.role == "user" || message.role == "assistant") {
                                    NativePromptMessage("system", "${message.role}: ${message.content}", message.removable)
                                } else message
                            }
                        }
                        result += selected
                    }
                }
                "memory", "cache" -> Unit // Native memory/cache-point engines are separate future work.
            }
        }
        return result
    }

    private fun parseChatMl(text: String, parserContext: NativeRisuParserContext): List<NativePromptMessage> {
        val starter = "<|im_start|>"
        val separator = "<|im_sep|>"
        val ender = "<|im_end|>"
        val parsed = NativeRisuParser.parse(text, parserContext).trim()
        if (!parsed.startsWith(starter)) return emptyList()
        return parsed.split(starter).filter { it.isNotEmpty() }.map { raw ->
            var body = raw
            var role = "user"
            when {
                body.startsWith("user$separator") -> { role = "user"; body = body.substring(4 + separator.length) }
                body.startsWith("system$separator") -> { role = "system"; body = body.substring(6 + separator.length) }
                body.startsWith("assistant$separator") -> { role = "assistant"; body = body.substring(9 + separator.length) }
                body.startsWith("user ") || body.startsWith("user\n") -> { role = "user"; body = body.substring(5) }
                body.startsWith("system ") || body.startsWith("system\n") -> { role = "system"; body = body.substring(7) }
                body.startsWith("assistant ") || body.startsWith("assistant\n") -> { role = "assistant"; body = body.substring(10) }
            }
            body = body.trim()
            if (body.endsWith(ender)) body = body.dropLast(ender.length)
            NativePromptMessage(role, body.replace(Regex("<Thoughts>(.+)</Thoughts>", RegexOption.DOT_MATCHES_ALL), "").trim())
        }
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
                result[result.lastIndex] = previous.copy(
                    content = previous.content + "\n\n" + message.content,
                    removable = previous.removable && message.removable,
                )
            } else result += message
        }
        return result
    }
}
