package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.TriggerScript
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeTriggerProcessor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeTriggerV2ProcessorTest {
    private val settings = GenerationSettings(username = "Alice")
    private fun run(effects: List<Map<String, Any?>>, variables: Map<String, String> = emptyMap()) =
        NativeTriggerProcessor.run(
            mode = "start",
            settings = settings,
            character = CharacterProfile(
                id = "c",
                name = "Lua",
                triggerScripts = listOf(TriggerScript("v2", "start", effects = effects)),
            ),
            messages = listOf(MessageRecord("m", "chat", "user", "hello")),
            variables = variables,
            chatId = "chat",
        )
    @Test
    fun ifElseUsesNumericEqualityAndSkipsOppositeBranch() {
        val effects = listOf(
            mapOf("type" to "v2Header", "indent" to 0),
            mapOf(
                "type" to "v2If", "condition" to "=", "targetType" to "value",
                "target" to "1", "source" to "number", "indent" to 0,
            ),
            mapOf(
                "type" to "v2SetVar", "operator" to "=", "var" to "result",
                "valueType" to "value", "value" to "true-branch", "indent" to 1,
            ),
            mapOf("type" to "v2EndIndent", "indent" to 1),
            mapOf("type" to "v2Else", "indent" to 0),
            mapOf(
                "type" to "v2SetVar", "operator" to "=", "var" to "result",
                "valueType" to "value", "value" to "false-branch", "indent" to 1,
            ),
            mapOf("type" to "v2EndIndent", "indent" to 1),
        )
        assertEquals("true-branch", run(effects, mapOf("number" to "1.0")).variables["result"])
        assertEquals("false-branch", run(effects, mapOf("number" to "2")).variables["result"])
    }
    @Test
    fun loopNTimesAndLocalVariablesMatchV2ScopeRules() {
        val effects = listOf(
            mapOf("type" to "v2Header", "indent" to 0),
            mapOf(
                "type" to "v2SetVar", "operator" to "=", "var" to "count",
                "valueType" to "value", "value" to "0", "indent" to 0,
            ),
            mapOf("type" to "v2LoopNTimes", "value" to "3", "valueType" to "value", "indent" to 0),
            mapOf(
                "type" to "v2DeclareLocalVar", "var" to "shadow", "value" to "5",
                "valueType" to "value", "indent" to 1,
            ),
            mapOf(
                "type" to "v2SetVar", "operator" to "+=", "var" to "shadow",
                "valueType" to "value", "value" to "1", "indent" to 1,
            ),
            mapOf(
                "type" to "v2SetVar", "operator" to "+=", "var" to "count",
                "valueType" to "value", "value" to "1", "indent" to 1,
            ),
            mapOf("type" to "v2EndIndent", "indent" to 1, "endOfLoop" to true),
        )
        val result = run(effects, mapOf("shadow" to "99"))
        assertEquals("3", result.variables["count"])
        assertEquals("99", result.variables["shadow"])
    }
    @Test
    fun advancedMembershipAndApproximateComparisonFollowRisuRules() {
        val effects = listOf(
            mapOf("type" to "v2Header", "indent" to 0),
            mapOf(
                "type" to "v2IfAdvanced", "condition" to "∈", "sourceType" to "value",
                "source" to "b", "targetType" to "value", "target" to "[\"a\",\"b\"]", "indent" to 0,
            ),
            mapOf(
                "type" to "v2SetVar", "operator" to "=", "var" to "member",
                "valueType" to "value", "value" to "yes", "indent" to 1,
            ),
            mapOf("type" to "v2EndIndent", "indent" to 1),
            mapOf(
                "type" to "v2IfAdvanced", "condition" to "≒", "sourceType" to "value",
                "source" to "Hello World", "targetType" to "value", "target" to "helloworld", "indent" to 0,
            ),
            mapOf(
                "type" to "v2SetVar", "operator" to "=", "var" to "approx",
                "valueType" to "value", "value" to "yes", "indent" to 1,
            ),
            mapOf("type" to "v2EndIndent", "indent" to 1),
        )
        val result = run(effects)
        assertEquals("yes", result.variables["member"])
        assertEquals("yes", result.variables["approx"])
    }
    @Test
    fun stopTriggerOnlyStopsCurrentTriggerWhileStopPromptSetsRequestFlag() {
        val first = TriggerScript(
            comment = "first",
            type = "start",
            effects = listOf(
                mapOf("type" to "v2Header", "indent" to 0),
                mapOf("type" to "v2SetVar", "operator" to "=", "var" to "before", "valueType" to "value", "value" to "yes", "indent" to 0),
                mapOf("type" to "v2StopTrigger", "indent" to 0),
                mapOf("type" to "v2SetVar", "operator" to "=", "var" to "skipped", "valueType" to "value", "value" to "bad", "indent" to 0),
            ),
        )
        val second = TriggerScript(
            comment = "second",
            type = "start",
            effects = listOf(
                mapOf("type" to "v2Header", "indent" to 0),
                mapOf("type" to "v2StopPromptSending", "indent" to 0),
                mapOf("type" to "v2SetVar", "operator" to "=", "var" to "after", "valueType" to "value", "value" to "yes", "indent" to 0),
            ),
        )
        val result = NativeTriggerProcessor.run(
            mode = "start", settings = settings,
            character = CharacterProfile("c", "Lua", triggerScripts = listOf(first, second)),
            messages = listOf(MessageRecord("m", "chat", "user", "hello")),
            variables = emptyMap(), chatId = "chat",
        )
        assertEquals("yes", result.variables["before"])
        assertNull(result.variables["skipped"])
        assertEquals("yes", result.variables["after"])
        assertTrue(result.stopSending)
    }

    @Test
    fun v2CutChatSupportsNegativeIndexes() {
        val effects = listOf(
            mapOf("type" to "v2Header", "indent" to 0),
            mapOf(
                "type" to "v2CutChat", "start" to "-1", "startType" to "value",
                "end" to "999", "endType" to "value", "indent" to 0,
            ),
        )
        val trigger = TriggerScript("v2", "start", effects = effects)
        val result = NativeTriggerProcessor.run(
            mode = "start", settings = settings,
            character = CharacterProfile("c", "Lua", triggerScripts = listOf(trigger)),
            messages = listOf(
                MessageRecord("a", "chat", "user", "a"),
                MessageRecord("b", "chat", "char", "b"),
            ),
            variables = emptyMap(), chatId = "chat",
        )
        assertEquals(listOf("b"), result.messages.map(MessageRecord::id))
        assertFalse(result.stopSending)
    }

    @Test
    fun pureMessageStringArrayAndRegexEffectsComposeInOneProgram() {
        val effects = listOf(
            mapOf("type" to "v2Header", "indent" to 0),
            mapOf("type" to "v2GetMessageCount", "outputVar" to "count", "indent" to 0),
            mapOf("type" to "v2GetLastMessage", "outputVar" to "last", "indent" to 0),
            mapOf("type" to "v2MakeArrayVar", "var" to "arr", "indent" to 0),
            mapOf("type" to "v2PushArrayVar", "var" to "arr", "valueType" to "value", "value" to "a", "indent" to 0),
            mapOf("type" to "v2PushArrayVar", "var" to "arr", "valueType" to "value", "value" to "b", "indent" to 0),
            mapOf("type" to "v2GetArrayVarLength", "var" to "arr", "outputVar" to "len", "indent" to 0),
            mapOf("type" to "v2PopArrayVar", "var" to "arr", "outputVar" to "popped", "indent" to 0),
            mapOf("type" to "v2UnshiftArrayVar", "var" to "arr", "valueType" to "value", "value" to "z", "indent" to 0),
            mapOf("type" to "v2JoinArrayVar", "var" to "arr", "varType" to "var", "delimiter" to "|", "delimiterType" to "value", "outputVar" to "joined", "indent" to 0),
            mapOf("type" to "v2SplitString", "source" to "a,b,", "sourceType" to "value", "delimiter" to ",", "delimiterType" to "value", "outputVar" to "split", "indent" to 0),
            mapOf("type" to "v2RegexTest", "value" to "abc123", "valueType" to "value", "regex" to "\\d+", "regexType" to "value", "flags" to "", "flagsType" to "value", "outputVar" to "matched", "indent" to 0),
            mapOf("type" to "v2ExtractRegex", "value" to "abc123", "valueType" to "value", "regex" to "([a-z]+)(\\d+)", "regexType" to "value", "flags" to "", "flagsType" to "value", "result" to "$2-$1-$$-$&", "resultType" to "value", "outputVar" to "extracted", "indent" to 0),
        )
        val result = run(effects)
        assertEquals("1", result.variables["count"])
        assertEquals("hello", result.variables["last"])
        assertEquals("2", result.variables["len"])
        assertEquals("b", result.variables["popped"])
        assertEquals("z|a", result.variables["joined"])
        assertEquals("[\"a\",\"b\",\"\"]", result.variables["split"])
        assertEquals("1", result.variables["matched"])
        assertEquals("123-abc-$-abc123", result.variables["extracted"])
    }

}

