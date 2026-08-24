package io.github.nevaeh5379.androidhaejeokrisuai.generation

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets

internal data class AnthropicMessage(val role: String, val text: String)
internal data class AnthropicRequestPayload(
    val model: String,
    val system: String?,
    val messages: List<AnthropicMessage>,
    val maxTokens: Int,
    val temperature: Double?,
)

class AnthropicGenerator {
    suspend fun generate(
        settings: GenerationSettings,
        character: CharacterProfile,
        history: List<MessageRecord>,
        authorNote: String = "",
        greetingIndex: Int = -1,
        variables: Map<String, String> = emptyMap(),
        triggerPrompt: NativeTriggerPromptInjection = NativeTriggerPromptInjection(),
        preparedPrompt: List<NativePromptMessage>? = null,
    ): String = withContext(Dispatchers.IO) {
        require(settings.claudeAPIKey.isNotBlank()) { "Anthropic API key (claudeAPIKey) is empty" }
        require(settings.aiModel.startsWith("claude", ignoreCase = true)) {
            "Unsupported Anthropic model '${settings.aiModel}'"
        }
        val prompt = preparedPrompt ?: NativePromptBuilder.build(settings, character, history, authorNote, greetingIndex, variables, triggerPrompt)
        val payload = buildRequestPayload(prompt, settings)
        val body = buildRequestBody(payload)
        val connection = URI("https://api.anthropic.com/v1/messages").toURL().openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 20_000
            connection.readTimeout = 180_000
            connection.doOutput = true
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setRequestProperty("x-api-key", settings.claudeAPIKey)
            connection.setRequestProperty("anthropic-version", "2023-06-01")
            connection.outputStream.use { it.write(body.toString().toByteArray(StandardCharsets.UTF_8)) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val responseText = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                val detail = runCatching {
                    JSONObject(responseText).optJSONObject("error")?.optString("message")
                }.getOrNull().orEmpty()
                throw IllegalStateException("Anthropic API HTTP $status${if (detail.isBlank()) "" else ": $detail"}")
            }
            extractText(JSONObject(responseText)).trim().also {
                if (it.isBlank()) throw IllegalStateException("Anthropic returned a blank response")
            }
        } finally {
            connection.disconnect()
        }
    }

    internal fun buildRequestPayload(
        prompt: List<NativePromptMessage>,
        settings: GenerationSettings,
    ): AnthropicRequestPayload {
        var systemPrompt = ""
        val messages = mutableListOf<AnthropicMessage>()
        fun append(role: String, text: String) {
            if (text.isBlank()) return
            val previous = messages.lastOrNull()
            if (previous?.role == role) {
                messages[messages.lastIndex] = previous.copy(text = previous.text + "\n\n" + text)
            } else {
                messages += AnthropicMessage(role, text)
            }
        }
        for (message in prompt) {
            when (message.role) {
                "user" -> append("user", message.content)
                "assistant" -> append("assistant", message.content)
                "system" -> {
                    if (messages.isEmpty()) {
                        systemPrompt = listOf(systemPrompt, message.content)
                            .filter { it.isNotBlank() }
                            .joinToString("\n\n")
                    } else {
                        append("user", "System: ${message.content}")
                    }
                }
            }
        }
        if (messages.isEmpty()) append("user", "Start")
        if (messages.first().role != "user") messages.add(0, AnthropicMessage("user", "Start"))
        return AnthropicRequestPayload(
            model = settings.aiModel,
            system = systemPrompt.trim().takeIf { it.isNotBlank() },
            messages = messages,
            maxTokens = settings.maxResponse,
            temperature = settings.temperature.takeIf { settings.temperatureEnabled },
        )
    }

    private fun buildRequestBody(payload: AnthropicRequestPayload): JSONObject = JSONObject()
        .put("model", payload.model)
        .put(
            "messages",
            JSONArray().apply {
                payload.messages.forEach { message ->
                    put(
                        JSONObject()
                            .put("role", message.role)
                            .put("content", JSONArray().put(JSONObject().put("type", "text").put("text", message.text))),
                    )
                }
            },
        )
        .put("max_tokens", payload.maxTokens)
        .apply {
            payload.temperature?.let { put("temperature", it) }
            payload.system?.let { put("system", it) }
        }

    private fun extractText(response: JSONObject): String {
        val content = response.optJSONArray("content") ?: JSONArray()
        var thinkingOpen = false
        return buildString {
            for (index in 0 until content.length()) {
                val block = content.optJSONObject(index) ?: continue
                when (block.optString("type")) {
                    "text" -> {
                        if (thinkingOpen) {
                            append("</Thoughts>\n\n")
                            thinkingOpen = false
                        }
                        append(block.optString("text"))
                    }
                    "thinking" -> {
                        if (!thinkingOpen) {
                            append("<Thoughts>\n")
                            thinkingOpen = true
                        }
                        append(block.optString("thinking"))
                    }
                    "redacted_thinking" -> {
                        if (!thinkingOpen) {
                            append("<Thoughts>\n")
                            thinkingOpen = true
                        }
                        append("\n{{redacted_thinking}}\n")
                    }
                }
            }
            if (thinkingOpen) append("</Thoughts>\n\n")
        }
    }
}
