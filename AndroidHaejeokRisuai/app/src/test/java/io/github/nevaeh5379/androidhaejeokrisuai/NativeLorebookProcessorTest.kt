package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.LoreEntry
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeLorebookProcessor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class NativeLorebookProcessorTest {
    private val history = listOf(
        MessageRecord("1", "c", "user", "An old castle stands beyond the river."),
        MessageRecord("2", "c", "char", "The red moon rises over the castle."),
        MessageRecord("3", "c", "user", "Tell me about the hidden library."),
    )

    @Test
    fun keySelectiveRegexAndAlwaysActiveEntriesResolve() {
        val entries = listOf(
            LoreEntry(key = "library", insertOrder = 30, content = "Library lore"),
            LoreEntry(
                key = "castle",
                secondKey = "moon",
                selective = true,
                insertOrder = 20,
                content = "Selective lore",
            ),
            LoreEntry(key = "/red\\s+moon/i", useRegex = true, insertOrder = 10, content = "Regex lore"),
            LoreEntry(alwaysActive = true, insertOrder = 40, content = "Always lore"),
        )
        val resolved = NativeLorebookProcessor.resolve(
            entries,
            history,
            GenerationSettings(loreBookDepth = 3, loreBookToken = 800),
            Random(1),
        )

        assertEquals(
            listOf("Regex lore", "Selective lore", "Library lore", "Always lore"),
            resolved.map { it.content },
        )
    }

    @Test
    fun decoratorsAffectMatchingRolePriorityAndBudget() {
        val entries = listOf(
            LoreEntry(
                key = "castle",
                insertOrder = 100,
                content = "@@match_full_word\n@@priority 1\nlow priority castle lore",
            ),
            LoreEntry(
                key = "library",
                insertOrder = 50,
                content = "@@priority 999\n@@role user\nhigh priority library lore",
            ),
            LoreEntry(
                alwaysActive = true,
                insertOrder = 25,
                content = "@@dont_activate\nshould not appear",
            ),
        )
        val resolved = NativeLorebookProcessor.resolve(
            entries,
            history,
            GenerationSettings(loreBookDepth = 1, loreBookToken = 8),
            Random(1),
        )

        assertEquals(1, resolved.size)
        assertEquals("high priority library lore", resolved.single().content)
        assertEquals("user", resolved.single().role)
        assertTrue(resolved.single().priority > 100)
    }
}
