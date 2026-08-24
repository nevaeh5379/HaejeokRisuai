package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeChatRuntimeProcessor
import org.junit.Assert.assertEquals
import org.junit.Test

class NativeChatRuntimeProcessorTest {
    @Test
    fun mutationsFlowAcrossMessagesAndCommandsAreRemoved() {
        val messages = listOf(
            MessageRecord("m1", "chat", "char", "{{setvar::count::1}}start"),
            MessageRecord("m2", "chat", "user", "{{addvar::count::2}}count={{getvar::count}}"),
            MessageRecord("m3", "chat", "char", "final={{getvar::count}}"),
        )
        val result = NativeChatRuntimeProcessor.prepare(
            settings = GenerationSettings(username = "Alice"),
            character = CharacterProfile("c1", "Lua"),
            messages = messages,
        )

        assertEquals(listOf("start", "count=3", "final=3"), result.messages.map { it.data })
        assertEquals("3", result.variables["count"])
    }
}
