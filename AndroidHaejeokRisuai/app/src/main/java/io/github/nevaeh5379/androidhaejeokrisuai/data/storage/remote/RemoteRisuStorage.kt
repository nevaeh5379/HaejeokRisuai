package io.github.nevaeh5379.androidhaejeokrisuai.data.storage.remote

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterImportPayload
import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.ChatSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.ChatPromptContext
import io.github.nevaeh5379.androidhaejeokrisuai.data.DatabaseOverview
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettingsMapper
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessagePage
import io.github.nevaeh5379.androidhaejeokrisuai.data.LoreEntry
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.PositionedMessage
import io.github.nevaeh5379.androidhaejeokrisuai.data.RuntimeStatePatch
import io.github.nevaeh5379.androidhaejeokrisuai.data.loreEntriesFromValue
import io.github.nevaeh5379.androidhaejeokrisuai.data.regexScriptsFromValue
import io.github.nevaeh5379.androidhaejeokrisuai.data.triggerScriptsFromValue
import io.github.nevaeh5379.androidhaejeokrisuai.data.storage.RisuStorage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class RemoteRisuStorage(
    baseUrl: String,
    private val authToken: String,
) : RisuStorage {
    private val baseUrl = normalizeBaseUrl(baseUrl)
    @Volatile private var revision: Long = 0

    override suspend fun init() = Unit

    override suspend fun loadDatabase(): DatabaseOverview = withContext(Dispatchers.IO) {
        val body = request("GET", "/api/database-v2?shallow=true")
        val json = JSONObject(body)
        revision = json.optLong("revision", 0)
        val database = json.optJSONObject("database")
        val charactersJson = database?.optJSONArray("characters") ?: JSONArray()
        val characters = buildList {
            for (index in 0 until charactersJson.length()) {
                val item = charactersJson.optJSONObject(index) ?: continue
                add(
                    CharacterSummary(
                        id = item.optString("chaId"),
                        name = item.optString("name"),
                        image = item.optString("image"),
                        kind = item.optString("type", "character"),
                        lastInteraction = item.optLongOrNull("lastInteraction"),
                    ),
                )
            }
        }
        val settingValues = linkedMapOf<String, Any?>()
        if (database != null) {
            for (key in GenerationSettingsMapper.keys) {
                if (database.has(key) && !database.isNull(key)) settingValues[key] = jsonValue(database.opt(key))
            }
        }
        val baseSettings = GenerationSettingsMapper.fromMap(settingValues)
        val activePresetId = database?.optString("activeBotPresetId")
            ?.takeIf { it.isNotBlank() }
            ?: loadSettingValueOptional("activeBotPresetId")?.toString()?.takeIf { it.isNotBlank() }
        val activePreset = activePresetId?.let { loadPresetOptional(it) }
        DatabaseOverview(
            status = json.optString("status", "empty"),
            revision = revision,
            characters = characters,
            generationSettings = activePreset?.let { GenerationSettingsMapper.applyPreset(baseSettings, it) } ?: baseSettings,
            activePresetId = activePresetId?.takeIf { activePreset != null },
            activePresetName = activePreset?.get("name")?.toString(),
        )
    }

    override suspend fun loadCharacterProfile(characterId: String): CharacterProfile = withContext(Dispatchers.IO) {
        val encoded = encodePath(characterId)
        val character = JSONObject(request("GET", "/api/database-v2/characters/$encoded"))
            .getJSONObject("character")
        CharacterProfile(
            id = characterId,
            name = character.optString("name"),
            firstMessage = character.optString("firstMessage"),
            alternateGreetings = jsonStringList(character.optJSONArray("alternateGreetings")),
            exampleMessage = character.optString("exampleMessage"),
            defaultVariables = character.optString("defaultVariables"),
            regexScripts = regexScriptsFromValue(jsonValue(character.opt("customscript"))),
            triggerScripts = triggerScriptsFromValue(jsonValue(character.opt("triggerscript"))),
            description = character.optString("desc"),
            personality = character.optString("personality"),
            scenario = character.optString("scenario"),
            systemPrompt = character.optString("systemPrompt"),
            replaceGlobalNote = character.optString("replaceGlobalNote"),
            globalLore = loreEntriesFromValue(jsonValue(character.opt("globalLore"))),
        )
    }

    override suspend fun loadCharacterChats(characterId: String): List<ChatSummary> = withContext(Dispatchers.IO) {
        val encoded = encodePath(characterId)
        val character = JSONObject(request("GET", "/api/database-v2/characters/$encoded"))
            .getJSONObject("character")
        val chats = character.optJSONArray("chats") ?: JSONArray()
        buildList {
            for (index in 0 until chats.length()) {
                val item = chats.optJSONObject(index) ?: continue
                add(
                    ChatSummary(
                        id = item.optString("id"),
                        characterId = characterId,
                        name = item.optString("name"),
                        note = item.optString("note"),
                        lastMessageTime = item.optLongOrNull("lastDate"),
                    ),
                )
            }
        }
    }

    override suspend fun importCharacter(payload: CharacterImportPayload): CharacterSummary = withContext(Dispatchers.IO) {
        val snapshot = loadDatabase()
        val characterId = java.util.UUID.randomUUID().toString()
        val chatId = java.util.UUID.randomUUID().toString()
        val data = payload.data.toMutableMap().apply {
            put("name", payload.name)
            put("image", "") // Remote asset upload is a separate transport concern.
            put("type", "character")
        }
        val chatData = linkedMapOf<String, Any?>(
            "name" to "Chat 1",
            "note" to "",
            "localLore" to emptyList<Any?>(),
            "fmIndex" to -1,
        )
        val commit = JSONObject()
            .put("baseRevision", revision)
            .put("action", "android:character-import")
            .put("root", JSONObject().put("upserts", JSONArray()).put("deletes", JSONArray()))
            .put(
                "characters",
                JSONArray().put(
                    JSONObject()
                        .put("id", characterId)
                        .put("position", snapshot.characters.size)
                        .put("data", toJsonValue(data)),
                ),
            )
            .put(
                "chats",
                JSONArray().put(
                    JSONObject()
                        .put("id", chatId)
                        .put("characterId", characterId)
                        .put("position", 0)
                        .put("data", toJsonValue(chatData)),
                ),
            )
            .put("chatManifests", JSONArray())
            .put("messages", JSONArray())
            .put("messageManifests", JSONArray())
        val response = JSONObject(request("POST", "/api/database-v2/commit", commit.toString()))
        revision = response.optLong("revision", revision + 1)
        CharacterSummary(id = characterId, name = payload.name)
    }

    override suspend fun updateGenerationSettings(settings: io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings): Long = withContext(Dispatchers.IO) {
        val snapshot = loadDatabase() // Refresh revision and active preset before writing.
        val google = (loadSettingValueOptional("google") as? Map<*, *>)
            ?.entries
            ?.associateTo(linkedMapOf<String, Any?>()) { (key, value) -> key.toString() to value }
            ?: linkedMapOf()
        google["accessToken"] = settings.googleApiKey

        val rootUpdates = linkedMapOf<String, Any?>(
            "username" to settings.username,
            "openAIKey" to settings.openAIKey,
            "claudeAPIKey" to settings.claudeAPIKey,
            "openrouterKey" to settings.openrouterKey,
            "google" to google,
            "autofillRequestUrl" to settings.autofillRequestUrl,
        )
        val presetId = snapshot.activePresetId
        val preset = presetId?.let { loadPresetOptional(it)?.toMutableMap() }
        if (preset != null) {
            applyEditablePresetSettings(preset, settings)
        } else {
            rootUpdates.putAll(editablePresetSettings(settings))
        }

        val rootUpserts = JSONArray().apply {
            rootUpdates.forEach { (key, value) ->
                put(JSONObject().put("key", key).put("value", toJsonValue(value)))
            }
        }
        val commit = JSONObject()
            .put("baseRevision", revision)
            .put("action", "android:generation-settings")
            .put("root", JSONObject().put("upserts", rootUpserts).put("deletes", JSONArray()))
            .put("characters", JSONArray())
            .put("chats", JSONArray())
            .put("chatManifests", JSONArray())
            .put("messages", JSONArray())
            .put("messageManifests", JSONArray())
        if (presetId != null && preset != null) {
            commit.put(
                "presets",
                JSONObject()
                    .put(
                        "upserts",
                        JSONArray().put(
                            JSONObject()
                                .put("id", presetId)
                                .put("data", toJsonValue(preset)),
                        ),
                    )
                    .put("deletes", JSONArray()),
            )
        }
        val response = JSONObject(request("POST", "/api/database-v2/commit", commit.toString()))
        revision = response.optLong("revision", revision + 1)
        revision
    }

    override suspend fun createChat(characterId: String, name: String): ChatSummary = withContext(Dispatchers.IO) {
        val position = loadCharacterChats(characterId).size
        val id = java.util.UUID.randomUUID().toString()
        val data = JSONObject()
            .put("name", name)
            .put("note", "")
            .put("localLore", JSONArray())
            .put("fmIndex", -1)
        val commit = JSONObject()
            .put("baseRevision", revision)
            .put("action", "android:chat-create")
            .put("root", JSONObject().put("upserts", JSONArray()).put("deletes", JSONArray()))
            .put("characters", JSONArray())
            .put("chats", JSONArray().put(JSONObject()
                .put("id", id)
                .put("characterId", characterId)
                .put("position", position)
                .put("data", data)))
            .put("chatManifests", JSONArray())
            .put("messages", JSONArray())
            .put("messageManifests", JSONArray())
        val response = JSONObject(request("POST", "/api/database-v2/commit", commit.toString()))
        revision = response.optLong("revision", revision + 1)
        ChatSummary(id = id, characterId = characterId, name = name)
    }

    override suspend fun loadChatPromptContext(chatId: String): ChatPromptContext = withContext(Dispatchers.IO) {
        val chat = JSONObject(
            request("GET", "/api/database-v2/chats/${encodePath(chatId)}?messageLimit=0"),
        ).getJSONObject("chat")
        val variables = (jsonValue(chat.opt("scriptstate")) as? Map<*, *>)
            ?.entries
            ?.associate { (key, value) -> key.toString().removePrefix("$") to value?.toString().orEmpty() }
            ?: emptyMap()
        ChatPromptContext(
            localLore = loreEntriesFromValue(jsonValue(chat.opt("localLore"))),
            greetingIndex = chat.optInt("fmIndex", -1),
            variables = variables,
        )
    }

    override suspend fun loadChatMessagePage(chatId: String, before: Int?, limit: Int): MessagePage = withContext(Dispatchers.IO) {
        val params = mutableListOf("limit=${limit.coerceIn(1, 500)}")
        if (before != null) params += "before=${before.coerceAtLeast(0)}"
        val body = request(
            "GET",
            "/api/database-v2/chats/${encodePath(chatId)}/messages?${params.joinToString("&")}",
        )
        val json = JSONObject(body)
        val messagesJson = json.optJSONArray("messages") ?: JSONArray()
        val messages = buildList {
            for (index in 0 until messagesJson.length()) {
                val item = messagesJson.optJSONObject(index) ?: continue
                add(item.toMessageRecord(chatId))
            }
        }
        val total = json.optInt("total", messages.size)
        val offset = json.optInt("offset", 0)
        MessagePage(
            messages = messages,
            offset = offset,
            total = total,
            hasMore = json.optBoolean("hasMore", offset > 0),
        )
    }

    override suspend fun loadAllChatMessages(chatId: String): List<MessageRecord> = withContext(Dispatchers.IO) {
        val body = request("GET", "/api/database-v2/chats/${encodePath(chatId)}/messages")
        val messagesJson = JSONObject(body).optJSONArray("messages") ?: JSONArray()
        buildList {
            for (index in 0 until messagesJson.length()) {
                val item = messagesJson.optJSONObject(index) ?: continue
                add(item.toMessageRecord(chatId))
            }
        }
    }

    override suspend fun commitPreparedTurn(
        characterId: String,
        chatId: String,
        chatPosition: Int,
        messages: List<PositionedMessage>,
        variables: Map<String, String>,
        messageManifest: List<String>?,
        characterPosition: Int,
        runtimePatch: RuntimeStatePatch,
    ): Long = withContext(Dispatchers.IO) {
        val chat = JSONObject(
            request("GET", "/api/database-v2/chats/${encodePath(chatId)}?messageLimit=0"),
        ).getJSONObject("chat")
        @Suppress("UNCHECKED_CAST")
        val chatData = ((jsonValue(chat) as? Map<String, Any?>) ?: emptyMap()).toMutableMap()
        listOf(
            "id", "message", "messageOffset", "messageTotal", "messagesFullyLoaded",
            "messagesLoaded", "detailsLoaded", "preventMessageCompaction",
        ).forEach(chatData::remove)
        chatData["scriptstate"] = variables.entries.associate { (key, value) -> "$$key" to value }
        runtimePatch.authorNote?.let { chatData["note"] = it }

        val characterUpserts = JSONArray()
        if (runtimePatch.hasCharacterChanges) {
            require(characterPosition >= 0) { "Character position is required for trigger character updates" }
            val characterJson = JSONObject(
                request("GET", "/api/database-v2/characters/${encodePath(characterId)}"),
            ).getJSONObject("character")
            @Suppress("UNCHECKED_CAST")
            val characterData = ((jsonValue(characterJson) as? Map<String, Any?>) ?: emptyMap()).toMutableMap()
            listOf("chats", "chaId", "detailsLoaded").forEach(characterData::remove)
            runtimePatch.characterDescription?.let { characterData["desc"] = it }
            runtimePatch.replaceGlobalNote?.let { characterData["replaceGlobalNote"] = it }
            characterUpserts.put(
                JSONObject().put("id", characterId).put("position", characterPosition).put("data", toJsonValue(characterData)),
            )
        }

        val messageUpserts = JSONArray().apply {
            messages.forEach { positioned ->
                val message = positioned.message
                val data = JSONObject()
                    .put("role", message.role)
                    .put("data", message.data)
                message.time?.let { data.put("time", it) }
                message.name?.let { data.put("name", it) }
                put(
                    JSONObject()
                        .put("id", message.id)
                        .put("chatId", chatId)
                        .put("position", positioned.position)
                        .put("data", data),
                )
            }
        }
        val commit = JSONObject()
            .put("baseRevision", revision)
            .put("action", "android:prepared-turn")
            .put("root", JSONObject().put("upserts", JSONArray()).put("deletes", JSONArray()))
            .put("characters", characterUpserts)
            .put(
                "chats",
                JSONArray().put(
                    JSONObject()
                        .put("id", chatId)
                        .put("characterId", characterId)
                        .put("position", chatPosition)
                        .put("data", toJsonValue(chatData)),
                ),
            )
            .put("chatManifests", JSONArray())
            .put("messages", messageUpserts)
            .put(
                "messageManifests",
                if (messageManifest == null) JSONArray() else JSONArray().put(
                    JSONObject().put("chatId", chatId).put("ids", JSONArray(messageManifest)),
                ),
            )
        val response = JSONObject(request("POST", "/api/database-v2/commit", commit.toString()))
        revision = response.optLong("revision", revision + 1)
        revision
    }

    override suspend fun appendMessage(
        chatId: String,
        position: Int,
        message: MessageRecord,
    ): Long = withContext(Dispatchers.IO) {
        val data = JSONObject()
            .put("role", message.role)
            .put("data", message.data)
        message.time?.let { data.put("time", it) }
        message.name?.let { data.put("name", it) }

        val commit = JSONObject()
            .put("baseRevision", revision)
            .put("action", "android:message")
            .put("root", JSONObject().put("upserts", JSONArray()).put("deletes", JSONArray()))
            .put("characters", JSONArray())
            .put("chats", JSONArray())
            .put("chatManifests", JSONArray())
            .put(
                "messages",
                JSONArray().put(
                    JSONObject()
                        .put("id", message.id)
                        .put("chatId", chatId)
                        .put("position", position)
                        .put("data", data),
                ),
            )
            .put("messageManifests", JSONArray())

        val response = JSONObject(request("POST", "/api/database-v2/commit", commit.toString()))
        revision = response.optLong("revision", revision + 1)
        revision
    }

    private fun loadSettingValueOptional(key: String): Any? {
        val body = requestOptional("GET", "/api/database-v2/settings/${encodePath(key)}") ?: return null
        return jsonValue(JSONObject(body).opt("value"))
    }

    @Suppress("UNCHECKED_CAST")
    private fun loadPresetOptional(presetId: String): Map<String, Any?>? {
        val body = requestOptional("GET", "/api/database-v2/presets/${encodePath(presetId)}") ?: return null
        return jsonValue(JSONObject(body).opt("preset")) as? Map<String, Any?>
    }

    private fun editablePresetSettings(
        settings: io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings,
    ): LinkedHashMap<String, Any?> = linkedMapOf(
        "aiModel" to settings.aiModel,
        "maxContext" to settings.maxContext,
        "maxResponse" to settings.maxResponse,
        "temperature" to settings.temperature * 100.0,
        "top_p" to settings.topP,
        "proxyKey" to settings.proxyKey,
        "forceReplaceUrl" to settings.forceReplaceUrl,
        "proxyRequestModel" to settings.proxyRequestModel,
        "customProxyRequestModel" to settings.customProxyRequestModel,
        "openrouterRequestModel" to settings.openrouterRequestModel,
    )

    private fun applyEditablePresetSettings(
        data: MutableMap<String, Any?>,
        settings: io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings,
    ) {
        editablePresetSettings(settings).forEach { (key, value) ->
            if (key == "top_p" && value == null) data.remove(key) else data[key] = value
        }
    }

    private fun requestOptional(method: String, path: String): String? {
        val connection = URI(baseUrl + path).toURL().openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 15_000
        connection.readTimeout = 60_000
        connection.setRequestProperty("Accept", "application/json")
        if (authToken.isNotBlank()) connection.setRequestProperty("risu-auth", authToken)
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
        connection.disconnect()
        if (status == 404) return null
        if (status !in 200..299) {
            val message = runCatching { JSONObject(text).optString("error") }.getOrNull().orEmpty()
            throw IllegalStateException("Risu server HTTP $status${if (message.isBlank()) "" else ": $message"}")
        }
        return text
    }

    private fun request(method: String, path: String, body: String? = null): String {
        val connection = URI(baseUrl + path).toURL().openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 15_000
        connection.readTimeout = 60_000
        connection.setRequestProperty("Accept", "application/json")
        if (authToken.isNotBlank()) connection.setRequestProperty("risu-auth", authToken)
        if (body != null) {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
        }
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
        connection.disconnect()
        if (status !in 200..299) {
            val message = runCatching { JSONObject(text).optString("error") }.getOrNull().orEmpty()
            throw IllegalStateException("Risu server HTTP $status${if (message.isBlank()) "" else ": $message"}")
        }
        return text
    }

    private fun toJsonValue(value: Any?): Any = when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject().apply {
            value.forEach { (key, child) -> if (key != null) put(key.toString(), toJsonValue(child)) }
        }
        is Iterable<*> -> JSONArray().apply { value.forEach { put(toJsonValue(it)) } }
        is Array<*> -> JSONArray().apply { value.forEach { put(toJsonValue(it)) } }
        else -> value
    }

    private fun jsonValue(value: Any?): Any? = when (value) {
        null, JSONObject.NULL -> null
        is JSONObject -> buildMap {
            val keys = value.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                put(key, jsonValue(value.opt(key)))
            }
        }
        is JSONArray -> buildList {
            for (index in 0 until value.length()) add(jsonValue(value.opt(index)))
        }
        else -> value
    }

    private fun JSONObject.toMessageRecord(fallbackChatId: String): MessageRecord = MessageRecord(
        id = optString("chatId").ifBlank { optString("id") },
        chatId = fallbackChatId,
        role = optString("role", "char"),
        data = optString("data"),
        name = optString("name").takeIf(String::isNotBlank),
        time = optLongOrNull("time"),
    )

    private fun jsonStringList(array: JSONArray?): List<String> = buildList {
        if (array == null) return@buildList
        for (index in 0 until array.length()) add(array.optString(index))
    }

    private fun JSONObject.optLongOrNull(key: String): Long? =
        if (!has(key) || isNull(key)) null else optLong(key)

    private fun encodePath(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.toString()).replace("+", "%20")

    private fun normalizeBaseUrl(value: String): String {
        val trimmed = value.trim().trimEnd('/')
        require(trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            "Server URL must start with http:// or https://"
        }
        return trimmed
    }
}
