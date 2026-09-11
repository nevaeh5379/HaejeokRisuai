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

internal data class OpenAiRequestMessage(val role: String, val content: String)
internal data class OpenAiRequestPayload(
    val model: String,
    val messages: List<OpenAiRequestMessage>,
    val maxTokens: Int,
    val temperature: Double?,
    val topP: Double?,
)

class OpenAiCompatibleGenerator {
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
        val target = resolveTarget(settings)
        val messages = preparedPrompt ?: NativePromptBuilder.build(settings, character, history, authorNote, greetingIndex, variables, triggerPrompt)
        require(messages.isNotEmpty()) { "The generated prompt is empty" }

        val body = buildRequestBody(buildRequestPayload(messages, target, settings))

        val connection = URI(target.url).toURL().openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 20_000
            connection.readTimeout = 180_000
            connection.doOutput = true
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            if (target.key.isNotBlank()) connection.setRequestProperty("Authorization", "Bearer ${target.key}")
            if (settings.aiModel == "openrouter") {
                connection.setRequestProperty("X-Title", "RisuAI")
                connection.setRequestProperty("HTTP-Referer", "https://risuai.xyz")
            }
            connection.outputStream.use { it.write(body.toString().toByteArray(StandardCharsets.UTF_8)) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val responseText = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                val detail = runCatching {
                    JSONObject(responseText).optJSONObject("error")?.optString("message")
                }.getOrNull().orEmpty()
                throw IllegalStateException("Model API HTTP $status${if (detail.isBlank()) "" else ": $detail"}")
            }
            val response = JSONObject(responseText)
            val message = response.optJSONArray("choices")
                ?.optJSONObject(0)
                ?.optJSONObject("message")
                ?: throw IllegalStateException("Model API response has no choices[0].message")
            extractContent(message).trim().also {
                if (it.isBlank()) throw IllegalStateException("Model API returned a blank response")
            }
        } finally {
            connection.disconnect()
        }
    }

    internal fun buildRequestPayload(
        messages: List<NativePromptMessage>,
        target: Target,
        settings: GenerationSettings,
    ) = OpenAiRequestPayload(
        model = target.model,
        messages = messages.map { OpenAiRequestMessage(it.role, it.content) },
        maxTokens = settings.maxResponse,
        temperature = settings.temperature.takeIf { settings.temperatureEnabled },
        topP = settings.topP,
    )

    private fun buildRequestBody(payload: OpenAiRequestPayload): JSONObject = JSONObject()
        .put("model", payload.model)
        .put("messages", JSONArray().apply {
            payload.messages.forEach { put(JSONObject().put("role", it.role).put("content", it.content)) }
        })
        .put("max_tokens", payload.maxTokens)
        .apply {
            payload.temperature?.let { put("temperature", it) }
            payload.topP?.let { put("top_p", it) }
        }

    internal fun resolveTarget(settings: GenerationSettings): Target {
        val model = settings.aiModel
        return when {
            model == "reverse_proxy" -> {
                val requestModel = if (settings.proxyRequestModel == "custom") {
                    settings.customProxyRequestModel
                } else settings.proxyRequestModel
                require(settings.forceReplaceUrl.isNotBlank()) { "Risu reverse proxy URL is empty" }
                require(requestModel.isNotBlank()) { "Risu reverse proxy model is empty" }
                Target(
                    url = if (settings.autofillRequestUrl) autofillChatCompletions(settings.forceReplaceUrl) else settings.forceReplaceUrl,
                    key = settings.proxyKey,
                    model = requestModel,
                )
            }
            model == "openrouter" -> {
                require(settings.openrouterRequestModel.isNotBlank()) { "OpenRouter model is empty" }
                Target(
                    url = "https://openrouter.ai/api/v1/chat/completions",
                    key = settings.openrouterKey,
                    model = settings.openrouterRequestModel,
                )
            }
            model.startsWith("gpt", ignoreCase = true) ||
                model.startsWith("o1", ignoreCase = true) ||
                model.startsWith("o3", ignoreCase = true) ||
                model.startsWith("o4", ignoreCase = true) -> Target(
                url = "https://api.openai.com/v1/chat/completions",
                key = settings.openAIKey,
                model = mapLegacyOpenAiModel(model),
            )
            else -> throw UnsupportedOperationException(
                "Native generation does not support Risu model '$model' yet. " +
                    "Use an OpenAI-compatible reverse proxy, OpenRouter, or GPT model for this porting stage.",
            )
        }
    }

    private fun extractContent(message: JSONObject): String {
        val content = message.opt("content")
        if (content is String) return content
        if (content is JSONArray) {
            return buildString {
                for (index in 0 until content.length()) {
                    val part = content.optJSONObject(index) ?: continue
                    if (part.optString("type") == "text") append(part.optString("text"))
                }
            }
        }
        return content?.toString().orEmpty()
    }

    private fun autofillChatCompletions(value: String): String {
        var url = value.trim().trimEnd('/')
        url = when {
            url.endsWith("/chat/completions") -> url
            url.endsWith("/v1") -> "$url/chat/completions"
            else -> "$url/v1/chat/completions"
        }
        return url
    }

    private fun mapLegacyOpenAiModel(model: String): String = when (model) {
        "gpt35" -> "gpt-3.5-turbo"
        "gpt35_0613" -> "gpt-3.5-turbo-0613"
        "gpt35_16k" -> "gpt-3.5-turbo-16k"
        "gpt4" -> "gpt-4"
        "gpt4_32k" -> "gpt-4-32k"
        "gpt4o" -> "gpt-4o"
        "gpt4om" -> "gpt-4o-mini"
        else -> model
    }

    data class Target(val url: String, val key: String, val model: String)
}
