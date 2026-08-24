package io.github.nevaeh5379.androidhaejeokrisuai.generation

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.RuntimeStatePatch
import io.github.nevaeh5379.androidhaejeokrisuai.data.TriggerScript
import java.util.UUID

internal data class NativeTriggerV2Result(
    val messages: List<MessageRecord>,
    val variables: Map<String, String>,
    val promptInjection: NativeTriggerPromptInjection,
    val stopSending: Boolean,
    val runtimePatch: RuntimeStatePatch,
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
        inheritedPatch: RuntimeStatePatch,
        runManual: (String, List<MessageRecord>, Map<String, String>, NativeTriggerPromptInjection, Boolean, RuntimeStatePatch) -> NativeTriggerResult,
    ): NativeTriggerV2Result {
        val working = messages.toMutableList()
        val persistent = variables.toMutableMap()
        val locals = mutableMapOf<Int, MutableMap<String, String>>()
        val loopCounters = mutableMapOf<Int, Int>()
        var prompt = inheritedPrompt
        var stopSending = inheritedStop
        var runtimePatch = inheritedPatch
        var runtimeCharacter = runtimePatch.applyTo(character)
        var runtimeAuthorNote = runtimePatch.resolveAuthorNote(authorNote)
        var currentIndent = 0
        var pc = 0
        var steps = 0

        fun context() = NativeRisuParserContext(
            settings = settings,
            character = runtimeCharacter,
            history = working,
            authorNote = runtimeAuthorNote,
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
            working.toList(), persistent.toMap(), prompt, stopSending, runtimePatch,
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
                        working.toList(), persistent.toMap(), prompt, stopSending, runtimePatch,
                    )
                    working.clear(); working += nested.messages
                    persistent.clear(); persistent.putAll(nested.variables)
                    prompt = nested.promptInjection
                    stopSending = nested.stopSending
                    runtimePatch = nested.runtimePatch
                    runtimeCharacter = runtimePatch.applyTo(character)
                    runtimeAuthorNote = runtimePatch.resolveAuthorNote(authorNote)
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
                "v2GetLastMessage" -> {
                    setVar(parse(effect["outputVar"]), working.lastOrNull()?.data ?: "null")
                    pc++
                }
                "v2GetMessageAtIndex" -> {
                    val index = jsArrayIndex(resolve(effect["index"], effect["indexType"]))
                    setVar(parse(effect["outputVar"]), working.getOrNull(index)?.data ?: "null")
                    pc++
                }
                "v2GetMessageCount" -> {
                    setVar(parse(effect["outputVar"]), working.size.toString())
                    pc++
                }
                "v2GetLastUserMessage" -> {
                    setVar(parse(effect["outputVar"]), working.asReversed().firstOrNull { it.role == "user" }?.data ?: "null")
                    pc++
                }
                "v2GetLastCharMessage" -> {
                    setVar(parse(effect["outputVar"]), working.asReversed().firstOrNull { it.role == "char" }?.data ?: "null")
                    pc++
                }
                "v2GetFirstMessage" -> {
                    val first = if (greetingIndex == -1) runtimeCharacter.firstMessage
                        else runtimeCharacter.alternateGreetings.getOrNull(greetingIndex) ?: "null"
                    setVar(parse(effect["outputVar"]), first)
                    pc++
                }
                "v2Random" -> {
                    val min = jsNumber(resolve(effect["min"], effect["minType"]))
                    val max = jsNumber(resolve(effect["max"], effect["maxType"]))
                    val value = kotlin.math.floor(Math.random() * (max - min + 1.0) + min)
                    setVar(parse(effect["outputVar"]), jsNumberString(value))
                    pc++
                }
                "v2GetCharAt" -> {
                    val source = resolve(effect["source"], effect["sourceType"])
                    val index = jsArrayIndex(resolve(effect["index"], effect["indexType"]))
                    setVar(parse(effect["outputVar"]), source.getOrNull(index)?.toString() ?: "null")
                    pc++
                }
                "v2GetCharCount" -> {
                    setVar(parse(effect["outputVar"]), resolve(effect["source"], effect["sourceType"]).length.toString())
                    pc++
                }
                "v2ToLowerCase" -> {
                    setVar(parse(effect["outputVar"]), resolve(effect["source"], effect["sourceType"]).lowercase())
                    pc++
                }
                "v2ToUpperCase" -> {
                    setVar(parse(effect["outputVar"]), resolve(effect["source"], effect["sourceType"]).uppercase())
                    pc++
                }
                "v2ConcatString" -> {
                    val left = resolve(effect["source1"], effect["source1Type"])
                    val right = resolve(effect["source2"], effect["source2Type"])
                    setVar(parse(effect["outputVar"]), left + right)
                    pc++
                }
                "v2SetCharAt" -> {
                    val source = resolve(effect["source"], effect["sourceType"])
                    val index = jsArrayIndex(resolve(effect["index"], effect["indexType"]))
                    val value = resolve(effect["value"], effect["valueType"])
                    val chars = source.codePoints().toArray().map { String(Character.toChars(it)) }.toMutableList()
                    if (index >= 0) {
                        while (chars.size < index) chars += ""
                        if (index < chars.size) chars[index] = value else if (index == chars.size) chars += value
                    }
                    setVar(parse(effect["outputVar"]), chars.joinToString(""))
                    pc++
                }
                "v2SplitString" -> {
                    val source = resolve(effect["source"], effect["sourceType"])
                    val delimiter = if (effect["delimiterType"]?.toString() == "var")
                        getVar(parse(effect["delimiter"])) else parse(effect["delimiter"])
                    val parts = if (effect["delimiterType"]?.toString() == "regex")
                        splitRegex(source, delimiter) else splitLiteral(source, delimiter)
                    setVar(parse(effect["outputVar"]), NativeRisuParser.stringifyJson(parts))
                    pc++
                }
                "v2JoinArrayVar" -> {
                    val raw = resolve(effect["var"], effect["varType"])
                    val delimiter = resolve(effect["delimiter"], effect["delimiterType"])
                    val arr = NativeRisuParser.parseJsonArray(raw)
                    val joined = arr?.joinToString(delimiter) { jsJoinValue(it) } ?: ""
                    setVar(parse(effect["outputVar"]), joined)
                    pc++
                }
                "v2MakeArrayVar" -> {
                    val key = parse(effect["var"])
                    if (key.startsWith("[") && key.endsWith("]")) return returnResult()
                    setVar(key, "[]")
                    pc++
                }
                "v2GetArrayVarLength" -> {
                    val key = parse(effect["var"])
                    val size = NativeRisuParser.parseJsonArray(getVar(key))?.size ?: 0
                    setVar(parse(effect["outputVar"]), size.toString())
                    pc++
                }
                "v2GetArrayVar" -> {
                    val key = parse(effect["var"])
                    val arr = NativeRisuParser.parseJsonArray(getVar(key))
                    val index = jsArrayIndex(resolve(effect["index"], effect["indexType"]))
                    setVar(parse(effect["outputVar"]), arr?.getOrNull(index)?.let(NativeRisuParser::jsonValueString) ?: "null")
                    pc++
                }
                "v2SetArrayVar" -> {
                    val key = parse(effect["var"])
                    val arr = NativeRisuParser.parseJsonArray(getVar(key))
                    val index = jsArrayIndex(resolve(effect["index"], effect["indexType"]))
                    if (arr != null && index >= 0) {
                        while (arr.size < index) arr += null
                        val value = resolve(effect["value"], effect["valueType"])
                        if (index < arr.size) arr[index] = value else arr += value
                        setVar(key, NativeRisuParser.stringifyJson(arr))
                    }
                    pc++
                }
                "v2PushArrayVar", "v2UnshiftArrayVar" -> {
                    val key = parse(effect["var"])
                    val arr = NativeRisuParser.parseJsonArray(getVar(key))
                    if (arr == null) setVar(key, "[]") else {
                        val value = resolve(effect["value"], effect["valueType"])
                        if (type == "v2PushArrayVar") arr += value else arr.add(0, value)
                        setVar(key, NativeRisuParser.stringifyJson(arr))
                    }
                    pc++
                }
                "v2PopArrayVar", "v2ShiftArrayVar" -> {
                    val key = parse(effect["var"])
                    val arr = NativeRisuParser.parseJsonArray(getVar(key))
                    if (arr == null) {
                        setVar(key, "[]")
                        setVar(parse(effect["outputVar"]), "null")
                    } else {
                        val removed = if (arr.isEmpty()) null else if (type == "v2PopArrayVar") arr.removeAt(arr.lastIndex) else arr.removeAt(0)
                        setVar(parse(effect["outputVar"]), removed?.let(NativeRisuParser::jsonValueString) ?: "null")
                        setVar(key, NativeRisuParser.stringifyJson(arr))
                    }
                    pc++
                }
                "v2SpliceArrayVar" -> {
                    val key = parse(effect["var"])
                    val arr = NativeRisuParser.parseJsonArray(getVar(key))
                    if (arr == null) setVar(key, "[]") else {
                        val start = jsSliceIndex(resolve(effect["start"], effect["startType"]), arr.size, 0)
                        arr.add(start, resolve(effect["item"], effect["itemType"]))
                        setVar(key, NativeRisuParser.stringifyJson(arr))
                    }
                    pc++
                }
                "v2SliceArrayVar" -> {
                    val key = parse(effect["var"])
                    val arr = NativeRisuParser.parseJsonArray(getVar(key))
                    if (arr == null) {
                        setVar(parse(effect["outputVar"]), "[]")
                    } else {
                        val start = jsSliceIndex(resolve(effect["start"], effect["startType"]), arr.size, 0)
                        val end = jsSliceIndex(resolve(effect["end"], effect["endType"]), arr.size, 0)
                        val sliced = if (start < end) arr.subList(start, end).toList() else emptyList()
                        setVar(parse(effect["outputVar"]), NativeRisuParser.stringifyJson(sliced))
                    }
                    pc++
                }
                "v2GetIndexOfValueInArrayVar" -> {
                    val key = parse(effect["var"])
                    val value = resolve(effect["value"], effect["valueType"])
                    val arr = NativeRisuParser.parseJsonArray(getVar(key))
                    val index = arr?.indexOfFirst { it is String && it == value } ?: -1
                    setVar(parse(effect["outputVar"]), index.toString())
                    pc++
                }
                "v2RemoveIndexFromArrayVar" -> {
                    val key = parse(effect["var"])
                    val arr = NativeRisuParser.parseJsonArray(getVar(key))
                    if (arr == null) setVar(key, "[]") else {
                        val indexRaw = resolve(effect["index"], effect["indexType"])
                        val index = jsSpliceIndex(indexRaw, arr.size)
                        if (index in arr.indices) arr.removeAt(index)
                        setVar(key, NativeRisuParser.stringifyJson(arr))
                    }
                    pc++
                }
                "v2GetCharacterDesc" -> {
                    setVar(parse(effect["outputVar"]), runtimeCharacter.description)
                    pc++
                }
                "v2SetCharacterDesc" -> {
                    val value = resolve(effect["value"], effect["valueType"])
                    runtimePatch = runtimePatch.copy(characterDescription = value)
                    runtimeCharacter = runtimePatch.applyTo(character)
                    pc++
                }
                "v2GetReplaceGlobalNote" -> {
                    setVar(parse(effect["outputVar"]), runtimeCharacter.replaceGlobalNote)
                    pc++
                }
                "v2SetReplaceGlobalNote" -> {
                    val value = resolve(effect["value"], effect["valueType"])
                    runtimePatch = runtimePatch.copy(replaceGlobalNote = value)
                    runtimeCharacter = runtimePatch.applyTo(character)
                    pc++
                }
                "v2GetAuthorNote" -> {
                    setVar(parse(effect["outputVar"]), runtimeAuthorNote)
                    pc++
                }
                "v2SetAuthorNote" -> {
                    val value = resolve(effect["value"], effect["valueType"])
                    runtimePatch = runtimePatch.copy(authorNote = value)
                    runtimeAuthorNote = runtimePatch.resolveAuthorNote(authorNote)
                    pc++
                }
                "v2MakeDictVar" -> {
                    val key = parse(effect["var"])
                    if (key.startsWith("{") && key.endsWith("}")) return returnResult()
                    setVar(key, "{}")
                    pc++
                }
                "v2GetDictVar" -> {
                    val dict = NativeRisuParser.parseJsonObject(resolve(effect["var"], effect["varType"]))
                    val key = resolve(effect["key"], effect["keyType"])
                    setVar(parse(effect["outputVar"]), dict?.get(key)?.let(NativeRisuParser::jsonValueString) ?: "null")
                    pc++
                }
                "v2SetDictVar" -> {
                    if (effect["varType"]?.toString() == "var") {
                        val variable = parse(effect["var"])
                        val dict = NativeRisuParser.parseJsonObject(getVar(variable)) ?: linkedMapOf()
                        dict[resolve(effect["key"], effect["keyType"])] = resolve(effect["value"], effect["valueType"])
                        setVar(variable, NativeRisuParser.stringifyJson(dict))
                    }
                    pc++
                }
                "v2DeleteDictKey" -> {
                    if (effect["varType"]?.toString() == "var") {
                        val variable = parse(effect["var"])
                        val dict = NativeRisuParser.parseJsonObject(getVar(variable))
                        if (dict == null) setVar(variable, "{}") else {
                            dict.remove(resolve(effect["key"], effect["keyType"]))
                            setVar(variable, NativeRisuParser.stringifyJson(dict))
                        }
                    }
                    pc++
                }
                "v2HasDictKey" -> {
                    val dict = NativeRisuParser.parseJsonObject(resolve(effect["var"], effect["varType"]))
                    val key = resolve(effect["key"], effect["keyType"])
                    setVar(parse(effect["outputVar"]), if (dict?.containsKey(key) == true) "1" else "0")
                    pc++
                }
                "v2ClearDict" -> {
                    val key = parse(effect["var"])
                    if (key.startsWith("{") && key.endsWith("}")) return returnResult()
                    setVar(key, "{}")
                    pc++
                }
                "v2GetDictSize" -> {
                    val size = NativeRisuParser.parseJsonObject(resolve(effect["var"], effect["varType"]))?.size ?: 0
                    setVar(parse(effect["outputVar"]), size.toString())
                    pc++
                }
                "v2GetDictKeys", "v2GetDictValues" -> {
                    val dict = NativeRisuParser.parseJsonObject(resolve(effect["var"], effect["varType"]))
                    val value = if (dict == null) emptyList() else if (type == "v2GetDictKeys") dict.keys.toList() else dict.values.toList()
                    setVar(parse(effect["outputVar"]), NativeRisuParser.stringifyJson(value))
                    pc++
                }
                "v2Calculate" -> {
                    val expression = resolve(effect["expression"], effect["expressionType"])
                    val result = runCatching { NativeRisuCalculator.calculate(expression, ::getVar) }.getOrDefault(0.0)
                    setVar(parse(effect["outputVar"]), jsNumberString(result))
                    pc++
                }
                "v2RegexTest" -> {
                    val value = resolve(effect["value"], effect["valueType"])
                    val pattern = resolve(effect["regex"], effect["regexType"])
                    val flags = resolve(effect["flags"], effect["flagsType"])
                    val matched = runCatching { findJsRegex(value, pattern, flags) != null }.getOrDefault(false)
                    setVar(parse(effect["outputVar"]), if (matched) "1" else "0")
                    pc++
                }
                "v2ExtractRegex" -> {
                    val value = resolve(effect["value"], effect["valueType"])
                    val pattern = resolve(effect["regex"], effect["regexType"])
                    val flags = resolve(effect["flags"], effect["flagsType"])
                    val format = resolve(effect["result"], effect["resultType"])
                    val result = runCatching {
                        expandRegexTemplate(format, findJsRegex(value, pattern, flags))
                    }.getOrElse { expandRegexTemplate(format, null) }
                    setVar(parse(effect["outputVar"]), result)
                    pc++
                }
                "v2ReplaceString" -> {
                    val source = resolve(effect["source"], effect["sourceType"])
                    val pattern = resolve(effect["regex"], effect["regexType"])
                    val format = resolve(effect["result"], effect["resultType"])
                    val replacement = resolve(effect["replacement"], effect["replacementType"])
                    val flags = resolve(effect["flags"], effect["flagsType"])
                    val result = runCatching {
                        replaceJsRegex(source, pattern, flags) { match ->
                            val target = Regex("^\\$(\\d+)$").matchEntire(format)?.groupValues?.get(1)?.toIntOrNull()
                            if (target == 0) replacement
                            else if (target != null) {
                                val group = match.groups[target]?.value
                                if (group.isNullOrEmpty()) expandRegexTemplate(format, match)
                                else match.value.replaceFirst(group, replacement)
                            } else expandRegexTemplate(format, match)
                        }
                    }.getOrDefault(source)
                    setVar(parse(effect["outputVar"]), result)
                    pc++
                }
                else -> pc++
            }
        }
        return returnResult()
    }

    private fun splitLiteral(source: String, delimiter: String): List<Any?> {
        if (delimiter.isEmpty()) return source.map { it.toString() }
        val result = mutableListOf<Any?>()
        var start = 0
        while (true) {
            val index = source.indexOf(delimiter, start)
            if (index < 0) {
                result += source.substring(start)
                return result
            }
            result += source.substring(start, index)
            start = index + delimiter.length
        }
    }

    private fun splitRegex(source: String, delimiter: String): List<Any?> = runCatching {
        val wrapped = Regex("^/(.+)/([gimuy]*)$").matchEntire(delimiter)
        val pattern = wrapped?.groupValues?.get(1) ?: delimiter
        val flags = wrapped?.groupValues?.get(2).orEmpty()
        val regex = compileJsRegex(pattern, flags)
        val result = mutableListOf<Any?>()
        var end = 0
        for (match in regex.findAll(source)) {
            result += source.substring(end, match.range.first)
            for (index in 1 until match.groups.size) result += match.groups[index]?.value
            end = match.range.last + 1
        }
        result += source.substring(end)
        result
    }.getOrElse { listOf(source) }

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

    private fun compileJsRegex(pattern: String, flags: String): Regex {
        val options = buildSet {
            if ('i' in flags) add(RegexOption.IGNORE_CASE)
            if ('m' in flags) add(RegexOption.MULTILINE)
            if ('s' in flags) add(RegexOption.DOT_MATCHES_ALL)
        }
        return Regex(pattern, options)
    }

    private fun findJsRegex(source: String, pattern: String, flags: String): MatchResult? {
        val match = compileJsRegex(pattern, flags).find(source) ?: return null
        return if ('y' !in flags || match.range.first == 0) match else null
    }

    private fun replaceJsRegex(
        source: String,
        pattern: String,
        flags: String,
        replacement: (MatchResult) -> String,
    ): String {
        val regex = compileJsRegex(pattern, flags)
        if ('y' in flags) {
            val match = regex.find(source) ?: return source
            if (match.range.first != 0) return source
            return replacement(match) + source.substring(match.range.last + 1)
        }
        if ('g' in flags) return regex.replace(source, replacement)
        val match = regex.find(source) ?: return source
        return source.substring(0, match.range.first) + replacement(match) + source.substring(match.range.last + 1)
    }

    private fun expandRegexTemplate(template: String, match: MatchResult?): String = template
        .replace(Regex("\\$[0-9]+")) { token ->
            val index = token.value.drop(1).toIntOrNull() ?: return@replace ""
            match?.groupValues?.getOrNull(index).orEmpty()
        }
        .replace("\$&", match?.value.orEmpty())
        .replace("\$\$", "\$")

    private fun jsJoinValue(value: Any?): String = when (value) {
        null -> ""
        is String -> value
        is Boolean -> value.toString()
        is Number -> jsNumberString(value.toDouble())
        is List<*> -> value.joinToString(",") { jsJoinValue(it) }
        else -> value.toString()
    }

    private fun jsSpliceIndex(value: String, size: Int): Int = jsSliceIndex(value, size, 0)

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
