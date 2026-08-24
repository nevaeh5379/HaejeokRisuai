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
}

