package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeRisuParser
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeRisuParserContext
import org.junit.Assert.assertEquals
import org.junit.Test

class NativeRisuParserTest {
    private fun context(
        variables: Map<String, String> = emptyMap(),
        globals: Map<String, String> = emptyMap(),
    ) = NativeRisuParserContext(
        settings = GenerationSettings(
            username = "Alice",
            personaPrompt = "A careful scholar",
            mainPrompt = "Main rules",
            templateDefaultVariables = "fallback=42",
            globalChatVariables = globals,
        ),
        character = CharacterProfile(
            id = "c1",
            name = "Lua",
            firstMessage = "Hello",
            defaultVariables = "cardDefault=7",
            personality = "proud",
            description = "noble",
            scenario = "library",
        ),
        history = listOf(
            MessageRecord("m1", "chat", "user", "Question"),
            MessageRecord("m2", "chat", "char", "Answer"),
        ),
        authorNote = "Keep it subtle",
        greetingIndex = -1,
        variables = variables,
    )

    @Test
    fun commonStringAndComparisonFunctionsMatchCbs() {
        val c = context()
        assertEquals("1", NativeRisuParser.parse("{{startswith::Hello World::Hello}}", c))
        assertEquals("1", NativeRisuParser.parse("{{contains::Hello World::lo Wo}}", c))
        assertEquals("Hell0 W0rld", NativeRisuParser.parse("{{replace::Hello World::o::0}}", c))
        assertEquals("hello world", NativeRisuParser.parse("{{lower::Hello WORLD}}", c))
        assertEquals("5", NativeRisuParser.parse("{{length::Hello}}", c))
        assertEquals("1", NativeRisuParser.parse("{{greater::10::5}}", c))
    }

    @Test
    fun whenSupportsNestedElseVariablesAndRightToLeftLogic() {
        val c = context(variables = mapOf("enabled" to "true"), globals = mapOf("toggle_mode" to "1"))
        assertEquals("yes", NativeRisuParser.parse("{{#when::var::enabled}}yes{{:else}}no{{/}}", c))
        assertEquals("toggle", NativeRisuParser.parse("{{#when::toggle::mode}}toggle{{/}}", c))
        assertEquals("yes", NativeRisuParser.parse("{{#when::1::or::0::and::0}}yes{{:else}}no{{/}}", c))
        assertEquals("outer-inner", NativeRisuParser.parse("{{#when 1}}outer-{{#when 1}}inner{{/}}{{:else}}bad{{/}}", c))
    }

    @Test
    fun eachSupportsNestedJsonArraysAndSlots() {
        val c = context()
        assertEquals("123", NativeRisuParser.parse("{{#each [1, 2, 3] as n}}{{slot::n}}{{/}}", c))
        assertEquals(
            "1234",
            NativeRisuParser.parse(
                "{{#each::keep [[1,2],[3,4]] as x}}{{#each::keep {{slot::x}} as y}}{{slot::y}}{{/}}{{/}}",
                c,
            ),
        )
    }

    @Test
    fun variablesUseChatThenCardThenTemplateFallbacks() {
        val c = context(variables = mapOf("live" to "99"))
        assertEquals("99/7/42/null", NativeRisuParser.parse(
            "{{getvar::live}}/{{getvar::cardDefault}}/{{getvar::fallback}}/{{getvar::missing}}",
            c,
        ))
    }

    @Test
    fun contextMacrosAndEscapesAreResolved() {
        val c = context()
        assertEquals(
            "Lua/Alice/proud/noble/library/A careful scholar/Answer/Question/Keep it subtle",
            NativeRisuParser.parse(
                "{{char}}/{{user}}/{{personality}}/{{description}}/{{scenario}}/{{persona}}/" +
                    "{{previouscharchat}}/{{previoususerchat}}/{{authornote}}",
                c,
            ),
        )
        assertEquals("{{literal}}\n", NativeRisuParser.parse("{{bo}}literal{{bc}}{{br}}", c))
    }
}
