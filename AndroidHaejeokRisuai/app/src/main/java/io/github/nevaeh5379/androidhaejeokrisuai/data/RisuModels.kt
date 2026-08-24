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

data class DatabaseOverview(
    val status: String,
    val revision: Long,
    val characters: List<CharacterSummary>,
)

data class MessagePage(
    val messages: List<MessageRecord>,
    val offset: Int,
    val total: Int,
    val hasMore: Boolean,
)
