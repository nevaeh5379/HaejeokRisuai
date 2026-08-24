package io.github.nevaeh5379.androidhaejeokrisuai.ui

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.github.nevaeh5379.androidhaejeokrisuai.data.ChatSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.DatabaseOverview
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessagePage
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.StorageConfig
import io.github.nevaeh5379.androidhaejeokrisuai.data.StorageConfigStore
import io.github.nevaeh5379.androidhaejeokrisuai.data.storage.RisuStorage
import io.github.nevaeh5379.androidhaejeokrisuai.data.storage.RisuStorageFactory
import java.util.UUID

internal enum class NativeScreen { SETUP, CHARACTERS, CHATS, CHAT }

internal class NativeRisuController(context: Context) {
    private val appContext = context.applicationContext
    private val configStore = StorageConfigStore(appContext)
    private var storage: RisuStorage? = null

    var screen by mutableStateOf(NativeScreen.SETUP)
        private set
    var config by mutableStateOf(configStore.load())
        private set
    var overview by mutableStateOf<DatabaseOverview?>(null)
        private set
    var chats by mutableStateOf<List<ChatSummary>>(emptyList())
        private set
    var messagePage by mutableStateOf<MessagePage?>(null)
        private set
    var selectedCharacter by mutableStateOf<CharacterSummary?>(null)
        private set
    var selectedChat by mutableStateOf<ChatSummary?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    suspend fun initialize() {
        val saved = config ?: return
        connect(saved, persist = false)
    }

    suspend fun configure(newConfig: StorageConfig) = connect(newConfig, persist = true)

    private suspend fun connect(newConfig: StorageConfig, persist: Boolean) {
        runBusy {
            val candidate = RisuStorageFactory.create(appContext, newConfig)
            candidate.init()
            val loaded = candidate.loadDatabase()
            storage = candidate
            config = newConfig
            overview = loaded
            chats = emptyList()
            messagePage = null
            selectedCharacter = null
            selectedChat = null
            screen = NativeScreen.CHARACTERS
            if (persist) configStore.save(newConfig)
        }
    }

    suspend fun refreshCharacters() = runBusy {
        overview = requireStorage().loadDatabase()
    }

    suspend fun openCharacter(character: CharacterSummary) = runBusy {
        selectedCharacter = character
        selectedChat = null
        messagePage = null
        chats = requireStorage().loadCharacterChats(character.id)
        screen = NativeScreen.CHATS
    }

    suspend fun openChat(chat: ChatSummary) = runBusy {
        selectedChat = chat
        messagePage = requireStorage().loadChatMessagePage(chat.id, before = null, limit = PAGE_SIZE)
        screen = NativeScreen.CHAT
    }

    suspend fun loadOlderMessages() = runBusy {
        val chat = selectedChat ?: return@runBusy
        val current = messagePage ?: return@runBusy
        if (!current.hasMore) return@runBusy
        val older = requireStorage().loadChatMessagePage(chat.id, before = current.offset, limit = PAGE_SIZE)
        messagePage = older.copy(
            messages = older.messages + current.messages,
            total = current.total,
            hasMore = older.offset > 0,
        )
    }

    suspend fun appendUserMessage(text: String) = runBusy {
        val chat = selectedChat ?: error("No chat selected")
        val current = messagePage ?: error("Chat messages are not loaded")
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return@runBusy
        val message = MessageRecord(
            id = UUID.randomUUID().toString(),
            chatId = chat.id,
            role = "user",
            data = trimmed,
            time = System.currentTimeMillis(),
        )
        val newRevision = requireStorage().appendMessage(chat.id, current.total, message)
        overview = overview?.copy(revision = newRevision)
        messagePage = current.copy(
            messages = current.messages + message,
            total = current.total + 1,
        )
    }

    fun back() {
        error = null
        when (screen) {
            NativeScreen.CHAT -> screen = NativeScreen.CHATS
            NativeScreen.CHATS -> screen = NativeScreen.CHARACTERS
            NativeScreen.CHARACTERS, NativeScreen.SETUP -> Unit
        }
    }

    fun resetStorageSelection() {
        configStore.clear()
        storage = null
        config = null
        overview = null
        chats = emptyList()
        messagePage = null
        selectedCharacter = null
        selectedChat = null
        error = null
        screen = NativeScreen.SETUP
    }

    fun dismissError() {
        error = null
    }

    private fun requireStorage(): RisuStorage = storage ?: error("Storage is not connected")

    private suspend fun runBusy(block: suspend () -> Unit) {
        if (loading) return
        loading = true
        error = null
        try {
            block()
        } catch (throwable: Throwable) {
            error = throwable.message ?: throwable::class.java.simpleName
        } finally {
            loading = false
        }
    }

    companion object {
        private const val PAGE_SIZE = 80
    }
}
