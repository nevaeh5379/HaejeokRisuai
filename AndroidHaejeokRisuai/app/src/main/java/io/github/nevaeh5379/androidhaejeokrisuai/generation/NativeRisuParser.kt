package io.github.nevaeh5379.androidhaejeokrisuai.generation

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord

internal data class NativeRisuParserContext(
    val settings: GenerationSettings,
    val character: CharacterProfile,
    val history: List<MessageRecord> = emptyList(),
    val authorNote: String = "",
    val greetingIndex: Int = -1,
    val variables: Map<String, String> = emptyMap(),
    val slots: Map<String, String> = emptyMap(),
    val mutationVariables: MutableMap<String, String>? = null,
)

internal data class NativeRisuMutationResult(
    val text: String,
    val variables: Map<String, String>,
)

/**
 * A deliberately bounded, plugin-free subset of Risu's CBS parser.
 *
 * This covers the card/prompt constructs that materially change generation while
 * leaving mutation-oriented functions (setvar/addvar), plugin hooks and UI HTML
 * helpers to the full Risu runtime. Unknown constructs are preserved verbatim so
 * unsupported syntax is visible rather than silently changing prompt semantics.
 */
internal object NativeRisuParser {
    private const val MAX_DEPTH = 24
    private const val OPEN_SENTINEL = "\uE100"
    private const val CLOSE_SENTINEL = "\uE101"
    private val tokenRegex = Regex("\\{\\{([^{}]*)}}")

    fun parse(text: String, context: NativeRisuParserContext): String {
        val normalized = text
            .replace("<char>", context.character.name)
            .replace("<user>", context.settings.username)
        return restoreEscapes(render(normalized, context, 0))
    }

    fun parseMutating(text: String, context: NativeRisuParserContext): NativeRisuMutationResult {
        val variables = context.variables.toMutableMap()
        val parsed = parse(text, context.copy(mutationVariables = variables))
        return NativeRisuMutationResult(parsed, variables.toMap())
    }

    internal fun jsonArrayContains(text: String, needle: String): Boolean? =
        JsonLite.parseArray(text)?.any { value -> value is String && value == needle }

    internal fun parseJsonArray(text: String): MutableList<Any?>? =
        JsonLite.parseArray(text)?.toMutableList()

    internal fun stringifyJson(value: Any?): String = JsonLite.stringify(value)

    internal fun jsonValueString(value: Any?): String = JsonLite.slotString(value)

    private fun render(text: String, context: NativeRisuParserContext, depth: Int): String {
        if (text.isEmpty() || depth >= MAX_DEPTH) return evaluateInline(text, context)
        val opening = findNextBlockOpening(text) ?: return evaluateInline(text, context)
        val bounds = findBlockBounds(text, opening.end) ?: return evaluateInline(text, context)

        val result = StringBuilder()
        result.append(evaluateInline(text.substring(0, opening.start), context))
        val header = opening.content
        val bodyStart = opening.end
        val trueEnd = bounds.elseStart ?: bounds.closeStart
        val trueBody = text.substring(bodyStart, trueEnd)
        val falseBody = if (bounds.elseEnd != null) text.substring(bounds.elseEnd, bounds.closeStart) else ""
        result.append(renderBlock(header, trueBody, falseBody, context, depth + 1))
        result.append(render(text.substring(bounds.closeEnd), context, depth + 1))
        return result.toString()
    }

    private data class Tag(val start: Int, val end: Int, val content: String)

    private data class BlockBounds(
        val elseStart: Int?,
        val elseEnd: Int?,
        val closeStart: Int,
        val closeEnd: Int,
    )

    private fun findNextBlockOpening(text: String, from: Int = 0): Tag? {
        var cursor = from
        while (cursor < text.length) {
            val start = text.indexOf("{{#", cursor)
            if (start < 0) return null
            val tag = readTag(text, start) ?: return null
            if (isBlockName(tag.content.trim())) return tag
            cursor = start + 2
        }
        return null
    }

    private fun readTag(text: String, start: Int): Tag? {
        if (start < 0 || !text.startsWith("{{", start)) return null
        var level = 1
        var cursor = start + 2
        while (cursor < text.length - 1) {
            when {
                text.startsWith("{{", cursor) -> { level++; cursor += 2 }
                text.startsWith("}}", cursor) -> {
                    level--
                    if (level == 0) return Tag(start, cursor + 2, text.substring(start + 2, cursor))
                    cursor += 2
                }
                else -> cursor++
            }
        }
        return null
    }

    private fun findBlockBounds(text: String, searchStart: Int): BlockBounds? {
        var level = 1
        var elseStart: Int? = null
        var elseEnd: Int? = null
        var cursor = searchStart
        while (cursor < text.length) {
            val start = text.indexOf("{{", cursor)
            if (start < 0) return null
            val tag = readTag(text, start) ?: return null
            val token = tag.content.trim()
            if (token.startsWith("#") && isBlockName(token)) {
                level++
            } else if (token == "/" || token.startsWith("/")) {
                level--
                if (level == 0) return BlockBounds(elseStart, elseEnd, tag.start, tag.end)
            } else if (token == ":else" && level == 1 && elseStart == null) {
                elseStart = tag.start
                elseEnd = tag.end
            }
            cursor = tag.end
        }
        return null
    }

    private fun isBlockName(token: String): Boolean =
        token.startsWith("#when") || token.startsWith("#if") || token.startsWith("#if_pure") ||
            token.startsWith("#each") || token.startsWith("#pure") ||
            token.startsWith("#puredisplay") || token.startsWith("#escape")

    private fun renderBlock(
        headerRaw: String,
        trueBody: String,
        falseBody: String,
        context: NativeRisuParserContext,
        depth: Int,
    ): String {
        val header = evaluateInline(headerRaw, context)
        return when {
            header.startsWith("#if_pure ") -> {
                val condition = header.substringAfter("#if_pure ").substringBefore(' ')
                if (truthy(condition)) render(trueBody, context, depth) else render(falseBody, context, depth)
            }
            header.startsWith("#if") -> {
                val condition = header.substringAfter("#if", "").trimStart().substringBefore(' ')
                val body = if (truthy(condition)) trueBody else falseBody
                render(legacyWhitespace(body), context, depth)
            }
            header.startsWith("#when") -> {
                val condition = evaluateWhen(header, context)
                val selected = if (condition.value) trueBody else falseBody
                val normalized = when (condition.mode) {
                    WhenMode.KEEP -> selected
                    WhenMode.LEGACY -> legacyWhitespace(selected)
                    WhenMode.NORMAL -> selected.trim('\n', '\r')
                }
                render(normalized, context, depth)
            }
            header.startsWith("#each") -> renderEach(header, trueBody, context, depth)
            header.startsWith("#puredisplay") -> trueBody.trim()
            header.startsWith("#pure") -> trueBody.trim()
            header.startsWith("#escape") -> if (header.contains("::keep")) trueBody else trueBody.trim()
            else -> "{{${headerRaw}}}${trueBody}{{/}}"
        }
    }

    private enum class WhenMode { NORMAL, KEEP, LEGACY }
    private data class WhenResult(val value: Boolean, val mode: WhenMode)

    /** Mirrors Risu's stack/pop evaluation, including its intentionally right-to-left logical behavior. */
    private fun evaluateWhen(header: String, context: NativeRisuParserContext): WhenResult {
        if (header.startsWith("#when ")) {
            val state = header.split(" ", limit = 2).getOrElse(1) { "" }
            return WhenResult(truthy(state), WhenMode.NORMAL)
        }
        if (!header.startsWith("#when::")) return WhenResult(false, WhenMode.NORMAL)
        val statement = header.split("::").drop(1).toMutableList()
        if (statement.size == 1) return WhenResult(truthy(statement[0]), WhenMode.NORMAL)
        var mode = WhenMode.NORMAL
        while (statement.size > 1) {
            val condition = statement.removeAt(statement.lastIndex)
            val operator = statement.removeAt(statement.lastIndex)
            when (operator) {
                "not" -> statement += boolString(!truthy(condition))
                "keep" -> { mode = WhenMode.KEEP; statement += condition }
                "legacy" -> { mode = WhenMode.LEGACY; statement += condition }
                "and" -> statement += boolString(truthy(statement.removeAt(statement.lastIndex)) && truthy(condition))
                "or" -> statement += boolString(truthy(statement.removeAt(statement.lastIndex)) || truthy(condition))
                "is" -> statement += boolString(statement.removeAt(statement.lastIndex) == condition)
                "isnot" -> statement += boolString(statement.removeAt(statement.lastIndex) != condition)
                "var" -> statement += boolString(truthy(getVar(condition, context)))
                "toggle" -> statement += boolString(truthy(getGlobalVar("toggle_$condition", context)))
                "vis" -> statement += boolString(getVar(statement.removeAt(statement.lastIndex), context) == condition)
                "visnot" -> statement += boolString(getVar(statement.removeAt(statement.lastIndex), context) != condition)
                "tis" -> statement += boolString(getGlobalVar("toggle_${statement.removeAt(statement.lastIndex)}", context) == condition)
                "tisnot" -> statement += boolString(getGlobalVar("toggle_${statement.removeAt(statement.lastIndex)}", context) != condition)
                ">", "<", ">=", "<=" -> {
                    val left = statement.removeAt(statement.lastIndex).toDoubleOrNull()
                    val right = condition.toDoubleOrNull()
                    val matched = if (left == null || right == null) false else when (operator) {
                        ">" -> left > right
                        "<" -> left < right
                        ">=" -> left >= right
                        else -> left <= right
                    }
                    statement += boolString(matched)
                }
                else -> statement += boolString(truthy(condition))
            }
        }
        return WhenResult(truthy(statement.firstOrNull().orEmpty()), mode)
    }

    private fun renderEach(
        header: String,
        body: String,
        context: NativeRisuParserContext,
        depth: Int,
    ): String {
        var remainder = header.removePrefix("#each")
        val keep = remainder.startsWith("::keep")
        if (keep) remainder = remainder.removePrefix("::keep")
        remainder = remainder.trimStart()
        val variableMatch = Regex("\\s+(?:as\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*$").findAll(remainder).lastOrNull()
            ?: return evaluateInline(remainder, context)
        val variable = variableMatch.groupValues[1]
        val expression = evaluateInline(remainder.substring(0, variableMatch.range.first).trim(), context)
        val values = JsonLite.parseArray(expression) ?: return expression
        val template = if (keep) body else legacyWhitespace(body)
        return buildString {
            for (value in values) {
                val slot = JsonLite.slotString(value)
                append(render(template, context.copy(slots = context.slots + (variable to slot)), depth))
            }
        }
    }

    private fun evaluateInline(text: String, context: NativeRisuParserContext): String {
        var current = text
        repeat(MAX_DEPTH) {
            var changed = false
            current = tokenRegex.replace(current) { match ->
                val expression = match.groupValues[1]
                if (expression.startsWith("#") || expression.startsWith("/") || expression == ":else") {
                    return@replace match.value
                }
                val replacement = evaluateFunction(expression, context)
                if (replacement != null) {
                    changed = true
                    replacement
                } else match.value
            }
            if (!changed) return current
        }
        return current
    }

    private fun evaluateFunction(expression: String, context: NativeRisuParserContext): String? {
        val parts = expression.split("::")
        val name = parts.firstOrNull()?.trim()?.lowercase().orEmpty()
        val args = parts.drop(1).map { evaluateInline(it, context) }
        fun arg(index: Int) = args.getOrElse(index) { "" }
        return when (name) {
            "char", "bot" -> context.character.name
            "user" -> context.settings.username
            "personality", "charpersona" -> parseNested(context.character.personality, context)
            "description", "chardesc" -> parseNested(context.character.description, context)
            "scenario" -> parseNested(context.character.scenario, context)
            "exampledialogue", "examplemessage", "example_dialogue" -> parseNested(context.character.exampleMessage, context)
            "persona", "userpersona" -> parseNested(context.settings.personaPrompt, context)
            "mainprompt", "systemprompt", "main_prompt" -> parseNested(context.settings.mainPrompt, context)
            "jb", "jailbreak" -> parseNested(context.settings.jailbreak, context)
            "globalnote", "systemnote", "ujb" -> parseNested(context.settings.globalNote, context)
            "authornote", "author_note" -> parseNested(context.authorNote, context)
            "previouscharchat", "lastcharmessage" -> previousMessage(context, user = false)
            "previoususerchat", "lastusermessage" -> previousMessage(context, user = true)
            "firstmsgindex", "firstmessageindex", "first_msg_index" -> context.greetingIndex.toString()
            "chatindex", "chat_index" -> context.history.lastIndex.toString()
            "setvar" -> mutateVariable(context) { variables ->
                variables[arg(0)] = arg(1)
            }
            "setdefaultvar" -> mutateVariable(context) { variables ->
                val current = getVar(arg(0), context)
                if (current.isEmpty() || current == "null") variables[arg(0)] = arg(1)
            }
            "addvar" -> mutateVariable(context) { variables ->
                val sum = jsNumber(getVar(arg(0), context)) + jsNumber(arg(1))
                variables[arg(0)] = jsNumberString(sum)
            }
            "getvar" -> getVar(arg(0), context)
            "getglobalvar" -> getGlobalVar(arg(0), context)
            "slot" -> context.slots[arg(0)].orEmpty()
            "blank", "none" -> ""
            "equal" -> boolString(arg(0) == arg(1))
            "notequal", "not_equal" -> boolString(arg(0) != arg(1))
            "greater" -> numericCompare(arg(0), arg(1)) { a, b -> a > b }
            "less" -> numericCompare(arg(0), arg(1)) { a, b -> a < b }
            "greaterequal", "greater_equal" -> numericCompare(arg(0), arg(1)) { a, b -> a >= b }
            "lessequal", "less_equal" -> numericCompare(arg(0), arg(1)) { a, b -> a <= b }
            "and" -> boolString(arg(0) == "1" && arg(1) == "1")
            "or" -> boolString(arg(0) == "1" || arg(1) == "1")
            "not" -> boolString(arg(0) != "1")
            "startswith" -> boolString(arg(0).startsWith(arg(1)))
            "endswith" -> boolString(arg(0).endsWith(arg(1)))
            "contains" -> boolString(arg(0).contains(arg(1)))
            "replace" -> if (arg(1).isEmpty()) arg(0) else arg(0).replace(arg(1), arg(2))
            "split" -> JsonLite.stringify(arg(0).split(arg(1)))
            "join" -> JsonLite.parseArray(arg(0))?.joinToString(arg(1)) { JsonLite.slotString(it) } ?: ""
            "spread" -> JsonLite.parseArray(arg(0))?.joinToString("::") { JsonLite.slotString(it) } ?: ""
            "trim" -> arg(0).trim()
            "length" -> arg(0).length.toString()
            "arraylength" -> (JsonLite.parseArray(arg(0))?.size ?: 0).toString()
            "lower" -> arg(0).lowercase()
            "upper" -> arg(0).uppercase()
            "capitalize" -> arg(0).replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
            "reverse" -> arg(0).codePoints().toArray().reversedArray().joinToString("") { String(Character.toChars(it)) }
            "bo" -> OPEN_SENTINEL
            "bc" -> CLOSE_SENTINEL
            "decbo" -> "{"
            "decbc" -> "}"
            "br" -> "\n"
            "cbr" -> "\\n"
            ";" -> ";"
            ":" -> ":"
            "(" -> "("
            ")" -> ")"
            "<" -> "&lt;"
            ">" -> "&gt;"
            else -> null
        }
    }

    private fun previousMessage(context: NativeRisuParserContext, user: Boolean): String {
        val expected = if (user) "user" else "char"
        val found = context.history.asReversed().firstOrNull { message ->
            if (user) message.role == expected else message.role != "user"
        }
        if (found != null) return found.data
        return if (context.greetingIndex >= 0) {
            context.character.alternateGreetings.getOrNull(context.greetingIndex) ?: context.character.firstMessage
        } else context.character.firstMessage
    }

    private fun getVar(key: String, context: NativeRisuParserContext): String {
        context.mutationVariables?.get(key)?.let { return it }
        context.variables[key]?.let { return it }
        parseKeyValue(context.character.defaultVariables)[key]?.let { return it }
        parseKeyValue(context.settings.templateDefaultVariables)[key]?.let { return it }
        return "null"
    }

    private fun getGlobalVar(key: String, context: NativeRisuParserContext): String =
        context.settings.globalChatVariables[key] ?: "null"

    private inline fun mutateVariable(
        context: NativeRisuParserContext,
        operation: (MutableMap<String, String>) -> Unit,
    ): String? {
        val variables = context.mutationVariables ?: return null
        operation(variables)
        return ""
    }

    private fun jsNumber(value: String): Double {
        val trimmed = value.trim()
        if (trimmed.isEmpty()) return 0.0
        return trimmed.toDoubleOrNull() ?: Double.NaN
    }

    private fun jsNumberString(value: Double): String = when {
        value.isNaN() -> "NaN"
        value == Double.POSITIVE_INFINITY -> "Infinity"
        value == Double.NEGATIVE_INFINITY -> "-Infinity"
        value == 0.0 -> "0"
        value.isFinite() && value % 1.0 == 0.0 && value in Long.MIN_VALUE.toDouble()..Long.MAX_VALUE.toDouble() -> value.toLong().toString()
        else -> value.toString()
    }

    private fun parseKeyValue(text: String): Map<String, String> = buildMap {
        for (line in text.split('\n')) {
            val parts = line.split('=')
            if (parts.size >= 2 && parts[0].isNotEmpty() && parts[1].isNotEmpty()) put(parts[0], parts[1])
        }
    }

    private fun parseNested(text: String, context: NativeRisuParserContext): String =
        if (text.isEmpty()) "" else render(text, context, 1)

    private fun numericCompare(a: String, b: String, predicate: (Double, Double) -> Boolean): String {
        val left = a.toDoubleOrNull() ?: Double.NaN
        val right = b.toDoubleOrNull() ?: Double.NaN
        return boolString(predicate(left, right))
    }

    private fun truthy(value: String): Boolean = value == "1" || value == "true"
    private fun boolString(value: Boolean): String = if (value) "1" else "0"
    private fun legacyWhitespace(value: String): String = value.trim().lineSequence().joinToString("\n") { it.trimStart() }
    private fun restoreEscapes(value: String): String = value.replace(OPEN_SENTINEL, "{{").replace(CLOSE_SENTINEL, "}}")

    private object JsonLite {
        fun parseArray(text: String): List<Any?>? = runCatching {
            val reader = Reader(text)
            val value = reader.parseValue()
            reader.skipWhitespace()
            if (!reader.atEnd() || value !is List<*>) null else value
        }.getOrNull() as? List<Any?>

        fun stringify(value: Any?): String = when (value) {
            null -> "null"
            is String -> "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
            is Boolean -> value.toString()
            is Number -> numberString(value)
            is List<*> -> value.joinToString(prefix = "[", postfix = "]", separator = ",") { stringify(it) }
            else -> stringify(value.toString())
        }

        fun slotString(value: Any?): String = when (value) {
            null -> "null"
            is String -> value
            is Number -> numberString(value)
            is Boolean -> value.toString()
            is List<*> -> stringify(value)
            else -> value.toString()
        }

        private fun numberString(number: Number): String {
            val d = number.toDouble()
            return if (d.isFinite() && d == d.toLong().toDouble()) d.toLong().toString() else d.toString()
        }

        private class Reader(private val text: String) {
            private var index = 0
            fun atEnd() = index >= text.length
            fun skipWhitespace() { while (!atEnd() && text[index].isWhitespace()) index++ }

            fun parseValue(): Any? {
                skipWhitespace()
                if (atEnd()) error("unexpected end")
                return when (text[index]) {
                    '[' -> parseArray()
                    '"' -> parseString()
                    else -> parseLiteral()
                }
            }

            private fun parseArray(): List<Any?> {
                index++
                val result = mutableListOf<Any?>()
                skipWhitespace()
                if (!atEnd() && text[index] == ']') { index++; return result }
                while (true) {
                    result += parseValue()
                    skipWhitespace()
                    if (atEnd()) error("unterminated array")
                    when (text[index++]) {
                        ']' -> return result
                        ',' -> Unit
                        else -> error("invalid array separator")
                    }
                }
            }

            private fun parseString(): String {
                index++
                val out = StringBuilder()
                while (!atEnd()) {
                    val c = text[index++]
                    if (c == '"') return out.toString()
                    if (c == '\\') {
                        if (atEnd()) error("invalid escape")
                        when (val e = text[index++]) {
                            '"', '\\', '/' -> out.append(e)
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000C')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'u' -> {
                                if (index + 4 > text.length) error("bad unicode escape")
                                out.append(text.substring(index, index + 4).toInt(16).toChar())
                                index += 4
                            }
                            else -> error("unknown escape")
                        }
                    } else out.append(c)
                }
                error("unterminated string")
            }

            private fun parseLiteral(): Any? {
                val start = index
                while (!atEnd() && text[index] != ',' && text[index] != ']' && !text[index].isWhitespace()) index++
                val token = text.substring(start, index)
                return when (token) {
                    "true" -> true
                    "false" -> false
                    "null" -> null
                    else -> token.toLongOrNull() ?: token.toDoubleOrNull() ?: error("invalid literal")
                }
            }
        }
    }
}
