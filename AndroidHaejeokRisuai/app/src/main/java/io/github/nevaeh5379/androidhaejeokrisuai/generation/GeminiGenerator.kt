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
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

internal data class GeminiContent(val role: String, val text: String)
internal data class GeminiRequestPayload(
    val systemInstruction: String?,
    val contents: List<GeminiContent>,
    val maxOutputTokens: Int,
    val temperature: Double,
    val topP: Double?,
)

class GeminiGenerator {
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
        require(settings.googleApiKey.isNotBlank()) { "Gemini API key (google.accessToken) is empty" }
        require(settings.aiModel.isNotBlank()) { "Gemini model is empty" }
        val prompt = preparedPrompt ?: NativePromptBuilder.build(settings, character, history, authorNote, greetingIndex, variables, triggerPrompt)
        require(prompt.isNotEmpty()) { "The generated prompt is empty" }

        val body = buildRequestBody(buildRequestPayload(prompt, settings))
        val model = URLEncoder.encode(settings.aiModel, StandardCharsets.UTF_8.toString()).replace("+", "%20")
        val key = URLEncoder.encode(settings.googleApiKey, StandardCharsets.UTF_8.toString()).replace("+", "%20")
        val url = "https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent?key=$key"
        val connection = URI(url).toURL().openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 20_000
            connection.readTimeout = 180_000
            connection.doOutput = true
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.outputStream.use { it.write(body.toString().toByteArray(StandardCharsets.UTF_8)) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val responseText = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                val detail = runCatching {
                    JSONObject(responseText).optJSONObject("error")?.optString("message")
                }.getOrNull().orEmpty()
                throw IllegalStateException("Gemini API HTTP $status${if (detail.isBlank()) "" else ": $detail"}")
            }
            extractText(JSONObject(responseText)).trim().also {
                if (it.isBlank()) throw IllegalStateException("Gemini returned a blank response")
            }
        } finally {
            connection.disconnect()
        }
    }

    internal fun buildRequestPayload(
        prompt: List<NativePromptMessage>,
        settings: GenerationSettings,
    ): GeminiRequestPayload {
        val remaining = prompt.toMutableList()
        val systemText = if (remaining.firstOrNull()?.role == "system") remaining.removeAt(0).content else null
        val contents = mutableListOf<GeminiContent>()
        for (message in remaining) {
            val role = when (message.role) {
                "user" -> "user"
                "assistant" -> "model"
                else -> "user"
            }
            val text = if (message.role == "system") "system:${message.content}" else message.content
            val previous = contents.lastOrNull()
            if (previous?.role == role) {
                contents[contents.lastIndex] = previous.copy(text = previous.text + "\n\n" + text)
            } else {
                contents += GeminiContent(role, text)
            }
        }
        return GeminiRequestPayload(
            systemInstruction = systemText?.takeIf { it.isNotBlank() },
            contents = contents,
            maxOutputTokens = settings.maxResponse,
            temperature = settings.temperature,
            topP = settings.topP,
        )
    }

    private fun buildRequestBody(payload: GeminiRequestPayload): JSONObject {
        val body = JSONObject().put(
            "contents",
            JSONArray().apply {
                payload.contents.forEach { content ->
                    put(
                        JSONObject()
                            .put("role", content.role)
                            .put("parts", JSONArray().put(JSONObject().put("text", content.text))),
                    )
                }
            },
        ).put(
            "generationConfig",
            JSONObject()
                .put("maxOutputTokens", payload.maxOutputTokens)
                .put("temperature", payload.temperature)
                .apply { payload.topP?.let { put("topP", it) } },
        )
        payload.systemInstruction?.let { systemText ->
            body.put(
                "systemInstruction",
                JSONObject().put("parts", JSONArray().put(JSONObject().put("text", systemText))),
            )
        }
        return body
    }

    private fun extractText(response: JSONObject): String {
        val parts = response.optJSONArray("candidates")
            ?.optJSONObject(0)
            ?.optJSONObject("content")
            ?.optJSONArray("parts")
            ?: JSONArray()
        return buildString {
            for (index in 0 until parts.length()) {
                val part = parts.optJSONObject(index) ?: continue
                if (part.has("text")) append(part.optString("text"))
            }
        }
    }
}
