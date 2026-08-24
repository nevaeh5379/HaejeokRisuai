package io.github.nevaeh5379.androidhaejeokrisuai.data.storage

import io.github.nevaeh5379.androidhaejeokrisuai.data.ChatSummary
import io.github.nevaeh5379.androidhaejeokrisuai.data.DatabaseOverview
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessagePage
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord

interface RisuStorage {
    suspend fun init()
    suspend fun loadDatabase(): DatabaseOverview
    suspend fun loadCharacterChats(characterId: String): List<ChatSummary>
    suspend fun loadChatMessagePage(chatId: String, before: Int?, limit: Int): MessagePage
    suspend fun appendMessage(chatId: String, position: Int, message: MessageRecord): Long
}
