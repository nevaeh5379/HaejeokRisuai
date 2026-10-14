package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.RegexScript
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeRegexProcessor
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeRisuParserContext
import org.junit.Assert.assertEquals
import org.junit.Test

class NativeRegexProcessorTest {
    private val character = CharacterProfile(id = "c1", name = "Lua")

    private fun process(data: String, mode: String, scripts: List<RegexScript>): String {
        val settings = GenerationSettings(username = "Alice", presetRegex = scripts)
        return NativeRegexProcessor.process(
            data = data,
            mode = mode,
            settings = settings,
            character = character,
            parserContext = NativeRisuParserContext(settings = settings, character = character),
        )
    }

    @Test
    fun globalReplacementSupportsGroupsAndRisuNewlineEscape() {
        val script = RegexScript(
            input = "(cat)",
            output = "<\$1>\$n",
            type = "editoutput",
        )
        assertEquals("<cat>\n <cat>\n", process("cat cat", "editoutput", listOf(script)))
    }

    @Test
    fun flagMetadataControlsOrderAndCbsInput() {
        val scripts = listOf(
            RegexScript(input = "B", output = "C", type = "editprocess", flag = "g<order 1>", ableFlag = true),
            RegexScript(input = "{{char}}", output = "B", type = "editprocess", flag = "g<cbs, order 2>", ableFlag = true),
        )
        assertEquals("C", process("Lua", "editprocess", scripts))
    }

    @Test
    fun moveTopAndModeFilteringMatchCommonRisuActions() {
        val script = RegexScript(
            input = "tag:(\\w+)",
            output = "@@move_top [\$1]",
            type = "editinput",
            flag = "g",
            ableFlag = true,
        )
        assertEquals("[x]\nhello ", process("hello tag:x", "editinput", listOf(script)))
        assertEquals("hello tag:x", process("hello tag:x", "editoutput", listOf(script)))
    }
}
