package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.RuntimeStatePatch
import io.github.nevaeh5379.androidhaejeokrisuai.data.TriggerScript
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeLuaLlmBridge
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeLuaTriggerEngine
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativePromptMessage
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

    @Test
    fun loadLoreBooksRequiresLowLevelAccessAndAppliesContextReserve() {
        val code = """
            function onStart(id)
                local raw = loadLoreBooksMain(id, 0)
                if raw == nil then
                    setChatVar(id, "denied", "yes")
                    return
                end
                local books = loadLoreBooks(id, 0)
                local sawGlobal, sawLocal, globalRole = false, false, ""
                for _, book in ipairs(books) do
                    if book.data == "Global Alice" then sawGlobal = true; globalRole = book.role end
                    if book.data == "Local Lua" then sawLocal = true end
                end
                local exhausted = loadLoreBooks(id, 101)
                setChatVar(id, "loaded", tostring(#books) .. ":" .. tostring(sawGlobal) .. ":" .. tostring(sawLocal) .. ":" .. globalRole)
                setChatVar(id, "exhausted", tostring(#exhausted))
            end
        """.trimIndent()
        val base = character.copy(
            globalLoreRaw = listOf(
                mapOf(
                    "comment" to "global", "content" to "@@role assistant\nGlobal {{user}}",
                    "alwaysActive" to true, "insertorder" to 10,
                ),
            ),
        )
        val localRaw = listOf(
            mapOf(
                "comment" to "local", "content" to "Local {{char}}",
                "alwaysActive" to true, "insertorder" to 20,
            ),
        )
        val runtimeSettings = settings.copy(loreBookToken = 100, maxContext = 100)
        val denied = NativeLuaTriggerEngine.run(
            code = code, mode = "start", settings = runtimeSettings, character = base,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
            localLoreRaw = localRaw, lowLevelAccess = false,
        )
        assertEquals("yes", denied.variables["denied"])

        NativeLuaTriggerEngine.clearForTests()
        val allowed = NativeLuaTriggerEngine.run(
            code = code, mode = "start", settings = runtimeSettings, character = base,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
            localLoreRaw = localRaw, lowLevelAccess = true,
        )
        assertEquals("2:true:true:char", allowed.variables["loaded"])
        assertEquals("0", allowed.variables["exhausted"])
    }

    @Test
    fun sleepReturnsAwaitableTrueWithoutChangingLuaCallShape() {
        val code = """
            function onStart(id)
                local pending = sleep(id, 1)
                setChatVar(id, "sleep", type(pending) .. ":" .. tostring(pending:await()))
            end
        """.trimIndent()
        val result = NativeLuaTriggerEngine.run(
            code = code, mode = "start", settings = settings, character = character,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
        )
        assertEquals("table:true", result.variables["sleep"])
    }

    @Test
    fun requestPreservesLowLevelValidationAndRateLimitSemantics() {
        val deniedCode = """
            function onStart(id)
                setChatVar(id, "denied", tostring(request(id, "http://example.com"):await() == nil))
            end
        """.trimIndent()
        val denied = NativeLuaTriggerEngine.run(
            code = deniedCode, mode = "start", settings = settings, character = character,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
            lowLevelAccess = false,
        )
        assertEquals("true", denied.variables["denied"])

        NativeLuaTriggerEngine.clearForTests()
        val validationCode = """
            function onStart(id)
                local insecure = json.decode(request(id, "http://example.com"):await())
                local banned = json.decode(request(id, "https://risuai.net/test"):await())
                local longUrl = "https://example.com/" .. string.rep("a", 121)
                local tooLong = json.decode(request(id, longUrl):await())
                setChatVar(id, "validation", tostring(insecure.status) .. ":" .. tostring(banned.status) .. ":" .. tostring(tooLong.status))
            end
        """.trimIndent()
        val validation = NativeLuaTriggerEngine.run(
            code = validationCode, mode = "start", settings = settings, character = character,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
            lowLevelAccess = true,
        )
        assertEquals("400:400:413", validation.variables["validation"])

        NativeLuaTriggerEngine.clearForTests()
        val rateCode = """
            function onStart(id)
                local status = 0
                for i = 1, 7 do
                    status = json.decode(request(id, "http://x"):await()).status
                end
                setChatVar(id, "rate", tostring(status))
            end
        """.trimIndent()
        val rate = NativeLuaTriggerEngine.run(
            code = rateCode, mode = "start", settings = settings, character = character,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
            lowLevelAccess = true,
        )
        assertEquals("429", rate.variables["rate"])
    }

    @Test
    fun simpleLlmUsesLowLevelBridgeAndCurrentRuntimeState() {
        var calls = 0
        val bridge = NativeLuaLlmBridge { request ->
            calls++
            assertEquals("Runtime Lua", request.character.name)
            assertEquals("Alice", request.settings.username)
            assertEquals(listOf(NativePromptMessage("user", "raw {{user}} prompt")), request.prompt)
            "model reply"
        }
        val code = """
            function onStart(id)
                setName(id, "Runtime Lua")
                local response = simpleLLM(id, "raw {{user}} prompt"):await()
                setChatVar(id, "llm", tostring(response.success) .. ":" .. response.result)
            end
        """.trimIndent()
        val result = NativeLuaTriggerEngine.run(
            code = code, mode = "start", settings = settings, character = character,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "note",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
            lowLevelAccess = true, llmBridge = bridge,
        )
        assertEquals(1, calls)
        assertEquals("true:model reply", result.variables["llm"])
    }

    @Test
    fun multiMessageLlmMapsRisuRolesAndReturnsAwaitableResult() {
        var calls = 0
        val bridge = NativeLuaLlmBridge { request ->
            calls++
            assertEquals("model", request.mode)
            assertEquals(
                listOf(
                    NativePromptMessage("system", "system text"),
                    NativePromptMessage("user", "user text"),
                    NativePromptMessage("assistant", "char text"),
                    NativePromptMessage("assistant", "fallback text"),
                ),
                request.prompt,
            )
            "multi reply"
        }
        val code = """
            function onStart(id)
                local response = LLM(id, {
                    { role = "sys", content = "system text" },
                    { role = "user", content = "user text" },
                    { role = "char", content = "char text" },
                    { role = "unknown", content = "fallback text" }
                }, false, { streaming = true })
                setChatVar(id, "multi", tostring(response.success) .. ":" .. response.result)
            end
        """.trimIndent()
        val result = NativeLuaTriggerEngine.run(
            code = code, mode = "start", settings = settings, character = character,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
            lowLevelAccess = true, llmBridge = bridge,
        )
        assertEquals(1, calls)
        assertEquals("true:multi reply", result.variables["multi"])
    }

    @Test
    fun axLlmUsesOtherAxModelModeWithSameStructuredPromptShape() {
        var calls = 0
        val bridge = NativeLuaLlmBridge { request ->
            calls++
            assertEquals("otherAx", request.mode)
            assertEquals(
                listOf(
                    NativePromptMessage("system", "aux system"),
                    NativePromptMessage("user", "aux user"),
                ),
                request.prompt,
            )
            "aux reply"
        }
        val code = """
            function onStart(id)
                local response = axLLM(id, {
                    { role = "system", content = "aux system" },
                    { role = "user", content = "aux user" }
                })
                setChatVar(id, "ax", tostring(response.success) .. ":" .. response.result)
            end
        """.trimIndent()
        val result = NativeLuaTriggerEngine.run(
            code = code, mode = "start", settings = settings, character = character,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
            lowLevelAccess = true, llmBridge = bridge,
        )
        assertEquals(1, calls)
        assertEquals("true:aux reply", result.variables["ax"])
    }

    @Test
    fun multiMessageLlmRejectsMultimodalUntilNativeAssetBridgeExists() {
        var calls = 0
        val bridge = NativeLuaLlmBridge {
            calls++
            "should not run"
        }
        val code = """
            function onStart(id)
                local response = LLM(id, {{ role = "user", content = "{{inlay::asset}}" }}, true)
                setChatVar(id, "multi", tostring(response.success) .. ":" .. response.result)
            end
        """.trimIndent()
        val result = NativeLuaTriggerEngine.run(
            code = code, mode = "start", settings = settings, character = character,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
            lowLevelAccess = true, llmBridge = bridge,
        )
        assertEquals(0, calls)
        assertEquals(
            "false:Error: Native Lua multimodal LLM is not supported yet",
            result.variables["multi"],
        )
    }

    @Test
    fun simpleLlmIsDeniedWithoutLowLevelAccessAndReportsBridgeFailures() {
        var calls = 0
        val bridge = NativeLuaLlmBridge {
            calls++
            error("bridge exploded")
        }
        val deniedCode = """
            function onStart(id)
                local response = simpleLLM(id, "test"):await()
                setChatVar(id, "denied", tostring(response == nil))
            end
        """.trimIndent()
        val denied = NativeLuaTriggerEngine.run(
            code = deniedCode, mode = "start", settings = settings, character = character,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
            lowLevelAccess = false, llmBridge = bridge,
        )
        assertEquals("true", denied.variables["denied"])
        assertEquals(0, calls)

        NativeLuaTriggerEngine.clearForTests()
        val failureCode = """
            function onStart(id)
                local response = simpleLLM(id, "test"):await()
                setChatVar(id, "failure", tostring(response.success) .. ":" .. response.result)
            end
        """.trimIndent()
        val failure = NativeLuaTriggerEngine.run(
            code = failureCode, mode = "start", settings = settings, character = character,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
            lowLevelAccess = true, llmBridge = bridge,
        )
        assertEquals("false:Error: bridge exploded", failure.variables["failure"])
        assertEquals(1, calls)
    }

    @Test
    fun hashReturnsRisuCompatibleSha256ThroughAwaitableValue() {
        val code = """
            function onStart(id)
                local pending = hash(id, "hello")
                setChatVar(id, "hash", type(pending) .. ":" .. pending:await())
            end
        """.trimIndent()
        val result = NativeLuaTriggerEngine.run(
            code = code, mode = "start", settings = settings, character = character,
            messages = history, variables = emptyMap(), chatId = "chat", authorNote = "",
            greetingIndex = -1, inheritedStop = false, inheritedPatch = RuntimeStatePatch(),
        )
        assertEquals(
            "table:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            result.variables["hash"],
        )
    }
}
