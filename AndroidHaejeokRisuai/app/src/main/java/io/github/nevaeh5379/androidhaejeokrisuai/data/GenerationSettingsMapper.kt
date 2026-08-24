package io.github.nevaeh5379.androidhaejeokrisuai.data

object GenerationSettingsMapper {
    val keys = listOf(
        "aiModel", "username", "loreBookDepth", "loreBookToken", "mainPrompt", "jailbreak", "jailbreakToggle",
        "globalNote", "descriptionPrefix", "additionalPrompt", "personaPrompt", "templateDefaultVariables", "globalChatVariables", "promptPreprocess",
        "maxResponse", "temperature", "top_p", "openAIKey", "claudeAPIKey", "proxyKey",
        "openrouterKey", "google", "forceReplaceUrl", "proxyRequestModel",
        "customProxyRequestModel", "openrouterRequestModel", "autofillRequestUrl",
        "formatingOrder",
    )

    fun fromMap(values: Map<String, Any?>): GenerationSettings {
        fun text(key: String, fallback: String = "") = values[key]?.toString() ?: fallback
        fun bool(key: String, fallback: Boolean = false): Boolean = when (val value = values[key]) {
            is Boolean -> value
            is Number -> value.toInt() != 0
            is String -> value.equals("true", true) || value == "1"
            else -> fallback
        }
        fun number(key: String): Double? = (values[key] as? Number)?.toDouble()
            ?: values[key]?.toString()?.toDoubleOrNull()
        val order = (values["formatingOrder"] as? List<*>)
            ?.mapNotNull { it?.toString() }
            ?.takeIf { it.isNotEmpty() }
            ?: GenerationSettings.DEFAULT_FORMATTING_ORDER
        return GenerationSettings(
            aiModel = text("aiModel"),
            username = text("username", "User"),
            loreBookDepth = number("loreBookDepth")?.toInt()?.coerceAtLeast(0) ?: 5,
            loreBookToken = number("loreBookToken")?.toInt()?.coerceAtLeast(0) ?: 800,
            mainPrompt = text("mainPrompt"),
            jailbreak = text("jailbreak"),
            jailbreakToggle = bool("jailbreakToggle"),
            globalNote = text("globalNote"),
            descriptionPrefix = text("descriptionPrefix"),
            additionalPrompt = text("additionalPrompt"),
            personaPrompt = text("personaPrompt"),
            templateDefaultVariables = text("templateDefaultVariables"),
            globalChatVariables = (values["globalChatVariables"] as? Map<*, *>)
                ?.entries
                ?.associate { (key, value) -> key.toString() to value?.toString().orEmpty() }
                ?: emptyMap(),
            promptPreprocess = bool("promptPreprocess"),
            maxResponse = number("maxResponse")?.toInt()?.coerceAtLeast(1) ?: 300,
            temperature = ((number("temperature") ?: 80.0) / 100.0).coerceIn(0.0, 2.0),
            topP = number("top_p")?.coerceIn(0.0, 1.0),
            openAIKey = text("openAIKey"),
            claudeAPIKey = text("claudeAPIKey"),
            proxyKey = text("proxyKey"),
            openrouterKey = text("openrouterKey"),
            googleApiKey = ((values["google"] as? Map<*, *>)?.get("accessToken")?.toString()).orEmpty(),
            forceReplaceUrl = text("forceReplaceUrl"),
            proxyRequestModel = text("proxyRequestModel"),
            customProxyRequestModel = text("customProxyRequestModel"),
            openrouterRequestModel = text("openrouterRequestModel"),
            autofillRequestUrl = bool("autofillRequestUrl", true),
            formatingOrder = order,
        )
    }
    fun applyPreset(base: GenerationSettings, preset: Map<String, Any?>): GenerationSettings {
        fun text(key: String): String? = preset[key]?.toString()
        fun bool(key: String): Boolean? = when (val value = preset[key]) {
            is Boolean -> value
            is Number -> value.toInt() != 0
            is String -> when {
                value.equals("true", true) || value == "1" -> true
                value.equals("false", true) || value == "0" -> false
                else -> null
            }
            else -> null
        }
        fun number(key: String): Double? = (preset[key] as? Number)?.toDouble()
            ?: preset[key]?.toString()?.toDoubleOrNull()
        val order = (preset["formatingOrder"] as? List<*>)
            ?.mapNotNull { it?.toString() }
            ?.takeIf { it.isNotEmpty() }
        val requestModel = text("proxyRequestModel") ?: base.proxyRequestModel
        return base.copy(
            aiModel = text("aiModel") ?: base.aiModel,
            mainPrompt = text("mainPrompt") ?: base.mainPrompt,
            jailbreak = text("jailbreak") ?: base.jailbreak,
            globalNote = text("globalNote") ?: base.globalNote,
            promptPreprocess = bool("promptPreprocess") ?: base.promptPreprocess,
            maxResponse = number("maxResponse")?.toInt()?.coerceAtLeast(1) ?: base.maxResponse,
            temperature = number("temperature")?.div(100.0)?.coerceIn(0.0, 2.0) ?: base.temperature,
            topP = number("top_p")?.coerceIn(0.0, 1.0) ?: base.topP,
            proxyKey = text("proxyKey") ?: base.proxyKey,
            forceReplaceUrl = text("forceReplaceUrl") ?: base.forceReplaceUrl,
            proxyRequestModel = requestModel,
            customProxyRequestModel = text("customProxyRequestModel") ?: base.customProxyRequestModel,
            openrouterRequestModel = text("openrouterRequestModel") ?: base.openrouterRequestModel,
            formatingOrder = order ?: base.formatingOrder,
        )
    }

}
