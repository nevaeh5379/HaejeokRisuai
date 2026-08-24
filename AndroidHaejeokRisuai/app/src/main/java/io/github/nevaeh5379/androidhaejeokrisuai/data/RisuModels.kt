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
fun loreEntryMapsFromValue(value: Any?): List<Map<String, Any?>> =
    (value as? List<*>)?.mapNotNull { raw ->
        (raw as? Map<*, *>)?.entries?.associateTo(linkedMapOf()) { (key, child) -> key.toString() to child }
    } ?: emptyList()

fun loreEntriesFromValue(value: Any?): List<LoreEntry> = loreEntryMapsFromValue(value).map { map ->
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
}

fun loreEntryToValue(entry: LoreEntry): Map<String, Any?> = linkedMapOf(
    "key" to entry.key, "secondkey" to entry.secondKey, "insertorder" to entry.insertOrder,
    "comment" to entry.comment, "content" to entry.content, "alwaysActive" to entry.alwaysActive,
    "selective" to entry.selective, "useRegex" to entry.useRegex,
).apply { entry.activationPercent?.let { put("activationPercent", it) } }

data class PersonaProfile(
    val personaPrompt: String = "",
    val name: String = "",
    val icon: String = "",
    val largePortrait: Boolean = false,
    val id: String? = null,
    val note: String? = null,
    val raw: Map<String, Any?> = emptyMap(),
)

@Suppress("UNCHECKED_CAST")
fun personaProfilesFromValue(value: Any?): List<PersonaProfile> =
    (value as? List<*>)?.mapNotNull { item ->
        val source = item as? Map<*, *> ?: return@mapNotNull null
        val raw = source.entries.associateTo(linkedMapOf()) { (key, child) -> key.toString() to child }
        PersonaProfile(
            personaPrompt = raw["personaPrompt"]?.toString().orEmpty(),
            name = raw["name"]?.toString().orEmpty(),
            icon = raw["icon"]?.toString().orEmpty(),
            largePortrait = raw["largePortrait"] as? Boolean ?: false,
            id = raw["id"]?.toString(),
            note = raw["note"]?.toString(),
            raw = raw,
        )
    } ?: emptyList()

fun personaProfileToValue(persona: PersonaProfile): Map<String, Any?> =
    LinkedHashMap(persona.raw).apply {
        put("personaPrompt", persona.personaPrompt)
        put("name", persona.name)
        put("icon", persona.icon)
        put("largePortrait", persona.largePortrait)
        if (persona.id == null) remove("id") else put("id", persona.id)
        if (persona.note == null) remove("note") else put("note", persona.note)
    }

data class RegexScript(
    val comment: String = "",
    val input: String = "",
    val output: String = "",
    val type: String = "",
    val flag: String = "",
    val ableFlag: Boolean = false,
)

fun regexScriptsFromValue(value: Any?): List<RegexScript> = (value as? List<*>)?.mapNotNull { raw ->
    val map = raw as? Map<*, *> ?: return@mapNotNull null
    RegexScript(
        comment = map["comment"]?.toString().orEmpty(),
        input = map["in"]?.toString().orEmpty(),
        output = map["out"]?.toString().orEmpty(),
        type = map["type"]?.toString().orEmpty(),
        flag = map["flag"]?.toString().orEmpty(),
        ableFlag = map["ableFlag"] as? Boolean ?: false,
    )
} ?: emptyList()

data class TriggerScript(
    val comment: String = "",
    val type: String = "",
    val conditions: List<Map<String, Any?>> = emptyList(),
    val effects: List<Map<String, Any?>> = emptyList(),
    val lowLevelAccess: Boolean = false,
)

@Suppress("UNCHECKED_CAST")
fun triggerScriptsFromValue(value: Any?): List<TriggerScript> = (value as? List<*>)?.mapNotNull { raw ->
    val map = raw as? Map<*, *> ?: return@mapNotNull null
    TriggerScript(
        comment = map["comment"]?.toString().orEmpty(),
        type = map["type"]?.toString().orEmpty(),
        conditions = (map["conditions"] as? List<*>)?.mapNotNull { it as? Map<String, Any?> }.orEmpty(),
        effects = (map["effect"] as? List<*>)?.mapNotNull { it as? Map<String, Any?> }.orEmpty(),
        lowLevelAccess = map["lowLevelAccess"] as? Boolean ?: false,
    )
} ?: emptyList()

data class CharacterProfile(
    val id: String,
    val name: String,
    val firstMessage: String = "",
    val alternateGreetings: List<String> = emptyList(),
    val exampleMessage: String = "",
    val defaultVariables: String = "",
    val regexScripts: List<RegexScript> = emptyList(),
    val triggerScripts: List<TriggerScript> = emptyList(),
    val description: String = "",
    val personality: String = "",
    val scenario: String = "",
    val systemPrompt: String = "",
    val replaceGlobalNote: String = "",
    val backgroundHtml: String = "",
    val globalLore: List<LoreEntry> = emptyList(),
    val globalLoreRaw: List<Map<String, Any?>> = emptyList(),
)

data class ChatPromptContext(
    val localLore: List<LoreEntry> = emptyList(),
    val localLoreRaw: List<Map<String, Any?>> = emptyList(),
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

data class PositionedMessage(
    val position: Int,
    val message: MessageRecord,
)

data class RuntimeStatePatch(
    val authorNote: String? = null,
    val characterName: String? = null,
    val characterFirstMessage: String? = null,
    val characterDescription: String? = null,
    val characterBackgroundHtml: String? = null,
    val replaceGlobalNote: String? = null,
    val globalLoreRaw: List<Map<String, Any?>>? = null,
    val localLoreRaw: List<Map<String, Any?>>? = null,
    val personaPrompt: String? = null,
    val personas: List<PersonaProfile>? = null,
) {
    val hasCharacterChanges: Boolean
        get() = characterName != null || characterFirstMessage != null || characterDescription != null ||
            characterBackgroundHtml != null || replaceGlobalNote != null || globalLoreRaw != null
    val hasSettingChanges: Boolean
        get() = personaPrompt != null || personas != null

    fun applyTo(character: CharacterProfile): CharacterProfile {
        val patchedLore = globalLoreRaw
        return character.copy(
            name = characterName ?: character.name,
            firstMessage = characterFirstMessage ?: character.firstMessage,
            description = characterDescription ?: character.description,
            backgroundHtml = characterBackgroundHtml ?: character.backgroundHtml,
            replaceGlobalNote = replaceGlobalNote ?: character.replaceGlobalNote,
            globalLore = patchedLore?.let(::loreEntriesFromValue) ?: character.globalLore,
            globalLoreRaw = patchedLore ?: character.globalLoreRaw,
        )
    }

    fun resolveAuthorNote(fallback: String): String = authorNote ?: fallback

    fun applyTo(settings: GenerationSettings): GenerationSettings = settings.copy(
        personaPrompt = personaPrompt ?: settings.personaPrompt,
        personas = personas ?: settings.personas,
    )
}

data class PromptTemplateItem(
    val type: String,
    val type2: String = "",
    val text: String = "",
    val role: String = "system",
    val role2: String? = null,
    val innerFormat: String = "",
    val defaultText: String = "",
    val rangeStart: Int = 0,
    val rangeEnd: Int? = null,
    val chatAsOriginalOnSystem: Boolean = false,
)

data class NativePromptSettings(
    val assistantPrefill: String = "",
    val postEndInnerFormat: String = "",
    val sendChatAsSystem: Boolean = false,
    val sendName: Boolean = false,
    val utilOverride: Boolean = false,
    val trimStartNewChat: Boolean = false,
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
    val selectedPersona: Int = 0,
    val personas: List<PersonaProfile> = emptyList(),
    val templateDefaultVariables: String = "",
    val globalChatVariables: Map<String, String> = emptyMap(),
    val presetRegex: List<RegexScript> = emptyList(),
    val promptPreprocess: Boolean = false,
    val promptTemplate: List<PromptTemplateItem>? = null,
    val promptSettings: NativePromptSettings = NativePromptSettings(),
    val maxContext: Int = 4000,
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

fun GenerationSettings.effectivePersonaPrompt(): String = personaPrompt.ifBlank {
    personas.getOrNull(selectedPersona)?.personaPrompt.orEmpty()
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
