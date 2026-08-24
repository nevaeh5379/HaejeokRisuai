package io.github.nevaeh5379.androidhaejeokrisuai.data.storage.remote

import io.github.nevaeh5379.androidhaejeokrisuai.data.ChatSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.DatabaseOverview
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessagePage
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
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
        DatabaseOverview(
            status = json.optString("status", "empty"),
            revision = revision,
            characters = characters,
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

    private fun JSONObject.toMessageRecord(fallbackChatId: String): MessageRecord = MessageRecord(
        id = optString("chatId").ifBlank { optString("id") },
        chatId = fallbackChatId,
        role = optString("role", "char"),
        data = optString("data"),
        name = optString("name").takeIf(String::isNotBlank),
        time = optLongOrNull("time"),
    )

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
