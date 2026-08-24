package io.github.nevaeh5379.androidhaejeokrisuai.generation

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.RuntimeStatePatch
import io.github.nevaeh5379.androidhaejeokrisuai.data.TriggerScript
import java.util.UUID

data class NativeTriggerPromptInjection(
    val start: String = "",
    val historyEnd: String = "",
    val promptEnd: String = "",
)

data class NativeTriggerResult(
    val messages: List<MessageRecord>,
    val variables: Map<String, String>,
    val promptInjection: NativeTriggerPromptInjection = NativeTriggerPromptInjection(),
    val stopSending: Boolean = false,
    val runtimePatch: RuntimeStatePatch = RuntimeStatePatch(),
)

object NativeTriggerProcessor {
    private const val MAX_RECURSION = 10

    fun run(
        mode: String,
        settings: GenerationSettings,
        character: CharacterProfile,
        messages: List<MessageRecord>,
        variables: Map<String, String>,
        chatId: String = messages.lastOrNull()?.chatId.orEmpty(),
        authorNote: String = "",
        greetingIndex: Int = -1,
        recursion: Int = 0,
        manualName: String? = null,
        inheritedPrompt: NativeTriggerPromptInjection = NativeTriggerPromptInjection(),
        inheritedStop: Boolean = false,
        inheritedPatch: RuntimeStatePatch = RuntimeStatePatch(),
    ): NativeTriggerResult {
        if (character.triggerScripts.isEmpty()) {
            return NativeTriggerResult(messages, variables, inheritedPrompt, inheritedStop, inheritedPatch)
        }
        val working = messages.toMutableList()
        val vars = variables.toMutableMap()
        var prompt = inheritedPrompt
        var stop = inheritedStop
        var runtimePatch = inheritedPatch
        var runtimeCharacter = runtimePatch.applyTo(character)
        var runtimeAuthorNote = runtimePatch.resolveAuthorNote(authorNote)

        fun context() = NativeRisuParserContext(
            settings = settings,
            character = runtimeCharacter,
            history = working,
            authorNote = runtimeAuthorNote,
            greetingIndex = greetingIndex,
            variables = vars,
        )
        fun parse(value: Any?): String = NativeRisuParser.parse(value?.toString().orEmpty(), context())
        fun getVar(key: String): String = NativeRisuParser.parse("{{getvar::$key}}", context())

        for (trigger in runtimeCharacter.triggerScripts) {
            if (manualName != null) {
                if (trigger.comment != manualName) continue
            } else if (trigger.type != mode) continue
            if (!passes(trigger, working, ::parse, ::getVar)) continue

            if (trigger.effects.firstOrNull()?.get("type")?.toString() == "v2Header") {
                val v2 = NativeTriggerV2Processor.run(
                    trigger = trigger,
                    settings = settings,
                    character = runtimeCharacter,
                    messages = working,
                    variables = vars,
                    chatId = chatId,
                    authorNote = runtimeAuthorNote,
                    greetingIndex = greetingIndex,
                    inheritedPrompt = prompt,
                    inheritedStop = stop,
                    inheritedPatch = runtimePatch,
                    runManual = { target, nestedMessages, nestedVars, nestedPrompt, nestedStop, nestedPatch ->
                        if (recursion < MAX_RECURSION || trigger.lowLevelAccess) {
                            run(
                                mode = "manual",
                                settings = settings,
                                character = character,
                                messages = nestedMessages,
                                variables = nestedVars,
                                chatId = chatId,
                                authorNote = authorNote,
                                greetingIndex = greetingIndex,
                                recursion = recursion + 1,
                                manualName = target,
                                inheritedPrompt = nestedPrompt,
                                inheritedStop = nestedStop,
                                inheritedPatch = nestedPatch,
                            )
                        } else NativeTriggerResult(nestedMessages, nestedVars, nestedPrompt, nestedStop, nestedPatch)
                    },
                )
                working.clear(); working += v2.messages
                vars.clear(); vars.putAll(v2.variables)
                prompt = v2.promptInjection
                stop = v2.stopSending
                runtimePatch = v2.runtimePatch
                runtimeCharacter = runtimePatch.applyTo(character)
                runtimeAuthorNote = runtimePatch.resolveAuthorNote(authorNote)
                continue
            }

            for (effect in trigger.effects) {
                when (effect["type"]?.toString()) {
                    "setvar" -> {
                        val key = parse(effect["var"])
                        val value = parse(effect["value"])
                        val current = getVar(key).toDoubleOrNull() ?: 0.0
                        vars[key] = when (effect["operator"]?.toString()) {
                            "+=" -> numberString(current + (value.toDoubleOrNull() ?: Double.NaN))
                            "-=" -> numberString(current - (value.toDoubleOrNull() ?: Double.NaN))
                            "*=" -> numberString(current * (value.toDoubleOrNull() ?: Double.NaN))
                            "/=" -> numberString(current / (value.toDoubleOrNull() ?: Double.NaN))
                            else -> value
                        }
                    }
                    "systemprompt" -> {
                        val value = parse(effect["value"]) + "\n\n"
                        prompt = when (effect["location"]?.toString()) {
                            "start" -> prompt.copy(start = prompt.start + value)
                            "historyend" -> prompt.copy(historyEnd = prompt.historyEnd + value)
                            "promptend" -> prompt.copy(promptEnd = prompt.promptEnd + value)
                            else -> prompt
                        }
                    }
                    "impersonate" -> {
                        val role = if (effect["role"]?.toString() == "user") "user" else "char"
                        working += MessageRecord(
                            id = UUID.randomUUID().toString(),
                            chatId = chatId,
                            role = role,
                            data = parse(effect["value"]),
                            time = System.currentTimeMillis(),
                        )
                    }
                    "modifychat" -> {
                        val index = parse(effect["index"]).toDoubleOrNull()?.toInt() ?: -1
                        if (index in working.indices) {
                            working[index] = working[index].copy(data = parse(effect["value"]))
                        }
                    }
                    "cutchat" -> {
                        val size = working.size
                        val start = sliceIndex(parse(effect["start"]), size)
                        val end = sliceIndex(parse(effect["end"]), size)
                        val sliced = if (start < end) working.subList(start, end).toList() else emptyList()
                        working.clear()
                        working += sliced
                    }
                    "stop", "v2StopPromptSending" -> stop = true
                    "runtrigger" -> if (recursion < MAX_RECURSION || trigger.lowLevelAccess) {
                        val nested = run(
                            mode = "manual",
                            settings = settings,
                            character = character,
                            messages = working,
                            variables = vars,
                            chatId = chatId,
                            authorNote = authorNote,
                            greetingIndex = greetingIndex,
                            recursion = recursion + 1,
                            manualName = effect["value"]?.toString().orEmpty(),
                            inheritedPrompt = prompt,
                            inheritedStop = stop,
                            inheritedPatch = runtimePatch,
                        )
                        working.clear(); working += nested.messages
                        vars.clear(); vars.putAll(nested.variables)
                        prompt = nested.promptInjection
                        stop = nested.stopSending
                        runtimePatch = nested.runtimePatch
                        runtimeCharacter = runtimePatch.applyTo(character)
                        runtimeAuthorNote = runtimePatch.resolveAuthorNote(authorNote)
                    }
                }
            }
        }
        return NativeTriggerResult(working, vars, prompt, stop, runtimePatch)
    }

    private fun passes(
        trigger: TriggerScript,
        messages: List<MessageRecord>,
        parse: (Any?) -> String,
        getVar: (String) -> String,
    ): Boolean {
        for (condition in trigger.conditions) {
            val type = condition["type"]?.toString().orEmpty()
            if (type == "exists") {
                val depth = (condition["depth"] as? Number)?.toInt() ?: 0
                val scoped = if (depth <= 0) messages else messages.takeLast(depth)
                val haystack = scoped.joinToString(" ") { it.data }
                val value = parse(condition["value"])
                val matched = when (condition["type2"]?.toString()) {
                    "strict" -> haystack.split(" ").contains(value)
                    "regex" -> runCatching { Regex(value).containsMatchIn(haystack) }.getOrDefault(false)
                    else -> haystack.contains(value, ignoreCase = true)
                }
                if (!matched) return false
                continue
            }

            val left = when (type) {
                "var" -> getVar(condition["var"]?.toString().orEmpty())
                "chatindex" -> messages.size.toString()
                "value" -> condition["var"]?.toString().orEmpty()
                else -> continue
            }.let(parse)
            val right = parse(condition["value"])
            val matched = when (condition["operator"]?.toString()) {
                "true" -> left == "true" || left == "1"
                "=" -> left == right
                "!=" -> left != right
                ">" -> number(left) > number(right)
                "<" -> number(left) < number(right)
                ">=" -> number(left) >= number(right)
                "<=" -> number(left) <= number(right)
                "null" -> left == "null"
                else -> false
            }
            if (!matched) return false
        }
        return true
    }

    private fun sliceIndex(value: String, size: Int): Int {
        val number = if (value.isBlank()) 0.0 else value.toDoubleOrNull() ?: 0.0
        val integer = when {
            number.isNaN() -> 0
            number >= Int.MAX_VALUE -> Int.MAX_VALUE
            number <= Int.MIN_VALUE -> Int.MIN_VALUE
            else -> number.toInt()
        }
        return if (integer < 0) (size + integer).coerceAtLeast(0) else integer.coerceAtMost(size)
    }

    private fun number(value: String): Double = value.toDoubleOrNull() ?: Double.NaN
    private fun numberString(value: Double): String = when {
        value.isNaN() -> "NaN"
        value.isInfinite() -> if (value > 0) "Infinity" else "-Infinity"
        value % 1.0 == 0.0 -> value.toLong().toString()
        else -> value.toString()
    }
}
