package io.github.nevaeh5379.androidhaejeokrisuai.data

enum class StorageMode { LOCAL_SQLITE, REMOTE_SERVER }

data class StorageConfig(
    val mode: StorageMode,
    val baseUrl: String = "",
    val authToken: String = "",
)

data class CharacterSummary(
    val id: String,
    val name: String,
    val image: String = "",
    val kind: String = "character",
    val lastInteraction: Long? = null,
)

data class LoreEntry(
    val key: String = "",
    val secondKey: String = "",
    val insertOrder: Int = 0,
    val comment: String = "",
    val content: String = "",
    val alwaysActive: Boolean = false,
    val selective: Boolean = false,
    val useRegex: Boolean = false,
    val activationPercent: Double? = null,
)

@Suppress("UNCHECKED_CAST")
fun loreEntriesFromValue(value: Any?): List<LoreEntry> = (value as? List<*>)?.mapNotNull { raw ->
    val map = raw as? Map<String, Any?> ?: return@mapNotNull null
    LoreEntry(
        key = map["key"]?.toString().orEmpty(),
        secondKey = map["secondkey"]?.toString().orEmpty(),
        insertOrder = (map["insertorder"] as? Number)?.toInt() ?: 0,
        comment = map["comment"]?.toString().orEmpty(),
        content = map["content"]?.toString().orEmpty(),
        alwaysActive = map["alwaysActive"] as? Boolean ?: false,
        selective = map["selective"] as? Boolean ?: false,
        useRegex = map["useRegex"] as? Boolean ?: false,
        activationPercent = (map["activationPercent"] as? Number)?.toDouble(),
    )
} ?: emptyList()

data class CharacterProfile(
    val id: String,
    val name: String,
    val firstMessage: String = "",
    val alternateGreetings: List<String> = emptyList(),
    val exampleMessage: String = "",
    val defaultVariables: String = "",
    val description: String = "",
    val personality: String = "",
    val scenario: String = "",
    val systemPrompt: String = "",
    val replaceGlobalNote: String = "",
    val globalLore: List<LoreEntry> = emptyList(),
)

data class ChatPromptContext(
    val localLore: List<LoreEntry> = emptyList(),
    val greetingIndex: Int = -1,
    val variables: Map<String, String> = emptyMap(),
)

data class CharacterImportPayload(
    val name: String,
    val data: Map<String, Any?>,
    val imageBytes: ByteArray? = null,
)

data class ChatSummary(
    val id: String,
    val characterId: String,
    val name: String,
    val note: String = "",
    val lastMessageTime: Long? = null,
)

data class MessageRecord(
    val id: String,
    val chatId: String,
    val role: String,
    val data: String,
    val name: String? = null,
    val time: Long? = null,
)

data class GenerationSettings(
    val aiModel: String = "",
    val username: String = "User",
    val loreBookDepth: Int = 5,
    val loreBookToken: Int = 800,
    val mainPrompt: String = "",
    val jailbreak: String = "",
    val jailbreakToggle: Boolean = false,
    val globalNote: String = "",
    val descriptionPrefix: String = "",
    val additionalPrompt: String = "",
    val personaPrompt: String = "",
    val templateDefaultVariables: String = "",
    val globalChatVariables: Map<String, String> = emptyMap(),
    val promptPreprocess: Boolean = false,
    val maxResponse: Int = 300,
    val temperature: Double = 0.8,
    val topP: Double? = null,
    val openAIKey: String = "",
    val claudeAPIKey: String = "",
    val proxyKey: String = "",
    val openrouterKey: String = "",
    val googleApiKey: String = "",
    val forceReplaceUrl: String = "",
    val proxyRequestModel: String = "",
    val customProxyRequestModel: String = "",
    val openrouterRequestModel: String = "",
    val autofillRequestUrl: Boolean = true,
    val formatingOrder: List<String> = DEFAULT_FORMATTING_ORDER,
) {
    companion object {
        val DEFAULT_FORMATTING_ORDER = listOf(
            "main", "description", "personaPrompt", "chats", "lastChat",
            "jailbreak", "lorebook", "globalNote", "authorNote",
        )
    }
}

data class DatabaseOverview(
    val status: String,
    val revision: Long,
    val characters: List<CharacterSummary>,
    val generationSettings: GenerationSettings = GenerationSettings(),
    val activePresetId: String? = null,
    val activePresetName: String? = null,
)

data class MessagePage(
    val messages: List<MessageRecord>,
    val offset: Int,
    val total: Int,
    val hasMore: Boolean,
)
