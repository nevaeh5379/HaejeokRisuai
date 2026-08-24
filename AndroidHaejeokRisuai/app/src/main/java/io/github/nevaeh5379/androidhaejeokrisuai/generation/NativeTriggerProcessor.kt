package io.github.nevaeh5379.androidhaejeokrisuai.generation

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
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
    ): NativeTriggerResult {
        if (character.triggerScripts.isEmpty()) {
            return NativeTriggerResult(messages, variables, inheritedPrompt, inheritedStop)
        }
        val working = messages.toMutableList()
        val vars = variables.toMutableMap()
        var prompt = inheritedPrompt
        var stop = inheritedStop

        fun context() = NativeRisuParserContext(
            settings = settings,
            character = character,
            history = working,
            authorNote = authorNote,
            greetingIndex = greetingIndex,
            variables = vars,
        )
        fun parse(value: Any?): String = NativeRisuParser.parse(value?.toString().orEmpty(), context())
        fun getVar(key: String): String = NativeRisuParser.parse("{{getvar::$key}}", context())

        for (trigger in character.triggerScripts) {
            if (manualName != null) {
                if (trigger.comment != manualName) continue
            } else if (trigger.type != mode) continue
            if (!passes(trigger, working, ::parse, ::getVar)) continue

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
                    "stop", "v2StopPromptSending" -> stop = true
                    "runtrigger" -> if (recursion < MAX_RECURSION) {
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
                        )
                        working.clear(); working += nested.messages
                        vars.clear(); vars.putAll(nested.variables)
                        prompt = nested.promptInjection
                        stop = nested.stopSending
                    }
                    // cutchat needs message deletion/reindex persistence and is handled in the next storage stage.
                }
            }
        }
        return NativeTriggerResult(working, vars, prompt, stop)
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

    private fun number(value: String): Double = value.toDoubleOrNull() ?: Double.NaN
    private fun numberString(value: Double): String = when {
        value.isNaN() -> "NaN"
        value.isInfinite() -> if (value > 0) "Infinity" else "-Infinity"
        value % 1.0 == 0.0 -> value.toLong().toString()
        else -> value.toString()
    }
}
