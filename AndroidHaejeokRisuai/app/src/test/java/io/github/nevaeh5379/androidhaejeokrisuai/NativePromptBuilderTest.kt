package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativePromptBuilder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NativePromptBuilderTest {
    @Test
    fun promptBlocksAndRisuVariablesArePreserved() {
        val settings = GenerationSettings(
            username = "Alice",
            mainPrompt = "@@system\nYou are {{char}}.\n@@user\nRemember {{user}}.",
            globalNote = "stay in character",
            formatingOrder = listOf("main", "description", "chats", "globalNote", "lastChat", "authorNote"),
        )
        val character = CharacterProfile(
            id = "c1",
            name = "Lua",
            description = "A noble lady",
            personality = "proud",
        )
        val history = listOf(
            MessageRecord("m1", "chat", "user", "Hello"),
            MessageRecord("m2", "chat", "char", "Greetings"),
        )
        val prompt = NativePromptBuilder.build(settings, character, history, "Secret note")

        assertEquals("system", prompt[0].role)
        assertEquals("You are Lua.", prompt[0].content)
        assertEquals("user", prompt[1].role)
        assertEquals("Remember Alice.", prompt[1].content)
        assertTrue(prompt.any { it.role == "system" && it.content.contains("Description of Lua: proud") })
        val helloIndex = prompt.indexOfFirst { it.role == "user" && it.content == "Hello" }
        val globalIndex = prompt.indexOfFirst { it.role == "system" && it.content.contains("stay in character") }
        val lastChatIndex = prompt.indexOfFirst { it.role == "assistant" && it.content == "Greetings" }
        assertTrue(helloIndex >= 0)
        assertTrue(globalIndex > helloIndex)
        assertTrue(lastChatIndex > globalIndex)
        assertTrue(prompt.last().content.contains("Secret note"))
    }

    @Test
    fun plainPromptDefaultsToSystemRole() {
        val blocks = NativePromptBuilder.parsePromptBlocks("ordinary system prompt")
        assertEquals(1, blocks.size)
        assertEquals("system", blocks.single().role)
        assertEquals("ordinary system prompt", blocks.single().content)
    }

    @Test
    fun examplesAlternateGreetingAndPersonaFollowRisuSemantics() {
        val settings = GenerationSettings(username = "Alice", personaPrompt = "{{user}} is a scholar.")
        val character = CharacterProfile(
            id = "c1", name = "Lua", firstMessage = "Default hello",
            alternateGreetings = listOf("Alternate hello"),
            exampleMessage = "<START>\n{{user}}: Hi {{char}}\n{{char}}: Welcome {{user}}",
        )
        val history = listOf(MessageRecord("m1", "chat", "user", "Now"))
        val prompt = NativePromptBuilder.build(settings, character, history, greetingIndex = 0)

        assertTrue(prompt.any { it.role == "system" && it.content.contains("Alice is a scholar.") })
        assertTrue(prompt.any { it.role == "user" && it.content == "Hi Lua" })
        assertTrue(prompt.any { it.role == "assistant" && it.content == "Welcome Alice" })
        assertTrue(prompt.any { it.role == "assistant" && it.content == "Alternate hello" })
        assertTrue(prompt.none { it.content == "Default hello" })
    }
}
