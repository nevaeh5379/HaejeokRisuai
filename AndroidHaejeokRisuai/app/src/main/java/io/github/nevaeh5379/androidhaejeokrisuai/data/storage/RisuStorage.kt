package io.github.nevaeh5379.androidhaejeokrisuai.data.storage

import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterImportPayload
import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterProfile
import io.github.nevaeh5379.androidhaejeokrisuai.data.CharacterSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.ChatPromptContext
import io.github.nevaeh5379.androidhaejeokrisuai.data.ChatSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.DatabaseOverview
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessagePage
import io.github.nevaeh5379.androidhaejeokrisuai.data.LoreEntry
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord

interface RisuStorage {
    suspend fun init()
    suspend fun loadDatabase(): DatabaseOverview
    suspend fun loadCharacterProfile(characterId: String): CharacterProfile
    suspend fun loadCharacterChats(characterId: String): List<ChatSummary>
    suspend fun importCharacter(payload: CharacterImportPayload): CharacterSummary
    suspend fun updateGenerationSettings(settings: GenerationSettings): Long
    suspend fun createChat(characterId: String, name: String): ChatSummary
    suspend fun loadChatPromptContext(chatId: String): ChatPromptContext
    suspend fun loadChatMessagePage(chatId: String, before: Int?, limit: Int): MessagePage
    suspend fun loadAllChatMessages(chatId: String): List<MessageRecord>
    suspend fun appendMessage(chatId: String, position: Int, message: MessageRecord): Long
}
