package io.github.nevaeh5379.androidhaejeokrisuai.generation

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.RuntimeStatePatch
import io.github.nevaeh5379.androidhaejeokrisuai.data.effectivePersonaPrompt
import io.github.nevaeh5379.androidhaejeokrisuai.data.loreEntriesFromValue
import io.github.nevaeh5379.androidhaejeokrisuai.data.loreEntryToValue
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID
import party.iroiro.luajava.JFunction
import party.iroiro.luajava.Lua
import party.iroiro.luajava.lua54.Lua54

internal data class NativeLuaTriggerResult(
    val messages: List<MessageRecord>,
    val variables: Map<String, String>,
    val stopSending: Boolean,
    val runtimePatch: RuntimeStatePatch,
)

internal data class NativeLuaLlmRequest(
    val settings: GenerationSettings,
    val character: CharacterProfile,
    val messages: List<MessageRecord>,
    val variables: Map<String, String>,
    val authorNote: String,
    val greetingIndex: Int,
    val prompt: List<NativePromptMessage>,
)

internal fun interface NativeLuaLlmBridge {
    fun complete(request: NativeLuaLlmRequest): String
}

/**
 * Native, plugin-free Risu trigger Lua host.
 *
 * Risu's browser runtime uses a persistent Lua VM per trigger mode. We preserve
 * that behavior while exposing only the deterministic/safe chat APIs needed by
 * trigger scripts. Java reflection, package loading, filesystem/process APIs,
 * and other host escape hatches are removed before card code is evaluated.
 */
internal object NativeLuaTriggerEngine {
    private class Execution(
        val baseSettings: GenerationSettings,
        val baseCharacter: CharacterProfile,
        val chatId: String,
        val authorNote: String,
        val greetingIndex: Int,
        val baseLocalLoreRaw: List<Map<String, Any?>>,
        val lowLevelAccess: Boolean,
        val llmBridge: NativeLuaLlmBridge?,
        val messages: MutableList<MessageRecord>,
        val variables: MutableMap<String, String>,
        var runtimePatch: RuntimeStatePatch,
        var stopSending: Boolean,
    ) {
        fun settings(): GenerationSettings = runtimePatch.applyTo(baseSettings)
        fun character(): CharacterProfile = runtimePatch.applyTo(baseCharacter)
        fun localLoreRaw(): List<Map<String, Any?>> = runtimePatch.localLoreRaw ?: baseLocalLoreRaw
        fun parserContext() = NativeRisuParserContext(
            settings = settings(),
            character = character(),
            history = messages,
            authorNote = runtimePatch.resolveAuthorNote(authorNote),
            greetingIndex = greetingIndex,
            variables = variables,
        )
        fun getVar(key: String): String =
            NativeRisuParser.parse("{{getvar::$key}}", parserContext())
    }

    private class EngineState(
        val lua: Lua,
        val code: String,
        var execution: Execution? = null,
    )

    private val states = mutableMapOf<String, EngineState>()
    private val modeLocks = mutableMapOf<String, Any>()
    private val requestRateLock = Any()
    private var lastRequestResetTime = 0L
    private var lastRequestsCount = 0

    fun run(
        code: String,
        mode: String,
        settings: GenerationSettings,
        character: CharacterProfile,
        messages: List<MessageRecord>,
        variables: Map<String, String>,
        chatId: String,
        authorNote: String,
        greetingIndex: Int,
        inheritedStop: Boolean,
        inheritedPatch: RuntimeStatePatch,
        localLoreRaw: List<Map<String, Any?>> = emptyList(),
        lowLevelAccess: Boolean = false,
        llmBridge: NativeLuaLlmBridge? = null,
    ): NativeLuaTriggerResult {
        if (code.isBlank()) {
            return NativeLuaTriggerResult(messages, variables, inheritedStop, inheritedPatch)
        }
        val lock = synchronized(modeLocks) { modeLocks.getOrPut(mode) { Any() } }
        synchronized(lock) {
            var state = synchronized(states) { states[mode] }
            if (state == null || state.code != code) {
                state?.lua?.close()
                state = createState(code)
                synchronized(states) { states[mode] = state }
            }
            val execution = Execution(
                baseSettings = settings,
                baseCharacter = character,
                chatId = chatId,
                authorNote = authorNote,
                greetingIndex = greetingIndex,
                baseLocalLoreRaw = localLoreRaw,
                lowLevelAccess = lowLevelAccess,
                llmBridge = llmBridge,
                messages = messages.toMutableList(),
                variables = variables.toMutableMap(),
                runtimePatch = inheritedPatch,
                stopSending = inheritedStop,
            )
            state.execution = execution
            try {
                invokeMode(state, mode)
            } catch (_: Throwable) {
                // Upstream Risu logs Lua callback failures and keeps the turn alive.
            } finally {
                state.execution = null
            }
            return NativeLuaTriggerResult(
                messages = execution.messages.toList(),
                variables = execution.variables.toMap(),
                stopSending = execution.stopSending,
                runtimePatch = execution.runtimePatch,
            )
        }
    }

    internal fun clearForTests() {
        synchronized(states) {
            states.values.forEach { runCatching { it.lua.close() } }
            states.clear()
        }
        synchronized(modeLocks) { modeLocks.clear() }
        synchronized(requestRateLock) {
            lastRequestResetTime = 0L
            lastRequestsCount = 0
        }
    }

    private fun createState(code: String): EngineState {
        val lua = Lua54()
        try {
            lua.openLibraries()
            installJson(lua)
            sandbox(lua)
            val state = EngineState(lua, code)
            installApis(state)
            lua.run(COMPAT_WRAPPER)
            lua.run(code)
            return state
        } catch (error: Throwable) {
            runCatching { lua.close() }
            throw error
        }
    }

    private fun installJson(lua: Lua) {
        val source = NativeLuaTriggerEngine::class.java.classLoader
            ?.getResourceAsStream("lua/json.lua")
            ?.bufferedReader()
            ?.use { it.readText() }
            ?: error("Bundled Risu json.lua resource is missing")
        val value = lua.eval(source).firstOrNull() ?: error("Risu json.lua returned no module")
        lua.set("json", value)
    }

    private fun sandbox(lua: Lua) {
        for (name in SANDBOXED_GLOBALS) {
            lua.pushNil()
            lua.setGlobal(name)
        }
    }

    private fun invokeMode(state: EngineState, mode: String) {
        val functionName = when (mode) {
            "input" -> "onInput"
            "output" -> "onOutput"
            "start" -> "onStart"
            else -> mode
        }
        val function = state.lua.get(functionName)
        if (function.type() != Lua.LuaType.FUNCTION) return
        val result = function.call(UUID.randomUUID().toString()).firstOrNull()
        if (result?.type() == Lua.LuaType.BOOLEAN && !result.toBoolean()) {
            state.execution?.stopSending = true
        }
    }

    private fun installApis(state: EngineState) {
        register(state, "getChatVar") { lua, execution ->
            push(lua, execution.getVar(stringArg(lua, 2)))
        }
        register(state, "setChatVar") { lua, execution ->
            val key = stringArg(lua, 2)
            execution.variables[key] = stringArg(lua, 3)
            0
        }
        register(state, "setChatVarChanged") { lua, execution ->
            val key = stringArg(lua, 2)
            val value = stringArg(lua, 3)
            val changed = execution.getVar(key) != value
            if (changed) execution.variables[key] = value
            push(lua, changed)
        }
        register(state, "getGlobalVar") { lua, execution ->
            push(lua, execution.settings().globalChatVariables[stringArg(lua, 2)] ?: "null")
        }
        register(state, "stopChat") { _, execution ->
            execution.stopSending = true
            0
        }
        register(state, "getChatMain") { lua, execution ->
            val message = messageAt(execution.messages, integerArg(lua, 2))
            push(lua, message?.let(::messageJson) ?: "null")
        }
        register(state, "getChatData") { lua, execution ->
            push(lua, messageAt(execution.messages, integerArg(lua, 2))?.data.orEmpty())
        }
        register(state, "getChatRole") { lua, execution ->
            push(lua, messageAt(execution.messages, integerArg(lua, 2))?.role.orEmpty())
        }
        register(state, "getRecentChatsMain") { lua, execution ->
            val count = integerArg(lua, 2).coerceAtLeast(0)
            val data = execution.messages.takeLast(count).map(::messageValue)
            push(lua, NativeRisuParser.stringifyJson(data))
        }
        register(state, "setChat") { lua, execution ->
            val index = atIndex(integerArg(lua, 2), execution.messages.size)
            if (index >= 0) {
                execution.messages[index] = execution.messages[index].copy(data = stringArg(lua, 3))
            }
            0
        }
        register(state, "setChatRole") { lua, execution ->
            val index = atIndex(integerArg(lua, 2), execution.messages.size)
            if (index >= 0) {
                val role = if (stringArg(lua, 3) == "user") "user" else "char"
                execution.messages[index] = execution.messages[index].copy(role = role)
            }
            0
        }
        register(state, "cutChat") { lua, execution ->
            val size = execution.messages.size
            val start = sliceIndex(integerArg(lua, 2), size)
            val end = sliceIndex(integerArg(lua, 3), size)
            val sliced = if (start < end) execution.messages.subList(start, end).toList() else emptyList()
            execution.messages.clear()
            execution.messages += sliced
            0
        }
        register(state, "removeChat") { lua, execution ->
            val index = spliceIndex(integerArg(lua, 2), execution.messages.size)
            if (index in execution.messages.indices) execution.messages.removeAt(index)
            0
        }
        register(state, "addChat") { lua, execution ->
            execution.messages += newMessage(execution, stringArg(lua, 2), stringArg(lua, 3))
            0
        }
        register(state, "insertChat") { lua, execution ->
            val index = spliceIndex(integerArg(lua, 2), execution.messages.size)
            execution.messages.add(index, newMessage(execution, stringArg(lua, 3), stringArg(lua, 4)))
            0
        }
        register(state, "getChatLength") { lua, execution -> push(lua, execution.messages.size.toLong()) }
        register(state, "getFullChatMain") { lua, execution ->
            push(lua, NativeRisuParser.stringifyJson(execution.messages.map(::messageValue)))
        }
        register(state, "setFullChatMain") { lua, execution ->
            replaceFullChat(execution, stringArg(lua, 2))
            0
        }
        register(state, "cbs") { lua, execution ->
            push(lua, NativeRisuParser.parse(stringArg(lua, 1), execution.parserContext()))
        }
        register(state, "hashMain") { lua, _ -> push(lua, sha256Hex(stringArg(lua, 2))) }
        register(state, "sleepMain") { lua, _ ->
            val millis = integerArg(lua, 2).coerceAtLeast(0).toLong()
            if (millis > 0) Thread.sleep(millis)
            push(lua, true)
        }
        register(state, "requestMain") { lua, execution ->
            if (!execution.lowLevelAccess) return@register 0
            push(lua, scriptedRequest(stringArg(lua, 2)))
        }
        register(state, "simpleLLMMain") { lua, execution ->
            if (!execution.lowLevelAccess) return@register 0
            val bridge = execution.llmBridge
                ?: return@register push(lua, llmResult(false, "Error: Native LLM bridge is unavailable"))
            val request = NativeLuaLlmRequest(
                settings = execution.settings(),
                character = execution.character(),
                messages = execution.messages.toList(),
                variables = execution.variables.toMap(),
                authorNote = execution.runtimePatch.resolveAuthorNote(execution.authorNote),
                greetingIndex = execution.greetingIndex,
                prompt = listOf(NativePromptMessage("user", stringArg(lua, 2))),
            )
            val result = runCatching { bridge.complete(request) }
                .fold(
                    onSuccess = { llmResult(true, it) },
                    onFailure = { llmResult(false, "Error: ${it.message ?: it::class.java.simpleName}") },
                )
            push(lua, result)
        }
        register(state, "logMain") { _, _ -> 0 }
        register(state, "reloadDisplay") { _, _ -> 0 }
        register(state, "reloadChat") { _, _ -> 0 }
        register(state, "getName") { lua, execution -> push(lua, execution.character().name) }
        register(state, "setName") { lua, execution ->
            execution.runtimePatch = execution.runtimePatch.copy(characterName = stringArg(lua, 2))
            0
        }
        register(state, "getDescription") { lua, execution -> push(lua, execution.character().description) }
        register(state, "setDescription") { lua, execution ->
            execution.runtimePatch = execution.runtimePatch.copy(characterDescription = stringArg(lua, 2))
            0
        }
        register(state, "getCharacterFirstMessage") { lua, execution ->
            push(lua, execution.character().firstMessage)
        }
        register(state, "setCharacterFirstMessage") { lua, execution ->
            execution.runtimePatch = execution.runtimePatch.copy(characterFirstMessage = stringArg(lua, 2))
            push(lua, true)
        }
        register(state, "getPersonaName") { lua, execution -> push(lua, execution.settings().username) }
        register(state, "getPersonaDescription") { lua, execution ->
            val parsed = NativeRisuParser.parse(execution.settings().effectivePersonaPrompt(), execution.parserContext())
            push(lua, parsed)
        }
        register(state, "getAuthorsNote") { lua, execution ->
            push(lua, execution.runtimePatch.resolveAuthorNote(execution.authorNote))
        }
        register(state, "getBackgroundEmbedding") { lua, execution ->
            push(lua, execution.character().backgroundHtml)
        }
        register(state, "setBackgroundEmbedding") { lua, execution ->
            execution.runtimePatch = execution.runtimePatch.copy(characterBackgroundHtml = stringArg(lua, 2))
            push(lua, true)
        }
        register(state, "getLoreBooksMain") { lua, execution ->
            val search = stringArg(lua, 2)
            val character = execution.character()
            val globalRaw = character.globalLoreRaw.takeIf { it.isNotEmpty() }
                ?: character.globalLore.map(::loreEntryToValue)
            val found = (execution.localLoreRaw() + globalRaw).mapNotNull { raw ->
                if (raw["comment"]?.toString().orEmpty() != search) return@mapNotNull null
                LinkedHashMap(raw).apply {
                    put(
                        "content",
                        NativeRisuParser.parse(raw["content"]?.toString().orEmpty(), execution.parserContext()),
                    )
                }
            }
            push(lua, NativeRisuParser.stringifyJson(found))
        }
        register(state, "loadLoreBooksMain") { lua, execution ->
            if (!execution.lowLevelAccess) return@register 0
            val settings = execution.settings()
            val reserve = integerArg(lua, 2).coerceAtLeast(0)
            val remainingContext = settings.maxContext - reserve
            if (remainingContext < 0) return@register push(lua, "[]")
            val character = execution.character()
            val globalLore = character.globalLore.takeIf { it.isNotEmpty() }
                ?: loreEntriesFromValue(character.globalLoreRaw)
            val combinedLore = globalLore + loreEntriesFromValue(execution.localLoreRaw())
            val activeLore = NativeLorebookProcessor.resolve(combinedLore, execution.messages, settings)
            val payload = mutableListOf<Map<String, Any?>>()
            var usedTokens = 0
            for (lore in activeLore) {
                val parsed = NativeRisuParser.parse(lore.content, execution.parserContext()).trim()
                if (parsed.isEmpty()) continue
                val estimatedTokens = ((parsed.length + 3) / 4).coerceAtLeast(1)
                if (usedTokens + estimatedTokens > remainingContext) break
                usedTokens += estimatedTokens
                payload += linkedMapOf(
                    "data" to parsed,
                    "role" to if (lore.role == "assistant") "char" else lore.role,
                )
            }
            push(lua, NativeRisuParser.stringifyJson(payload))
        }
        register(state, "upsertLocalLoreBook") { lua, execution ->
            val name = stringArg(lua, 2)
            val content = stringArg(lua, 3)
            val options: Map<String, Any?> = if (lua.isTable(4)) {
                lua.toMap(4)?.entries?.associate { (key, value) -> key.toString() to value }.orEmpty()
            } else emptyMap()
            val alwaysActive = optionBoolean(options["alwaysActive"], false)
            val insertOrder = optionInt(options["insertOrder"], 100)
            val key = options["key"]?.toString().orEmpty()
            val secondKey = options["secondKey"]?.toString().orEmpty()
            val regex = optionBoolean(options["regex"], false)
            val updated = execution.localLoreRaw()
                .filterNot { it["comment"]?.toString().orEmpty() == name }
                .mapTo(mutableListOf<Map<String, Any?>>()) { LinkedHashMap(it) }
            updated += linkedMapOf(
                "alwaysActive" to alwaysActive, "comment" to name, "content" to content,
                "insertorder" to insertOrder, "mode" to "normal", "key" to key,
                "secondkey" to secondKey, "selective" to secondKey.isNotEmpty(), "useRegex" to regex,
            )
            execution.runtimePatch = execution.runtimePatch.copy(localLoreRaw = updated)
            0
        }
        register(state, "getCharacterLastMessage") { lua, execution ->
            push(lua, execution.messages.asReversed().firstOrNull { it.role != "user" }?.data
                ?: execution.character().firstMessage)
        }
        register(state, "getUserLastMessage") { lua, execution ->
            push(lua, execution.messages.asReversed().firstOrNull { it.role == "user" }?.data.orEmpty())
        }
    }

    private fun register(state: EngineState, name: String, body: (Lua, Execution) -> Int) {
        state.lua.push(JFunction { lua ->
            val execution = state.execution
            if (execution == null) 0 else body(lua, execution)
        })
        state.lua.setGlobal(name)
    }

    private fun stringArg(lua: Lua, index: Int): String =
        if (lua.isNoneOrNil(index)) "" else lua.toString(index).orEmpty()

    private fun integerArg(lua: Lua, index: Int): Int {
        if (lua.isNoneOrNil(index)) return 0
        val value = if (lua.isInteger(index)) lua.toInteger(index) else lua.toNumber(index).toLong()
        return value.coerceIn(Int.MIN_VALUE.toLong(), Int.MAX_VALUE.toLong()).toInt()
    }

    private fun optionBoolean(value: Any?, fallback: Boolean): Boolean = when (value) {
        is Boolean -> value
        is Number -> value.toInt() != 0
        is String -> when {
            value.equals("true", ignoreCase = true) || value == "1" -> true
            value.equals("false", ignoreCase = true) || value == "0" -> false
            else -> fallback
        }
        else -> fallback
    }

    private fun optionInt(value: Any?, fallback: Int): Int =
        (value as? Number)?.toInt() ?: value?.toString()?.toDoubleOrNull()?.toInt() ?: fallback

    private fun sha256Hex(value: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(StandardCharsets.UTF_8))
        val digits = "0123456789abcdef"
        return buildString(digest.size * 2) {
            for (byte in digest) {
                val unsigned = byte.toInt() and 0xff
                append(digits[unsigned ushr 4])
                append(digits[unsigned and 0x0f])
            }
        }
    }

    private fun scriptedRequest(url: String): String {
        val rateLimited = synchronized(requestRateLock) {
            val now = System.currentTimeMillis()
            if (lastRequestResetTime + REQUEST_WINDOW_MS < now) {
                lastRequestsCount = 0
                lastRequestResetTime = now
            }
            if (lastRequestsCount > REQUEST_LIMIT_THRESHOLD) true else {
                lastRequestsCount++
                false
            }
        }
        if (rateLimited) return requestResult(429, "Too many requests. you can request 5 times per minute")
        if (url.length > MAX_SCRIPT_REQUEST_URL_LENGTH) {
            return requestResult(413, "URL to large. max is 120 characters")
        }
        if (!url.startsWith("https://")) return requestResult(400, "Only https requests are allowed")
        if (BANNED_SCRIPT_REQUEST_PREFIXES.any(url::startsWith)) {
            return requestResult(400, "request to $url is not allowed")
        }
        return try {
            val connection = URL(url).openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "GET"
                connection.instanceFollowRedirects = true
                val status = connection.responseCode
                val stream = if (status >= 400) connection.errorStream else connection.inputStream
                val body = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
                requestResult(status, body)
            } finally {
                connection.disconnect()
            }
        } catch (_: Throwable) {
            requestResult(400, "internal error")
        }
    }

    private fun requestResult(status: Int, data: String): String =
        NativeRisuParser.stringifyJson(linkedMapOf("status" to status, "data" to data))

    private fun llmResult(success: Boolean, result: String): String =
        NativeRisuParser.stringifyJson(linkedMapOf("success" to success, "result" to result))

    private fun push(lua: Lua, value: String): Int {
        lua.push(value)
        return 1
    }

    private fun push(lua: Lua, value: Boolean): Int {
        lua.push(value)
        return 1
    }

    private fun push(lua: Lua, value: Long): Int {
        lua.push(value)
        return 1
    }

    private fun messageAt(messages: List<MessageRecord>, index: Int): MessageRecord? {
        val actual = atIndex(index, messages.size)
        return if (actual < 0) null else messages[actual]
    }

    private fun atIndex(index: Int, size: Int): Int {
        val actual = if (index < 0) size + index else index
        return actual.takeIf { it in 0 until size } ?: -1
    }

    private fun sliceIndex(index: Int, size: Int): Int =
        if (index < 0) (size + index).coerceAtLeast(0) else index.coerceAtMost(size)

    private fun spliceIndex(index: Int, size: Int): Int =
        if (index < 0) (size + index).coerceAtLeast(0) else index.coerceAtMost(size)

    private fun newMessage(execution: Execution, role: String, data: String) = MessageRecord(
        id = UUID.randomUUID().toString(),
        chatId = execution.chatId,
        role = if (role == "user") "user" else "char",
        data = data,
    )

    private fun messageValue(message: MessageRecord): Map<String, Any?> = linkedMapOf(
        "role" to message.role,
        "data" to message.data,
        "time" to (message.time ?: 0L),
    )

    private fun messageJson(message: MessageRecord): String =
        NativeRisuParser.stringifyJson(messageValue(message))

    private fun replaceFullChat(execution: Execution, encoded: String) {
        val decoded = NativeRisuParser.parseJsonArray(encoded) ?: return
        val replacement = decoded.mapIndexedNotNull { index, item ->
            val map = item as? Map<*, *> ?: return@mapIndexedNotNull null
            val role = if (map["role"]?.toString() == "user") "user" else "char"
            val data = map["data"]?.toString().orEmpty()
            val old = execution.messages.getOrNull(index)
            MessageRecord(
                id = old?.id ?: UUID.randomUUID().toString(),
                chatId = execution.chatId,
                role = role,
                data = data,
                name = old?.name,
                time = (map["time"] as? Number)?.toLong() ?: old?.time,
            )
        }
        execution.messages.clear()
        execution.messages += replacement
    }

    private const val REQUEST_WINDOW_MS = 60_000L
    private const val REQUEST_LIMIT_THRESHOLD = 5
    private const val MAX_SCRIPT_REQUEST_URL_LENGTH = 120
    private val BANNED_SCRIPT_REQUEST_PREFIXES = listOf(
        "https://realm.risuai.net", "https://risuai.net", "https://risuai.xyz",
    )
    private val SANDBOXED_GLOBALS = listOf(
        "java", "io", "os", "debug", "package", "require", "dofile", "loadfile",
    )

    private const val COMPAT_WRAPPER = """
local function resolvedPromise(value)
    return { await = function(self) return value end }
end

function hash(id, value)
    return resolvedPromise(hashMain(id, value))
end

function sleep(id, time)
    return resolvedPromise(sleepMain(id, time))
end

function request(id, url)
    return resolvedPromise(requestMain(id, url))
end

function simpleLLM(id, prompt)
    local raw = simpleLLMMain(id, prompt)
    if raw == nil then
        return resolvedPromise(nil)
    end
    return resolvedPromise(json.decode(raw))
end

function getChat(id, index)
    return json.decode(getChatMain(id, index))
end

function getFullChat(id)
    return json.decode(getFullChatMain(id))
end

function getRecentChats(id, count)
    return json.decode(getRecentChatsMain(id, count))
end

function getLoreBooks(id, search)
    return json.decode(getLoreBooksMain(id, search))
end

function loadLoreBooks(id, reserve)
    return json.decode(loadLoreBooksMain(id, reserve or 0))
end

function setFullChat(id, value)
    setFullChatMain(id, json.encode(value))
end

function log(value)
    logMain(json.encode(value))
end

function getState(id, name)
    local escapedName = "__" .. name
    return json.decode(getChatVar(id, escapedName))
end

function setState(id, name, value)
    local escapedName = "__" .. name
    setChatVar(id, escapedName, json.encode(value))
end

function setStateChanged(id, name, value)
    local escapedName = "__" .. name
    return setChatVarChanged(id, escapedName, json.encode(value))
end
"""
}
