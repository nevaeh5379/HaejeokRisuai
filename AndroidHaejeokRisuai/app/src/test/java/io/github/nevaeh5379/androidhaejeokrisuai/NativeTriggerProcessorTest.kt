package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.TriggerScript
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeTriggerProcessor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeTriggerProcessorTest {
    private val settings = GenerationSettings(username = "Alice")
    private val baseMessages = listOf(
        MessageRecord("m1", "chat", "user", "hello world"),
        MessageRecord("m2", "chat", "char", "answer"),
    )

    @Test
    fun v1ConditionsSetVariablesAndInjectSystemPrompts() {
        val trigger = TriggerScript(
            comment = "start rules",
            type = "start",
            conditions = listOf(
                mapOf("type" to "exists", "value" to "HELLO", "type2" to "loose", "depth" to 2),
                mapOf("type" to "chatindex", "value" to "2", "operator" to ">="),
            ),
            effects = listOf(
                mapOf("type" to "setvar", "var" to "score", "operator" to "+=", "value" to "2"),
                mapOf("type" to "systemprompt", "location" to "promptend", "value" to "Remember {{user}}"),
            ),
        )
        val result = NativeTriggerProcessor.run(
            mode = "start",
            settings = settings,
            character = CharacterProfile("c", "Lua", triggerScripts = listOf(trigger)),
            messages = baseMessages,
            variables = mapOf("score" to "3"),
            chatId = "chat",
        )
        assertEquals("5", result.variables["score"])
        assertEquals("Remember Alice\n\n", result.promptInjection.promptEnd)
        assertFalse(result.stopSending)
    }

    @Test
    fun impersonateModifyStopAndManualRecursionWorkInOrder() {
        val nested = TriggerScript(
            comment = "nested",
            type = "manual",
            effects = listOf(mapOf("type" to "setvar", "var" to "nested", "operator" to "=", "value" to "yes")),
        )
        val output = TriggerScript(
            comment = "output",
            type = "output",
            effects = listOf(
                mapOf("type" to "modifychat", "index" to "0", "value" to "changed"),
                mapOf("type" to "impersonate", "role" to "char", "value" to "extra"),
                mapOf("type" to "runtrigger", "value" to "nested"),
                mapOf("type" to "stop"),
            ),
        )
        val result = NativeTriggerProcessor.run(
            mode = "output",
            settings = settings,
            character = CharacterProfile("c", "Lua", triggerScripts = listOf(output, nested)),
            messages = baseMessages,
            variables = emptyMap(),
            chatId = "chat",
        )
        assertEquals("changed", result.messages.first().data)
        assertEquals("extra", result.messages.last().data)
        assertEquals("char", result.messages.last().role)
        assertEquals("chat", result.messages.last().chatId)
        assertEquals("yes", result.variables["nested"])
        assertTrue(result.stopSending)
    }

    @Test
    fun cutChatUsesJavascriptSliceSemanticsIncludingNegativeIndexes() {
        val messages = (0..4).map { index ->
            MessageRecord("m$index", "chat", if (index % 2 == 0) "user" else "char", "message-$index")
        }
        val trigger = TriggerScript(
            comment = "trim",
            type = "input",
            effects = listOf(mapOf("type" to "cutchat", "start" to "-3", "end" to "-1")),
        )
        val result = NativeTriggerProcessor.run(
            mode = "input",
            settings = settings,
            character = CharacterProfile("c", "Lua", triggerScripts = listOf(trigger)),
            messages = messages,
            variables = emptyMap(),
            chatId = "chat",
        )
        assertEquals(listOf("m2", "m3"), result.messages.map(MessageRecord::id))
    }
}
