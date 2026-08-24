package io.github.nevaeh5379.androidhaejeokrisuai.generation

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.TriggerScript
import java.util.UUID

internal data class NativeTriggerV2Result(
    val messages: List<MessageRecord>,
    val variables: Map<String, String>,
    val promptInjection: NativeTriggerPromptInjection,
    val stopSending: Boolean,
)

internal object NativeTriggerV2Processor {
    fun run(
        trigger: TriggerScript,
        settings: GenerationSettings,
        character: CharacterProfile,
        messages: List<MessageRecord>,
        variables: Map<String, String>,
        chatId: String,
        authorNote: String,
        greetingIndex: Int,
        inheritedPrompt: NativeTriggerPromptInjection,
        inheritedStop: Boolean,
        runManual: (String, List<MessageRecord>, Map<String, String>, NativeTriggerPromptInjection, Boolean) -> NativeTriggerResult,
    ): NativeTriggerV2Result {
        val working = messages.toMutableList()
        val persistent = variables.toMutableMap()
        val locals = mutableMapOf<Int, MutableMap<String, String>>()
        val loopCounters = mutableMapOf<Int, Int>()
        var prompt = inheritedPrompt
        var stopSending = inheritedStop
        var currentIndent = 0
        var pc = 0
        var steps = 0

        fun context() = NativeRisuParserContext(
            settings = settings,
            character = character,
            history = working,
            authorNote = authorNote,
            greetingIndex = greetingIndex,
            variables = persistent,
        )
        fun parse(value: Any?): String = NativeRisuParser.parse(value?.toString().orEmpty(), context())
        fun getLocal(key: String): String? {
            for (indent in currentIndent downTo 0) locals[indent]?.get(key)?.let { return it }
            return null
        }
        fun getVar(key: String): String = getLocal(key)
            ?: NativeRisuParser.parse("{{getvar::$key}}", context())
        fun setVar(key: String, value: String) {
            for (indent in currentIndent downTo 0) {
                val scope = locals[indent]
                if (scope?.containsKey(key) == true) {
                    scope[key] = value
                    return
                }
            }
            persistent[key] = value
        }
        fun declareLocal(key: String, value: String, indent: Int) {
            locals.getOrPut(indent) { mutableMapOf() }[key] = value
        }
        fun clearLocals(indent: Int) {
            locals.keys.filter { it >= indent }.toList().forEach(locals::remove)
        }
        fun resolve(value: Any?, type: Any?): String {
            val parsed = parse(value)
            return if (type?.toString() == "var") getVar(parsed) else parsed
        }
        fun returnResult() = NativeTriggerV2Result(
            working.toList(), persistent.toMap(), prompt, stopSending,
        )

        val effects = trigger.effects
        fun endIndex(from: Int, indent: Int): Int? {
            for (index in from until effects.size) {
                val effect = effects[index]
                if (effect["type"]?.toString() != "v2EndIndent") continue
                if ((effect["indent"] as? Number)?.toInt() != indent) continue
                return index
            }
            return null
        }
        fun loopStart(from: Int, indent: Int): Int? {
            for (index in from downTo 0) {
                val effect = effects[index]
                val type = effect["type"]?.toString()
                if (type !in setOf("v2Loop", "v2LoopNTimes")) continue
                if ((effect["indent"] as? Number)?.toInt() == indent) return index
            }
            return null
        }

        while (pc < effects.size) {
            check(++steps <= 100_000) { "Risu trigger V2 exceeded the native execution safety limit" }
            val effect = effects[pc]
            val type = effect["type"]?.toString().orEmpty()
            currentIndent = (effect["indent"] as? Number)?.toInt() ?: 0
            when (type) {
                "v2Header", "v2Loop", "v2LoopNTimes" -> pc++
                "v2SetVar" -> {
                    val key = parse(effect["var"])
                    val value = resolve(effect["value"], effect["valueType"])
                    val original = jsNumber(getVar(key)).let { if (it.isNaN()) 0.0 else it }
                    val incoming = jsNumber(value)
                    val result = when (effect["operator"]?.toString()) {
                        "+=" -> jsNumberString(original + incoming)
                        "-=" -> jsNumberString(original - incoming)
                        "*=" -> jsNumberString(original * incoming)
                        "/=" -> jsNumberString(original / incoming)
                        "%=" -> jsNumberString(original % incoming)
                        else -> value
                    }
                    setVar(key, result)
                    pc++
                }
                "v2DeclareLocalVar" -> {
                    declareLocal(
                        parse(effect["var"]),
                        resolve(effect["value"], effect["valueType"]),
                        currentIndent,
                    )
                    pc++
                }
                "v2If", "v2IfAdvanced" -> {
                    val source = if (type == "v2If") getVar(parse(effect["source"]))
                        else resolve(effect["source"], effect["sourceType"])
                    val target = resolve(effect["target"], effect["targetType"])
                    if (compare(source, target, effect["condition"]?.toString().orEmpty())) {
                        pc++
                    } else {
                        val end = endIndex(pc, currentIndent + 1)
                        if (end == null) {
                            pc = effects.size
                        } else {
                            val next = effects.getOrNull(end + 1)
                            val hasElse = next?.get("type")?.toString() == "v2Else" &&
                                (next["indent"] as? Number)?.toInt() == currentIndent
                            pc = if (hasElse) end + 2 else end + 1
                        }
                    }
                }
                "v2Else" -> {
                    val end = endIndex(pc, currentIndent + 1)
                    pc = if (end == null) effects.size else end + 1
                }
                "v2EndIndent" -> {
                    clearLocals(currentIndent)
                    if (effect["endOfLoop"] == true) {
                        val loop = loopStart(pc, currentIndent - 1)
                        if (loop == null) {
                            pc++
                        } else if (effects[loop]["type"]?.toString() == "v2Loop") {
                            pc = loop + 1
                        } else {
                            val target = resolve(effects[loop]["value"], effects[loop]["valueType"])
                            val limit = jsNumber(target).let { if (it.isNaN()) 0.0 else it }
                            val count = (loopCounters[loop] ?: 0) + 1
                            loopCounters[loop] = count
                            pc = if (count >= limit) pc + 1 else loop + 1
                        }
                    } else pc++
                }
                "v2BreakLoop" -> {
                    var end: Int? = null
                    for (index in pc until effects.size) {
                        val candidate = effects[index]
                        if (candidate["type"]?.toString() == "v2EndIndent" && candidate["endOfLoop"] == true) {
                            end = index
                            break
                        }
                    }
                    pc = if (end == null) effects.size else end + 1
                }
                "v2RunTrigger" -> {
                    val nested = runManual(
                        effect["target"]?.toString().orEmpty(),
                        working.toList(), persistent.toMap(), prompt, stopSending,
                    )
                    working.clear(); working += nested.messages
                    persistent.clear(); persistent.putAll(nested.variables)
                    prompt = nested.promptInjection
                    stopSending = nested.stopSending
                    pc++
                }
                "v2ConsoleLog" -> {
                    resolve(effect["source"], effect["sourceType"])
                    pc++
                }
                "v2StopTrigger" -> return returnResult()
                "v2StopPromptSending" -> {
                    stopSending = true
                    pc++
                }
                "v2CutChat" -> {
                    val size = working.size
                    val startRaw = resolve(effect["start"], effect["startType"])
                    val endRaw = resolve(effect["end"], effect["endType"])
                    val start = jsSliceIndex(startRaw, size, 0)
                    val end = jsSliceIndex(endRaw, size, size)
                    val selected = if (start < end) working.subList(start, end).toList() else emptyList()
                    working.clear(); working += selected
                    pc++
                }
                "v2ModifyChat" -> {
                    val index = jsArrayIndex(resolve(effect["index"], effect["indexType"]))
                    if (index in working.indices) {
                        working[index] = working[index].copy(
                            data = resolve(effect["value"], effect["valueType"]),
                        )
                    }
                    pc++
                }
                "v2SystemPrompt" -> {
                    val value = resolve(effect["value"], effect["valueType"]) + "\n\n"
                    prompt = when (effect["location"]?.toString()) {
                        "start" -> prompt.copy(start = prompt.start + value)
                        "historyend" -> prompt.copy(historyEnd = prompt.historyEnd + value)
                        "promptend" -> prompt.copy(promptEnd = prompt.promptEnd + value)
                        else -> prompt
                    }
                    pc++
                }
                "v2Impersonate" -> {
                    val role = if (effect["role"]?.toString() == "user") "user" else "char"
                    working += MessageRecord(
                        id = UUID.randomUUID().toString(),
                        chatId = chatId,
                        role = role,
                        data = resolve(effect["value"], effect["valueType"]),
                        time = System.currentTimeMillis(),
                    )
                    pc++
                }
                else -> pc++
            }
        }
        return returnResult()
    }

    private fun compare(source: String, target: String, operator: String): Boolean {
        val sourceNumber = jsNumber(source)
        val targetNumber = jsNumber(target)
        return when (operator) {
            "=" -> if (!sourceNumber.isNaN() && !targetNumber.isNaN()) sourceNumber == targetNumber else source == target
            "!=" -> if (!sourceNumber.isNaN() && !targetNumber.isNaN()) sourceNumber != targetNumber else source != target
            ">" -> sourceNumber > targetNumber
            "<" -> sourceNumber < targetNumber
            ">=" -> sourceNumber >= targetNumber
            "<=" -> sourceNumber <= targetNumber
            "∈" -> NativeRisuParser.jsonArrayContains(target, source) ?: false
            "∋" -> NativeRisuParser.jsonArrayContains(source, target) ?: false
            "∉" -> !(NativeRisuParser.jsonArrayContains(target, source) ?: false)
            "∌" -> !(NativeRisuParser.jsonArrayContains(source, target) ?: false)
            "≒" -> if (sourceNumber.isNaN() || targetNumber.isNaN()) {
                source.lowercase().replace(" ", "") == target.lowercase().replace(" ", "")
            } else kotlin.math.abs(sourceNumber - targetNumber) < 0.0001
            "≡" -> when (target) {
                "true" -> source == "true" || source == "1"
                "false" -> source != "true" && source != "1"
                else -> source == target
            }
            else -> false
        }
    }

    private fun jsNumber(value: String): Double {
        val normalized = value.trim()
        if (normalized.isEmpty()) return 0.0
        return normalized.toDoubleOrNull() ?: Double.NaN
    }

    private fun jsNumberString(value: Double): String = when {
        value.isNaN() -> "NaN"
        value == Double.POSITIVE_INFINITY -> "Infinity"
        value == Double.NEGATIVE_INFINITY -> "-Infinity"
        value == 0.0 -> "0"
        value.isFinite() && value % 1.0 == 0.0 -> value.toLong().toString()
        else -> value.toString()
    }

    private fun jsArrayIndex(value: String): Int {
        val number = jsNumber(value)
        if (!number.isFinite() || number % 1.0 != 0.0) return -1
        if (number < Int.MIN_VALUE || number > Int.MAX_VALUE) return -1
        return number.toInt()
    }

    private fun jsSliceIndex(value: String, size: Int, fallback: Int): Int {
        val number = jsNumber(value)
        if (number.isNaN()) return fallback
        val integer = when {
            number == Double.POSITIVE_INFINITY -> Int.MAX_VALUE
            number == Double.NEGATIVE_INFINITY -> Int.MIN_VALUE
            number > Int.MAX_VALUE -> Int.MAX_VALUE
            number < Int.MIN_VALUE -> Int.MIN_VALUE
            else -> number.toInt()
        }
        return if (integer < 0) (size + integer).coerceAtLeast(0) else integer.coerceAtMost(size)
    }
}
