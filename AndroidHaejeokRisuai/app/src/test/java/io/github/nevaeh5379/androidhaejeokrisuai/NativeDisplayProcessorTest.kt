package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.RegexScript
import io.github.nevaeh5379.androidhaejeokrisuai.data.TriggerScript
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeDisplayProcessor
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeTriggerProcessor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeDisplayProcessorTest {
    private val settings = GenerationSettings(username = "Alice")
    private val history = listOf(
        MessageRecord("m1", "chat", "user", "hello"),
        MessageRecord("m2", "chat", "char", "world"),
    )

    private fun displayTrigger(
        comment: String = "display",
        conditions: List<Map<String, Any?>> = emptyList(),
        effects: List<Map<String, Any?>>,
    ) = TriggerScript(comment = comment, type = "display", conditions = conditions, effects = effects)

    @Test
    fun displayStateRunsBeforeCbsAndEditDisplayRegex() {
        val trigger = displayTrigger(
            effects = listOf(
                mapOf("type" to "v2Header", "indent" to 0),
                mapOf("type" to "v2GetDisplayState", "outputVar" to "original", "indent" to 0),
                mapOf(
                    "type" to "v2SetDisplayState", "value" to "original", "valueType" to "var", "indent" to 0,
                ),
            ),
        )
        val character = CharacterProfile(
            id = "c",
            name = "Lua",
            triggerScripts = listOf(trigger),
            regexScripts = listOf(RegexScript(input = "Alice:original", output = "rendered", type = "editdisplay")),
        )
        assertEquals(
            "rendered",
            NativeDisplayProcessor.process(
                data = "{{user}}:original",
                settings = settings,
                character = character,
                history = history,
                variables = emptyMap(),
                chatId = "chat",
            ),
        )
    }

    @Test
    fun displayVariablesStayTemporaryAndUnsafeEffectsAreSkipped() {
        val trigger = displayTrigger(
            effects = listOf(
                mapOf("type" to "v2Header", "indent" to 0),
                mapOf("type" to "v2SetVar", "operator" to "=", "var" to "temp", "value" to "display-only", "valueType" to "value", "indent" to 0),
                mapOf("type" to "v2SetDisplayState", "value" to "temp", "valueType" to "var", "indent" to 0),
                mapOf("type" to "v2SetCharacterDesc", "value" to "must-not-persist", "valueType" to "value", "indent" to 0),
                mapOf("type" to "v2SetAuthorNote", "value" to "must-not-persist", "valueType" to "value", "indent" to 0),
            ),
        )
        val result = NativeTriggerProcessor.run(
            mode = "display",
            settings = settings,
            character = CharacterProfile("c", "Lua", triggerScripts = listOf(trigger)),
            messages = history,
            variables = mapOf("persistent" to "keep"),
            chatId = "chat",
            displayState = "raw",
        )
        assertEquals("display-only", result.displayState)
        assertEquals(mapOf("persistent" to "keep"), result.variables)
        assertFalse(result.runtimePatch.hasCharacterChanges)
        assertNull(result.runtimePatch.authorNote)
    }

    @Test
    fun displayTempVariablesAreVisibleToFollowingTriggerConditions() {
        val seed = displayTrigger(
            comment = "seed",
            effects = listOf(
                mapOf("type" to "v2Header", "indent" to 0),
                mapOf("type" to "v2SetVar", "operator" to "=", "var" to "gate", "value" to "open", "valueType" to "value", "indent" to 0),
            ),
        )
        val consume = displayTrigger(
            comment = "consume",
            conditions = listOf(mapOf("type" to "var", "var" to "gate", "operator" to "=", "value" to "open")),
            effects = listOf(
                mapOf("type" to "v2Header", "indent" to 0),
                mapOf("type" to "v2SetDisplayState", "value" to "condition-passed", "valueType" to "value", "indent" to 0),
            ),
        )
        val result = NativeTriggerProcessor.run(
            mode = "display",
            settings = settings,
            character = CharacterProfile("c", "Lua", triggerScripts = listOf(seed, consume)),
            messages = history,
            variables = emptyMap(),
            chatId = "chat",
            displayState = "raw",
        )
        assertEquals("condition-passed", result.displayState)
        assertTrue(result.variables.isEmpty())
    }

    @Test
    fun displayConditionsAndCbsUseLogicalFullChatCount() {
        val trigger = displayTrigger(
            conditions = listOf(mapOf("type" to "chatindex", "operator" to "=", "value" to "999")),
            effects = listOf(
                mapOf("type" to "v2Header", "indent" to 0),
                mapOf("type" to "v2SetDisplayState", "value" to "{{chatindex}}", "valueType" to "value", "indent" to 0),
            ),
        )
        val result = NativeTriggerProcessor.run(
            mode = "display",
            settings = settings,
            character = CharacterProfile("c", "Lua", triggerScripts = listOf(trigger)),
            messages = history,
            variables = emptyMap(),
            chatId = "chat",
            displayState = "raw",
            messageCount = 999,
        )
        assertEquals("998", result.displayState)
    }

    @Test
    fun requiredHistoryDepthOnlyEscalatesWhenDisplayExistsConditionsNeedIt() {
        val bounded = CharacterProfile(
            "c", "Lua",
            triggerScripts = listOf(displayTrigger(
                conditions = listOf(mapOf("type" to "exists", "depth" to 120, "type2" to "loose", "value" to "needle")),
                effects = listOf(mapOf("type" to "v2Header", "indent" to 0)),
            )),
        )
        assertEquals(120, NativeDisplayProcessor.requiredHistoryDepth(bounded))

        val unbounded = bounded.copy(
            triggerScripts = listOf(displayTrigger(
                conditions = listOf(mapOf("type" to "exists", "depth" to 0, "type2" to "loose", "value" to "needle")),
                effects = listOf(mapOf("type" to "v2Header", "indent" to 0)),
            )),
        )
        assertNull(NativeDisplayProcessor.requiredHistoryDepth(unbounded))
    }
}
