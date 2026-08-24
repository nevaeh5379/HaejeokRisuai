package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.RuntimeStatePatch
import io.github.nevaeh5379.androidhaejeokrisuai.data.TriggerScript
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeLuaTriggerEngine
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeTriggerProcessor
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class NativeLuaTriggerEngineTest {
    private val settings = GenerationSettings(username = "Alice")
    private val character = CharacterProfile(id = "c", name = "Lua", description = "old description")
    private val history = listOf(MessageRecord("m", "chat", "user", "hello"))

    @Before
    fun resetBefore() = NativeLuaTriggerEngine.clearForTests()

    @After
    fun resetAfter() = NativeLuaTriggerEngine.clearForTests()

    @Test
    fun lua54SandboxChatApisAndModeStatePersistAcrossRuns() {
        val code = """
            local calls = 0
            function onStart(id)
                calls = calls + 1
                local bitwise = 5 & 3
                setChatVar(id, "calls", tostring(calls))
                setChatVar(id, "sandbox", (java == nil and io == nil and os == nil and package == nil and require == nil) and "safe" or "open")
                setChat(id, -1, getChatData(id, -1) .. ":" .. tostring(bitwise))
                addChat(id, "char", cbs("{{user}}") .. ":" .. tostring(calls))
            end
        """.trimIndent()

        val first = NativeLuaTriggerEngine.run(
            code = code, mode = "start", settings = settings, character = character,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
        )
        assertEquals("1", first.variables["calls"])
        assertEquals("safe", first.variables["sandbox"])
        assertEquals("hello:1", first.messages[0].data)
        assertEquals("Alice:1", first.messages[1].data)

        val second = NativeLuaTriggerEngine.run(
            code = code, mode = "start", settings = settings, character = character,
            messages = first.messages, variables = first.variables, chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = first.runtimePatch,
        )
        assertEquals("2", second.variables["calls"])
        assertEquals("Alice:1:1", second.messages[1].data)
        assertEquals("Alice:2", second.messages[2].data)
    }

    @Test
    fun stateHelpersRoundTripJsonAndFalseReturnStopsSending() {
        val code = """
            function onStart(id)
                local state = getState(id, "counter")
                if state == nil then state = { n = 0 } end
                state.n = state.n + 1
                setState(id, "counter", state)
                setDescription(id, "changed-" .. tostring(state.n))
                return false
            end
        """.trimIndent()

        val result = NativeLuaTriggerEngine.run(
            code = code, mode = "start", settings = settings, character = character,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "note",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
        )
        assertTrue(result.stopSending)
        assertEquals("{\"n\":1}", result.variables["__counter"])
        assertEquals("changed-1", result.runtimePatch.characterDescription)
        assertEquals("changed-1", result.runtimePatch.applyTo(character).description)
    }

    @Test
    fun triggerLuaUsesLifecycleModeInsteadOfTriggerType() {
        val trigger = TriggerScript(
            comment = "lua",
            type = "manual",
            effects = listOf(
                mapOf(
                    "type" to "triggerlua",
                    "code" to "function onStart(id) setChatVar(id, 'ran', 'yes') end",
                ),
            ),
        )
        val result = NativeTriggerProcessor.run(
            mode = "start", settings = settings,
            character = character.copy(triggerScripts = listOf(trigger)),
            messages = history, variables = emptyMap(), chatId = "chat",
        )
        assertEquals("yes", result.variables["ran"])
    }

    @Test
    fun triggerLuaDoesNotRunInsideRequestOrDisplayAllowlistedModes() {
        val trigger = TriggerScript(
            comment = "lua",
            type = "request",
            effects = listOf(
                mapOf(
                    "type" to "triggerlua",
                    "code" to "function request(id) setChatVar(id, 'unsafe', 'ran') end",
                ),
            ),
        )
        for (mode in listOf("request", "display")) {
            val result = NativeTriggerProcessor.run(
                mode = mode, settings = settings,
                character = character.copy(triggerScripts = listOf(trigger)),
                messages = history, variables = emptyMap(), chatId = "chat",
            )
            assertFalse(result.variables.containsKey("unsafe"))
        }
    }

    @Test
    fun characterMutationApisAreImmediatelyReadableAndPatchAllPersistedFields() {
        val code = """
            function onStart(id)
                setName(id, "Renamed")
                setCharacterFirstMessage(id, "new greeting")
                setDescription(id, "new description")
                setBackgroundEmbedding(id, "<div>new background</div>")
                setChatVar(id, "snapshot", table.concat({
                    getName(id), getCharacterFirstMessage(id), getDescription(id), getBackgroundEmbedding(id)
                }, "|"))
            end
        """.trimIndent()
        val base = character.copy(firstMessage = "old greeting", backgroundHtml = "old background")
        val result = NativeLuaTriggerEngine.run(
            code = code, mode = "start", settings = settings, character = base,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
        )
        assertEquals("Renamed|new greeting|new description|<div>new background</div>", result.variables["snapshot"])
        val patched = result.runtimePatch.applyTo(base)
        assertEquals("Renamed", patched.name)
        assertEquals("new greeting", patched.firstMessage)
        assertEquals("new description", patched.description)
        assertEquals("<div>new background</div>", patched.backgroundHtml)
        assertTrue(result.runtimePatch.hasCharacterChanges)
    }

    @Test
    fun loreApisSearchLocalThenGlobalAndUpsertRawLocalLoreImmediately() {
        val code = """
            function onStart(id)
                local before = getLoreBooks(id, "shared")
                setChatVar(id, "before", tostring(#before) .. ":" .. before[1].content .. ":" .. before[2].content)
                upsertLocalLoreBook(id, "shared", "updated {{user}}", {
                    alwaysActive = true, insertOrder = 42, key = "alpha", secondKey = "beta", regex = true
                })
                local after = getLoreBooks(id, "shared")
                setChatVar(id, "after", tostring(#after) .. ":" .. after[1].content .. ":" .. after[2].content)
            end
        """.trimIndent()
        val base = character.copy(
            globalLoreRaw = listOf(
                mapOf("comment" to "shared", "content" to "global {{user}}", "vendor" to "global-keep"),
            ),
        )
        val localRaw = listOf(
            mapOf("comment" to "other", "content" to "untouched", "vendor" to "keep-me"),
            mapOf("comment" to "shared", "content" to "local {{char}}", "legacy" to "replace-me"),
        )
        val result = NativeLuaTriggerEngine.run(
            code = code, mode = "start", settings = settings, character = base,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
            localLoreRaw = localRaw,
        )
        assertEquals("2:local Lua:global Alice", result.variables["before"])
        assertEquals("2:updated Alice:global Alice", result.variables["after"])
        val patched = result.runtimePatch.localLoreRaw!!
        assertEquals("keep-me", patched.first()["vendor"])
        val updated = patched.single { it["comment"] == "shared" }
        assertEquals("updated {{user}}", updated["content"])
        assertEquals(true, updated["alwaysActive"])
        assertEquals(42, (updated["insertorder"] as Number).toInt())
        assertEquals("alpha", updated["key"])
        assertEquals("beta", updated["secondkey"])
        assertEquals(true, updated["selective"])
        assertEquals(true, updated["useRegex"])
    }
}
