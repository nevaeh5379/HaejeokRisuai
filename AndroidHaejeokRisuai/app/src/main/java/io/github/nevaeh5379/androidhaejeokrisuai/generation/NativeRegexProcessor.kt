package io.github.nevaeh5379.androidhaejeokrisuai.generation

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.RegexScript
import java.util.regex.Matcher
import java.util.regex.Pattern

internal object NativeRegexProcessor {
    fun process(
        data: String,
        mode: String,
        settings: GenerationSettings,
        character: CharacterProfile,
        parserContext: NativeRisuParserContext,
    ): String {
        var result = NativeRisuParser.parse(data, parserContext)
        val scripts = (settings.presetRegex + character.regexScripts)
            .map(::parseMetadata)
            .filter { it.script.type == mode && it.script.input.isNotEmpty() }
            .sortedByDescending(ParsedScript::order)
        for (parsed in scripts) {
            result = runCatching { execute(result, parsed, parserContext) }.getOrDefault(result)
        }
        return result
    }

    private data class ParsedScript(
        val script: RegexScript,
        val order: Int,
        val actions: Set<String>,
        val regexFlags: String,
    )

    private fun parseMetadata(script: RegexScript): ParsedScript {
        if (!script.ableFlag || '<' !in script.flag) {
            return ParsedScript(script, 0, emptySet(), if (script.ableFlag) script.flag else "g")
        }
        var order = 0
        val actions = linkedSetOf<String>()
        val meta = Regex("<(.+?)>")
        val cleaned = meta.replace(script.flag) { match ->
            match.groupValues[1].split(',').map(String::trim).filter(String::isNotEmpty).forEach { item ->
                if (item.startsWith("order ")) order = item.substring(6).toIntOrNull() ?: order else actions += item
            }
            ""
        }
        return ParsedScript(script, order, actions, cleaned)
    }

    private fun execute(data: String, parsed: ParsedScript, context: NativeRisuParserContext): String {
        val script = parsed.script
        val input = if ("cbs" in parsed.actions) NativeRisuParser.parse(script.input, context) else script.input
        var flags = parsed.regexFlags.trim().filter { it in "dgimsuvy" }.toSet().joinToString("")
        if (flags.isEmpty()) flags = "u"
        val global = 'g' in flags
        var patternFlags = 0
        if ('i' in flags) patternFlags = patternFlags or Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE
        if ('m' in flags) patternFlags = patternFlags or Pattern.MULTILINE
        if ('s' in flags) patternFlags = patternFlags or Pattern.DOTALL
        val pattern = Pattern.compile(input, patternFlags)
        var replacement = script.output.replace("\$n", "\n")
        val moveTop = replacement.startsWith("@@move_top") || "move_top" in parsed.actions
        val moveBottom = replacement.startsWith("@@move_bottom") || "move_bottom" in parsed.actions
        if ((moveTop || moveBottom) && global) flags = flags.replace("g", "")
        if (replacement.endsWith(">") && "no_end_nl" !in parsed.actions) replacement += "\n"

        val matcher = pattern.matcher(data)
        if (!matcher.find()) return data
        matcher.reset()
        val transformed = when {
            moveTop || moveBottom -> {
                val first = matcher.takeMatch(extractNamedGroups(input)) ?: return data
                val out = expandReplacement(replacement
                    .removePrefix("@@move_top ")
                    .removePrefix("@@move_bottom "), first)
                val removed = replaceMatches(data, pattern, global = false, replacement = "")
                if (moveTop) "$out\n$removed" else "$removed\n$out"
            }
            else -> replaceMatches(data, pattern, global, replacement)
        }
        return NativeRisuParser.parse(transformed, context)
    }

    private data class MatchSnapshot(
        val whole: String,
        val groups: List<String?>,
        val named: Map<String, String?>,
    )

    private fun Matcher.takeMatch(namedGroups: Map<String, Int> = emptyMap()): MatchSnapshot? {
        if (!find()) return null
        val groups = (0..groupCount()).map { index -> runCatching { group(index) }.getOrNull() }
        return MatchSnapshot(
            whole = group(),
            groups = groups,
            named = namedGroups.mapValues { (_, index) -> groups.getOrNull(index) },
        )
    }

    private fun replaceMatches(data: String, pattern: Pattern, global: Boolean, replacement: String): String {
        val matcher = pattern.matcher(data)
        val namedGroups = extractNamedGroups(pattern.pattern())
        val out = StringBuilder()
        var cursor = 0
        while (matcher.find()) {
            out.append(data, cursor, matcher.start())
            val groups = (0..matcher.groupCount()).map { index -> runCatching { matcher.group(index) }.getOrNull() }
            val snapshot = MatchSnapshot(
                whole = matcher.group(),
                groups = groups,
                named = namedGroups.mapValues { (_, index) -> groups.getOrNull(index) },
            )
            out.append(expandReplacement(replacement, snapshot))
            cursor = matcher.end()
            if (!global) break
            if (matcher.start() == matcher.end() && cursor < data.length) {
                out.append(data[cursor])
                cursor++
            }
        }
        out.append(data, cursor, data.length)
        return out.toString()
    }

    private fun extractNamedGroups(pattern: String): Map<String, Int> {
        val result = linkedMapOf<String, Int>()
        var groupIndex = 0
        var escaped = false
        var inClass = false
        var index = 0
        while (index < pattern.length) {
            val char = pattern[index]
            if (escaped) { escaped = false; index++; continue }
            if (char == '\\') { escaped = true; index++; continue }
            if (char == '[' && !inClass) { inClass = true; index++; continue }
            if (char == ']' && inClass) { inClass = false; index++; continue }
            if (char != '(' || inClass) { index++; continue }

            if (index + 1 < pattern.length && pattern[index + 1] == '?') {
                if (index + 2 < pattern.length && pattern[index + 2] == '<') {
                    val marker = pattern.getOrNull(index + 3)
                    if (marker == '=' || marker == '!') { index++; continue }
                    val end = pattern.indexOf('>', index + 3)
                    if (end > index + 3) {
                        groupIndex++
                        result[pattern.substring(index + 3, end)] = groupIndex
                        index++
                        continue
                    }
                }
                index++
                continue
            }
            groupIndex++
            index++
        }
        return result
    }

    private fun expandReplacement(template: String, match: MatchSnapshot): String = buildString {
        var index = 0
        while (index < template.length) {
            if (template[index] != '$' || index + 1 >= template.length) {
                append(template[index++])
                continue
            }
            when (val next = template[index + 1]) {
                '$' -> { append('$'); index += 2 }
                '&' -> { append(match.whole); index += 2 }
                '<' -> {
                    val end = template.indexOf('>', index + 2)
                    if (end < 0) { append('$'); index++ } else {
                        val name = template.substring(index + 2, end)
                        append(match.named[name].orEmpty())
                        index = end + 1
                    }
                }
                '0' -> { append("$0"); index += 2 }
                in '1'..'9' -> {
                    var end = index + 1
                    while (end < template.length && template[end].isDigit() && end < index + 3) end++
                    var consumed = end
                    var groupIndex = template.substring(index + 1, end).toIntOrNull() ?: -1
                    while (groupIndex >= match.groups.size && consumed > index + 2) {
                        consumed--
                        groupIndex = template.substring(index + 1, consumed).toIntOrNull() ?: -1
                    }
                    if (groupIndex in match.groups.indices) {
                        append(match.groups[groupIndex].orEmpty())
                        index = consumed
                    } else {
                        append('$')
                        index++
                    }
                }
                else -> { append('$'); append(next); index += 2 }
            }
        }
    }
}
