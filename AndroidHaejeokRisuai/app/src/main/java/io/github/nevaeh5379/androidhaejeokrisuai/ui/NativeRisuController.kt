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
import io.github.nevaeh5379.androidhaejeokrisuai.generation.NativeDisplayProcessor
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
    private var rawMessagePage: MessagePage? = null
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
            rawMessagePage = null
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
        rawMessagePage = null
        messagePage = null
        chats = requireStorage().loadCharacterChats(character.id)
        screen = NativeScreen.CHATS
    }

    suspend fun openChat(chat: ChatSummary) = runBusy {
        selectedChat = chat
        publishMessagePage(requireStorage().loadChatMessagePage(chat.id, before = null, limit = PAGE_SIZE))
        screen = NativeScreen.CHAT
    }

    suspend fun createNewChat() = runBusy {
        val character = selectedCharacter ?: error("No character selected")
        val storage = requireStorage()
        overview = storage.loadDatabase()
        val chat = storage.createChat(character.id, "New Chat ${chats.size + 1}")
        chats = storage.loadCharacterChats(character.id)
        selectedChat = chat
        publishMessagePage(storage.loadChatMessagePage(chat.id, before = null, limit = PAGE_SIZE))
        screen = NativeScreen.CHAT
        overview = overview?.copy(revision = (overview?.revision ?: 0) + 1)
    }

    suspend fun loadOlderMessages() = runBusy {
        val chat = selectedChat ?: return@runBusy
        val current = rawMessagePage ?: return@runBusy
        if (!current.hasMore) return@runBusy
        val older = requireStorage().loadChatMessagePage(chat.id, before = current.offset, limit = PAGE_SIZE)
        publishMessagePage(
            older.copy(
                messages = older.messages + current.messages,
                total = current.total,
                hasMore = older.offset > 0,
            ),
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
        val characterPosition = freshOverview.characters.indexOfFirst { it.id == character.id }
        require(characterPosition >= 0) { "Selected character is missing from the database overview" }
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
        val inputProfile = inputTrigger.runtimePatch.applyTo(profile)
        val inputAuthorNote = inputTrigger.runtimePatch.resolveAuthorNote(chat.note)
        val parserContext = NativeRisuParserContext(
            settings = freshOverview.generationSettings,
            character = inputProfile,
            history = inputTrigger.messages,
            authorNote = inputAuthorNote,
            greetingIndex = promptContext.greetingIndex,
            variables = inputTrigger.variables,
        )
        val processedInput = NativeRegexProcessor.process(
            data = trimmed,
            mode = "editinput",
            settings = freshOverview.generationSettings,
            character = inputProfile,
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
            character = inputProfile,
            messages = inputTrigger.messages + userMessage,
            authorNote = inputAuthorNote,
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
            inheritedPatch = inputTrigger.runtimePatch,
        )
        val startProfile = startTrigger.runtimePatch.applyTo(profile)
        val startAuthorNote = startTrigger.runtimePatch.resolveAuthorNote(chat.note)
        val chatPosition = chats.indexOfFirst { it.id == chat.id }
        require(chatPosition >= 0) { "Selected chat is missing from the character chat list" }
        val userRevision = storage.commitPreparedTurn(
            characterId = character.id,
            chatId = chat.id,
            chatPosition = chatPosition,
            messages = changedMessages(history, startTrigger.messages),
            variables = startTrigger.variables,
            messageManifest = startTrigger.messages.map(MessageRecord::id),
            characterPosition = characterPosition,
            runtimePatch = startTrigger.runtimePatch,
        )
        overview = freshOverview.copy(revision = userRevision)
        updateSelectedChatNote(startAuthorNote)
        publishMessagePage(storage.loadChatMessagePage(chat.id, before = null, limit = PAGE_SIZE))
        if (startTrigger.stopSending) return@runBusy

        val generated = generator.generate(
            settings = freshOverview.generationSettings,
            character = startProfile.copy(globalLore = startProfile.globalLore + promptContext.localLore),
            history = startTrigger.messages,
            authorNote = startAuthorNote,
            greetingIndex = promptContext.greetingIndex,
            variables = startTrigger.variables,
            triggerPrompt = startTrigger.promptInjection,
        )
        val rawAssistant = MessageRecord(
            id = UUID.randomUUID().toString(),
            chatId = chat.id,
            role = "char",
            data = generated,
            name = startProfile.name,
            time = System.currentTimeMillis(),
        )
        val processedAssistant = rawAssistant.copy(
            data = NativeRegexProcessor.process(
                data = generated,
                mode = "editoutput",
                settings = freshOverview.generationSettings,
                character = startProfile,
                parserContext = parserContext.copy(
                    character = startProfile,
                    history = startTrigger.messages + rawAssistant,
                    authorNote = startAuthorNote,
                    variables = startTrigger.variables,
                ),
            ),
        )
        val outputPrepared = NativeChatRuntimeProcessor.prepare(
            settings = freshOverview.generationSettings,
            character = startProfile,
            messages = startTrigger.messages + processedAssistant,
            authorNote = startAuthorNote,
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
            inheritedPatch = startTrigger.runtimePatch,
        )
        val finalAuthorNote = outputTrigger.runtimePatch.resolveAuthorNote(chat.note)
        val assistantRevision = storage.commitPreparedTurn(
            characterId = character.id,
            chatId = chat.id,
            chatPosition = chatPosition,
            messages = changedMessages(startTrigger.messages, outputTrigger.messages),
            variables = outputTrigger.variables,
            messageManifest = outputTrigger.messages.map(MessageRecord::id),
            characterPosition = characterPosition,
            runtimePatch = outputTrigger.runtimePatch,
        )
        overview = freshOverview.copy(revision = assistantRevision)
        updateSelectedChatNote(finalAuthorNote)
        publishMessagePage(storage.loadChatMessagePage(chat.id, before = null, limit = PAGE_SIZE))
    }

    private suspend fun publishMessagePage(raw: MessagePage) {
        rawMessagePage = raw
        val character = selectedCharacter
        val chat = selectedChat
        val settings = overview?.generationSettings
        if (character == null || chat == null || settings == null || raw.messages.isEmpty()) {
            messagePage = raw
            return
        }

        val storage = requireStorage()
        val profile = storage.loadCharacterProfile(character.id)
        val promptContext = storage.loadChatPromptContext(chat.id)
        val requiredDepth = NativeDisplayProcessor.requiredHistoryDepth(profile)
        val history = when {
            requiredDepth == null -> storage.loadAllChatMessages(chat.id)
            requiredDepth <= raw.messages.size -> raw.messages
            requiredDepth <= MAX_DISPLAY_CONDITION_DEPTH -> storage.loadChatMessagePage(
                chat.id,
                before = null,
                limit = requiredDepth.coerceAtLeast(1),
            ).messages
            else -> storage.loadAllChatMessages(chat.id)
        }
        val rendered = raw.messages.map { message ->
            message.copy(
                data = NativeDisplayProcessor.process(
                    data = message.data,
                    settings = settings,
                    character = profile,
                    history = history,
                    variables = promptContext.variables,
                    chatId = chat.id,
                    authorNote = chat.note,
                    greetingIndex = promptContext.greetingIndex,
                    messageCount = raw.total,
                ),
            )
        }
        messagePage = raw.copy(messages = rendered)
    }

    private fun updateSelectedChatNote(note: String) {
        val id = selectedChat?.id ?: return
        selectedChat = selectedChat?.copy(note = note)
        chats = chats.map { item -> if (item.id == id) item.copy(note = note) else item }
    }

    private fun changedMessages(before: List<MessageRecord>, after: List<MessageRecord>): List<PositionedMessage> {
        val previous = before.mapIndexed { index, message -> message.id to (index to message) }.toMap()
        return after.mapIndexedNotNull { index, message ->
            val old = previous[message.id]
            if (old == null || old.first != index || old.second != message) PositionedMessage(index, message) else null
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
        rawMessagePage = null
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
        private const val MAX_DISPLAY_CONDITION_DEPTH = 500
        private const val MAX_IMPORT_BYTES = 64L * 1024 * 1024
    }
}
