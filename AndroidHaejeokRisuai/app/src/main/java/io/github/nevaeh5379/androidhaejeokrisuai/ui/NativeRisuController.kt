package io.github.nevaeh5379.androidhaejeokrisuai.ui

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.github.nevaeh5379.androidhaejeokrisuai.data.ChatSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.DatabaseOverview
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessagePage
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import io.github.nevaeh5379.androidhaejeokrisuai.data.PositionedMessage
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.StorageConfig
import io.github.nevaeh5379.androidhaejeokrisuai.data.StorageConfigStore
import io.github.nevaeh5379.androidhaejeokrisuai.data.storage.RisuStorage
import io.github.nevaeh5379.androidhaejeokrisuai.data.storage.RisuStorageFactory
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeChatRuntimeProcessor
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeGenerationEngine
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeRegexProcessor
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeRisuParserContext
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeTriggerProcessor
import io.github.nevaeh5379.androidhaejeokrisuai.importing.CharacterCardImporter
import java.io.ByteArrayOutputStream
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal enum class NativeScreen { SETUP, CHARACTERS, MODEL_SETTINGS, CHATS, CHAT }

internal class NativeRisuController(context: Context) {
    private val appContext = context.applicationContext
    private val configStore = StorageConfigStore(appContext)
    private var storage: RisuStorage? = null
    private val generator = NativeGenerationEngine()

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

    fun openGenerationSettings() {
        error = null
        screen = NativeScreen.MODEL_SETTINGS
    }

    suspend fun saveGenerationSettings(settings: GenerationSettings) = runBusy {
        requireStorage().updateGenerationSettings(settings)
        overview = requireStorage().loadDatabase()
        screen = NativeScreen.CHARACTERS
    }

    suspend fun importCharacterCard(uri: Uri) = runBusy {
        val (fileName, bytes) = withContext(Dispatchers.IO) { readImportFile(uri) }
        val payload = withContext(Dispatchers.Default) { CharacterCardImporter.parse(fileName, bytes) }
        requireStorage().importCharacter(payload)
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

    suspend fun createNewChat() = runBusy {
        val character = selectedCharacter ?: error("No character selected")
        val storage = requireStorage()
        overview = storage.loadDatabase()
        val chat = storage.createChat(character.id, "New Chat ${chats.size + 1}")
        chats = storage.loadCharacterChats(character.id)
        selectedChat = chat
        messagePage = storage.loadChatMessagePage(chat.id, before = null, limit = PAGE_SIZE)
        screen = NativeScreen.CHAT
        overview = overview?.copy(revision = (overview?.revision ?: 0) + 1)
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

    suspend fun sendUserMessage(text: String) = runBusy {
        val chat = selectedChat ?: error("No chat selected")
        val character = selectedCharacter ?: error("No character selected")
        messagePage ?: error("Chat messages are not loaded")
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return@runBusy

        val storage = requireStorage()
        val freshOverview = storage.loadDatabase()
        overview = freshOverview
        val history = storage.loadAllChatMessages(chat.id)
        val profile = storage.loadCharacterProfile(character.id)
        val promptContext = storage.loadChatPromptContext(chat.id)
        val inputTrigger = NativeTriggerProcessor.run(
            mode = "input",
            settings = freshOverview.generationSettings,
            character = profile,
            messages = history,
            variables = promptContext.variables,
            chatId = chat.id,
            authorNote = chat.note,
            greetingIndex = promptContext.greetingIndex,
        )
        val parserContext = NativeRisuParserContext(
            settings = freshOverview.generationSettings,
            character = profile,
            history = inputTrigger.messages,
            authorNote = chat.note,
            greetingIndex = promptContext.greetingIndex,
            variables = inputTrigger.variables,
        )
        val processedInput = NativeRegexProcessor.process(
            data = trimmed,
            mode = "editinput",
            settings = freshOverview.generationSettings,
            character = profile,
            parserContext = parserContext,
        )
        val userMessage = MessageRecord(
            id = UUID.randomUUID().toString(),
            chatId = chat.id,
            role = "user",
            data = processedInput,
            time = System.currentTimeMillis(),
        )
        val prepared = NativeChatRuntimeProcessor.prepare(
            settings = freshOverview.generationSettings,
            character = profile,
            messages = inputTrigger.messages + userMessage,
            authorNote = chat.note,
            greetingIndex = promptContext.greetingIndex,
            variables = inputTrigger.variables,
        )
        val startTrigger = NativeTriggerProcessor.run(
            mode = "start",
            settings = freshOverview.generationSettings,
            character = profile,
            messages = prepared.messages,
            variables = prepared.variables,
            chatId = chat.id,
            authorNote = chat.note,
            greetingIndex = promptContext.greetingIndex,
        )
        val chatPosition = chats.indexOfFirst { it.id == chat.id }
        require(chatPosition >= 0) { "Selected chat is missing from the character chat list" }
        val userRevision = storage.commitPreparedTurn(
            characterId = character.id,
            chatId = chat.id,
            chatPosition = chatPosition,
            messages = changedMessages(history, startTrigger.messages),
            variables = startTrigger.variables,
        )
        overview = freshOverview.copy(revision = userRevision)
        messagePage = storage.loadChatMessagePage(chat.id, before = null, limit = PAGE_SIZE)
        if (startTrigger.stopSending) return@runBusy

        val generated = generator.generate(
            settings = freshOverview.generationSettings,
            character = profile.copy(globalLore = profile.globalLore + promptContext.localLore),
            history = startTrigger.messages,
            authorNote = chat.note,
            greetingIndex = promptContext.greetingIndex,
            variables = startTrigger.variables,
            triggerPrompt = startTrigger.promptInjection,
        )
        val rawAssistant = MessageRecord(
            id = UUID.randomUUID().toString(),
            chatId = chat.id,
            role = "char",
            data = generated,
            name = profile.name,
            time = System.currentTimeMillis(),
        )
        val processedAssistant = rawAssistant.copy(
            data = NativeRegexProcessor.process(
                data = generated,
                mode = "editoutput",
                settings = freshOverview.generationSettings,
                character = profile,
                parserContext = parserContext.copy(
                    history = startTrigger.messages + rawAssistant,
                    variables = startTrigger.variables,
                ),
            ),
        )
        val outputPrepared = NativeChatRuntimeProcessor.prepare(
            settings = freshOverview.generationSettings,
            character = profile,
            messages = startTrigger.messages + processedAssistant,
            authorNote = chat.note,
            greetingIndex = promptContext.greetingIndex,
            variables = startTrigger.variables,
        )
        val outputTrigger = NativeTriggerProcessor.run(
            mode = "output",
            settings = freshOverview.generationSettings,
            character = profile,
            messages = outputPrepared.messages,
            variables = outputPrepared.variables,
            chatId = chat.id,
            authorNote = chat.note,
            greetingIndex = promptContext.greetingIndex,
        )
        val assistantRevision = storage.commitPreparedTurn(
            characterId = character.id,
            chatId = chat.id,
            chatPosition = chatPosition,
            messages = changedMessages(startTrigger.messages, outputTrigger.messages),
            variables = outputTrigger.variables,
        )
        overview = freshOverview.copy(revision = assistantRevision)
        messagePage = storage.loadChatMessagePage(chat.id, before = null, limit = PAGE_SIZE)
    }

    private fun changedMessages(before: List<MessageRecord>, after: List<MessageRecord>): List<PositionedMessage> {
        val previous = before.associateBy(MessageRecord::id)
        return after.mapIndexedNotNull { index, message ->
            if (previous[message.id] != message) PositionedMessage(index, message) else null
        }
    }

    fun back() {
        error = null
        when (screen) {
            NativeScreen.CHAT -> screen = NativeScreen.CHATS
            NativeScreen.CHATS, NativeScreen.MODEL_SETTINGS -> screen = NativeScreen.CHARACTERS
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

    private fun readImportFile(uri: Uri): Pair<String, ByteArray> {
        val resolver = appContext.contentResolver
        var fileName = uri.lastPathSegment ?: "character-card"
        var declaredSize: Long? = null
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) fileName = cursor.getString(nameIndex)
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) declaredSize = cursor.getLong(sizeIndex)
            }
        }
        require(declaredSize == null || declaredSize!! <= MAX_IMPORT_BYTES) {
            "Character card is larger than ${MAX_IMPORT_BYTES / (1024 * 1024)} MiB"
        }
        val input = resolver.openInputStream(uri) ?: error("Unable to open selected character card")
        val output = ByteArrayOutputStream(
            (declaredSize ?: 64 * 1024L).coerceAtMost(1024 * 1024L).toInt(),
        )
        input.use { stream ->
            val buffer = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                val count = stream.read(buffer)
                if (count < 0) break
                total += count
                require(total <= MAX_IMPORT_BYTES) {
                    "Character card is larger than ${MAX_IMPORT_BYTES / (1024 * 1024)} MiB"
                }
                output.write(buffer, 0, count)
            }
        }
        return fileName to output.toByteArray()
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
        private const val MAX_IMPORT_BYTES = 64L * 1024 * 1024
    }
}
