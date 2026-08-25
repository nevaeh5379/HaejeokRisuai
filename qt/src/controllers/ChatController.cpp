#include "ChatController.hpp"
#include "../core/DatabaseManager.hpp"
#include "../core/AppConfig.hpp"
#include "../engine/PromptEngine.hpp"
#include "../engine/RegexEngine.hpp"
#include "../engine/ModuleEngine.hpp"
#include "../engine/Tokenizer.hpp"
#include "../storage/ExportImport.hpp"
#include <QDebug>

namespace Risu {

ChatController::ChatController(QObject* parent) : QObject(parent) {
    // Keep prompt state synchronized with preset and persona changes.
    connect(&DatabaseManager::instance(), &DatabaseManager::presetsChanged, this, &ChatController::reloadPreset);
    connect(&DatabaseManager::instance(), &DatabaseManager::personasChanged, this, &ChatController::reloadPersona);

    QString charId = AppConfig::instance().selectedCharacterId();
    if (!charId.isEmpty()) {
        loadCharacter(charId);
    }
    reloadPreset();
}

ChatController::~ChatController() {
    cancelGeneration();
}

QString ChatController::currentChatName() const {
    if (m_activeChar.chats.isEmpty()) return QStringLiteral("Main Chat");
    return m_activeChar.currentChat().name;
}

QStringList ChatController::chatNames() const {
    QStringList names;
    for (const auto& c : m_activeChar.chats) {
        names.append(c.name.isEmpty() ? QStringLiteral("Chat") : c.name);
    }
    return names;
}

QVariantList ChatController::chatSessions() const {
    QVariantList list;
    for (int i = 0; i < m_activeChar.chats.size(); ++i) {
        const auto& c = m_activeChar.chats[i];
        QVariantMap item;
        item[QStringLiteral("id")] = c.id;
        item[QStringLiteral("index")] = i;
        item[QStringLiteral("name")] = c.name.isEmpty() ? QStringLiteral("Chat %1").arg(i + 1) : c.name;
        item[QStringLiteral("messageCount")] = c.messages.size();
        item[QStringLiteral("lastDate")] = c.lastDate;

        if (c.lastDate > 0) {
            QDateTime dt = QDateTime::fromMSecsSinceEpoch(c.lastDate);
            QDateTime now = QDateTime::currentDateTime();
            if (dt.date() == now.date()) {
                item[QStringLiteral("lastDateFormatted")] = dt.toString(QStringLiteral("Today hh:mm"));
            } else if (dt.date() == now.date().addDays(-1)) {
                item[QStringLiteral("lastDateFormatted")] = dt.toString(QStringLiteral("Yesterday hh:mm"));
            } else {
                item[QStringLiteral("lastDateFormatted")] = dt.toString(QStringLiteral("yyyy-MM-dd hh:mm"));
            }
        } else {
            item[QStringLiteral("lastDateFormatted")] = QStringLiteral("New");
        }

        QString preview;
        if (!c.messages.isEmpty()) {
            const auto& lastMsg = c.messages.last();
            QString raw = lastMsg.currentContent();
            preview = raw.length() > 60 ? raw.left(60) + QStringLiteral("...") : raw;
        }
        item[QStringLiteral("preview")] = preview;
        item[QStringLiteral("isActive")] = (i == m_activeChar.currentChatIndex);
        item[QStringLiteral("firstMessageIndex")] = c.firstMessageIndex;
        item[QStringLiteral("authorNote")] = c.authorNote;
        item[QStringLiteral("authorNoteDepth")] = c.authorNoteDepth;
        list.append(item);
    }
    return list;
}

QStringList ChatController::availableGreetings() const {
    QStringList greetings;
    if (!m_activeChar.firstMessage.isEmpty()) {
        greetings.append(m_activeChar.firstMessage);
    }
    for (const auto& alt : m_activeChar.alternateGreetings) {
        if (!alt.trimmed().isEmpty()) {
            greetings.append(alt);
        }
    }
    return greetings;
}

int ChatController::currentGreetingIndex() const {
    if (m_activeChar.chats.isEmpty()) return 0;
    return m_activeChar.currentChat().firstMessageIndex;
}

void ChatController::reloadPreset() {
    QString presetId = AppConfig::instance().selectedPresetId();
    auto optPreset = DatabaseManager::instance().getPreset(presetId);
    if (optPreset) {
        m_activePreset = *optPreset;
    } else {
        auto allPresets = DatabaseManager::instance().getAllPresets();
        if (!allPresets.isEmpty()) {
            m_activePreset = allPresets.first();
            AppConfig::instance().setSelectedPresetId(m_activePreset.id);
        }
    }

    emit activePresetChanged();
    reloadPersona();
}

void ChatController::reloadPersona() {
    std::optional<Persona> resolved;

    // Risu chats may pin a persona per session. Prefer that binding over the
    // globally active persona so prompt macros, message names, and modules all
    // observe the same user identity after switching chats.
    if (!m_activeChar.chats.isEmpty()) {
        const QString boundId = m_activeChar.currentChat().bindedPersona.trimmed();
        if (!boundId.isEmpty()) {
            resolved = DatabaseManager::instance().getPersona(boundId);
        }
    }

    if (!resolved) {
        resolved = DatabaseManager::instance().getActivePersona();
    }

    if (resolved) {
        m_activePersona = *resolved;
    } else {
        m_activePersona = Persona{};
        m_activePersona.id = QStringLiteral("persona-default");
        m_activePersona.name = QStringLiteral("User");
    }

    updateTokenEstimate();
}

void ChatController::loadCharacter(const QString& characterId) {
    cancelGeneration();

    auto optChar = DatabaseManager::instance().getCharacter(characterId);
    if (!optChar) {
        return;
    }

    m_activeChar = *optChar;
    AppConfig::instance().setSelectedCharacterId(m_activeChar.id);

    // Load active chat messages into model
    Chat& chat = m_activeChar.currentChat();
    m_messageModel.setMessages(chat.messages);

    emit activeCharacterChanged();
    emit currentChatChanged();
    emit chatListChanged();
    reloadPersona();
}

QList<RegexScript> ChatController::activeRegexScripts() const {
    QList<RegexScript> scripts = m_activeChar.customScripts;
    if (!m_activeChar.chats.isEmpty()) {
        const ActiveModuleData modules = ModuleEngine::resolveActiveModules(m_activeChar, m_activeChar.currentChat());
        scripts.append(modules.regexScripts);
    }
    return scripts;
}

void ChatController::sendMessage(const QString& userText, const QString& attachmentPath) {
    if (m_isGenerating || (userText.trimmed().isEmpty() && attachmentPath.isEmpty())) return;

    // Apply preGen regex scripts if any
    QString processedUserText = RegexEngine::applyPreGenRegex(userText, activeRegexScripts());

    // Create User Message
    Message userMsg;
    userMsg.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    userMsg.role = Role::User;
    userMsg.name = m_activePersona.name;
    userMsg.setCurrentContent(processedUserText);
    userMsg.attachmentPath = attachmentPath;
    userMsg.timestamp = QDateTime::currentMSecsSinceEpoch();

    m_messageModel.appendMessage(userMsg);
    m_activeChar.currentChat().messages.append(userMsg);
    m_activeChar.currentChat().lastDate = userMsg.timestamp;
    m_activeChar.lastInteraction = userMsg.timestamp;

    saveCurrentChatToDb();

    startGeneration(processedUserText, false);
}

void ChatController::regenerateLastMessage() {
    if (m_isGenerating || m_messageModel.messages().isEmpty()) return;

    int lastIdx = m_messageModel.messages().size() - 1;
    const Message& lastMsg = m_messageModel.messageAt(lastIdx);

    if (lastMsg.role == Role::Assistant) {
        startGeneration(QString(), true);
    } else {
        startGeneration(QString(), false);
    }
}

void ChatController::swipeLeft(int messageIndex) {
    if (m_isGenerating) return;
    m_messageModel.swipeLeft(messageIndex);
    m_activeChar.currentChat().messages = m_messageModel.messages();
    saveCurrentChatToDb();
    updateTokenEstimate();
}

void ChatController::swipeRight(int messageIndex) {
    if (m_isGenerating) return;

    const Message& msg = m_messageModel.messageAt(messageIndex);
    if (msg.currentSwipeIndex == msg.swipes.size() - 1 && msg.role == Role::Assistant && messageIndex == m_messageModel.messages().size() - 1) {
        // Generate a new swipe alternative!
        startGeneration(QString(), true);
    } else {
        m_messageModel.swipeRight(messageIndex);
        m_activeChar.currentChat().messages = m_messageModel.messages();
        saveCurrentChatToDb();
        updateTokenEstimate();
    }
}

void ChatController::editMessage(int messageIndex, const QString& newText) {
    if (m_isGenerating) return;
    m_messageModel.editMessage(messageIndex, newText);
    m_activeChar.currentChat().messages = m_messageModel.messages();
    saveCurrentChatToDb();
    updateTokenEstimate();
}

void ChatController::deleteMessage(int messageIndex) {
    if (m_isGenerating) return;
    m_messageModel.removeMessageAt(messageIndex);
    m_activeChar.currentChat().messages = m_messageModel.messages();
    saveCurrentChatToDb();
    updateTokenEstimate();
}

void ChatController::forkChat(int messageIndex) {
    if (m_isGenerating || messageIndex < 0 || messageIndex >= m_messageModel.messages().size()) return;

    // Risu branches clone the entire chat session and only truncate its message list.
    // Preserve persona bindings, modules, lore, author notes, variables, and other
    // chat-scoped settings so branching cannot silently change prompt behavior.
    Chat newChat = m_activeChar.currentChat();
    newChat.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    newChat.name = QStringLiteral("Branch from ") + m_activeChar.currentChat().name;
    newChat.lastDate = QDateTime::currentMSecsSinceEpoch();
    newChat.messages.clear();

    for (int i = 0; i <= messageIndex; ++i) {
        newChat.messages.append(m_messageModel.messageAt(i));
    }

    m_activeChar.chats.append(newChat);
    m_activeChar.currentChatIndex = m_activeChar.chats.size() - 1;
    m_messageModel.setMessages(newChat.messages);

    DatabaseManager::instance().saveCharacter(m_activeChar);

    emit currentChatChanged();
    emit chatListChanged();
    reloadPersona();
    emit toastRequested(QStringLiteral("info"), QStringLiteral("Created new chat branch!"));
}

void ChatController::clearCurrentChat() {
    if (m_isGenerating) cancelGeneration();

    m_messageModel.clear();
    m_activeChar.currentChat().messages.clear();

    // Re-insert character greeting if available
    QString greeting = m_activeChar.firstMessage;
    if (!greeting.isEmpty()) {
        Message m;
        m.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
        m.role = Role::Assistant;
        m.name = m_activeChar.name;
        m.setCurrentContent(greeting);
        m.timestamp = QDateTime::currentMSecsSinceEpoch();
        m_messageModel.appendMessage(m);
        m_activeChar.currentChat().messages.append(m);
    }

    saveCurrentChatToDb();
    updateTokenEstimate();
    emit currentChatChanged();
    emit chatListChanged();
}

void ChatController::clearChat(int chatIndex) {
    int idx = (chatIndex < 0) ? m_activeChar.currentChatIndex : chatIndex;
    if (idx < 0 || idx >= m_activeChar.chats.size()) return;

    if (m_isGenerating) cancelGeneration();

    m_activeChar.chats[idx].messages.clear();

    // Re-seed with initial greeting
    QStringList greetings = availableGreetings();
    int gIdx = m_activeChar.chats[idx].firstMessageIndex;
    QString greeting = (gIdx >= 0 && gIdx < greetings.size()) ? greetings[gIdx] : m_activeChar.firstMessage;

    if (!greeting.isEmpty()) {
        Message m;
        m.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
        m.role = Role::Assistant;
        m.name = m_activeChar.name;
        m.setCurrentContent(greeting);
        m.timestamp = QDateTime::currentMSecsSinceEpoch();
        m_activeChar.chats[idx].messages.append(m);
    }

    if (idx == m_activeChar.currentChatIndex) {
        m_messageModel.setMessages(m_activeChar.chats[idx].messages);
    }

    DatabaseManager::instance().saveChat(m_activeChar.id, m_activeChar.chats[idx]);
    DatabaseManager::instance().saveCharacter(m_activeChar);

    emit currentChatChanged();
    emit chatListChanged();
    updateTokenEstimate();
    emit toastRequested(QStringLiteral("info"), QStringLiteral("Chat messages cleared."));
}

void ChatController::createNewChat(const QString& chatName) {
    createNewChatWithGreeting(0, chatName);
}

void ChatController::createNewChatWithGreeting(int greetingIndex, const QString& chatName) {
    if (m_isGenerating) cancelGeneration();

    Chat c;
    c.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    c.name = chatName.isEmpty() ? QStringLiteral("Chat %1").arg(m_activeChar.chats.size() + 1) : chatName;
    c.firstMessageIndex = greetingIndex;
    c.lastDate = QDateTime::currentMSecsSinceEpoch();

    QStringList greetings = availableGreetings();
    QString greetingText = m_activeChar.firstMessage;
    if (greetingIndex >= 0 && greetingIndex < greetings.size()) {
        greetingText = greetings[greetingIndex];
    }

    if (!greetingText.isEmpty()) {
        Message m;
        m.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
        m.role = Role::Assistant;
        m.name = m_activeChar.name;
        m.setCurrentContent(greetingText);
        m.timestamp = c.lastDate;
        c.messages.append(m);
    }

    m_activeChar.chats.append(c);
    m_activeChar.currentChatIndex = m_activeChar.chats.size() - 1;
    m_messageModel.setMessages(c.messages);

    DatabaseManager::instance().saveChat(m_activeChar.id, c);
    DatabaseManager::instance().saveCharacter(m_activeChar);

    emit currentChatChanged();
    emit chatListChanged();
    reloadPersona();
    emit toastRequested(QStringLiteral("success"), QStringLiteral("New chat session created."));
}

void ChatController::renameChat(int chatIndex, const QString& newName) {
    if (chatIndex < 0 || chatIndex >= m_activeChar.chats.size()) return;
    QString trimmed = newName.trimmed();
    if (trimmed.isEmpty()) return;

    m_activeChar.chats[chatIndex].name = trimmed;
    DatabaseManager::instance().saveChat(m_activeChar.id, m_activeChar.chats[chatIndex]);
    DatabaseManager::instance().saveCharacter(m_activeChar);

    emit currentChatChanged();
    emit chatListChanged();
    emit toastRequested(QStringLiteral("info"), QStringLiteral("Chat session renamed."));
}

void ChatController::duplicateChat(int chatIndex) {
    if (chatIndex < 0 || chatIndex >= m_activeChar.chats.size()) return;

    Chat source = m_activeChar.chats[chatIndex];
    Chat copy = source;
    copy.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    copy.name = QStringLiteral("%1 (Copy)").arg(source.name);
    copy.lastDate = QDateTime::currentMSecsSinceEpoch();

    // Give cloned messages new unique IDs
    for (auto& msg : copy.messages) {
        msg.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
        for (auto& sw : msg.swipes) {
            sw.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
        }
    }

    m_activeChar.chats.append(copy);
    m_activeChar.currentChatIndex = m_activeChar.chats.size() - 1;
    m_messageModel.setMessages(copy.messages);

    DatabaseManager::instance().saveChat(m_activeChar.id, copy);
    DatabaseManager::instance().saveCharacter(m_activeChar);

    emit currentChatChanged();
    emit chatListChanged();
    reloadPersona();
    emit toastRequested(QStringLiteral("info"), QStringLiteral("Chat session duplicated."));
}

void ChatController::switchChat(int chatIndex) {
    if (chatIndex < 0 || chatIndex >= m_activeChar.chats.size() || chatIndex == m_activeChar.currentChatIndex) return;

    if (m_isGenerating) cancelGeneration();

    m_activeChar.currentChatIndex = chatIndex;
    m_messageModel.setMessages(m_activeChar.currentChat().messages);

    DatabaseManager::instance().saveCharacter(m_activeChar);

    emit currentChatChanged();
    emit chatListChanged();
    reloadPersona();
}

void ChatController::deleteChat(int chatIndex) {
    if (chatIndex < 0 || chatIndex >= m_activeChar.chats.size()) return;

    if (m_activeChar.chats.size() <= 1) {
        emit toastRequested(QStringLiteral("warning"), QStringLiteral("Cannot delete the only chat session."));
        return;
    }

    if (m_isGenerating) cancelGeneration();

    QString chatIdToDelete = m_activeChar.chats[chatIndex].id;
    m_activeChar.chats.removeAt(chatIndex);
    if (m_activeChar.currentChatIndex >= m_activeChar.chats.size()) {
        m_activeChar.currentChatIndex = m_activeChar.chats.size() - 1;
    }

    DatabaseManager::instance().deleteChat(chatIdToDelete);
    DatabaseManager::instance().saveCharacter(m_activeChar);

    m_messageModel.setMessages(m_activeChar.currentChat().messages);

    emit currentChatChanged();
    emit chatListChanged();
    reloadPersona();
    emit toastRequested(QStringLiteral("info"), QStringLiteral("Chat session deleted."));
}

void ChatController::deleteChatSession(const QString& chatId) {
    for (int i = 0; i < m_activeChar.chats.size(); ++i) {
        if (m_activeChar.chats[i].id == chatId) {
            deleteChat(i);
            return;
        }
    }
}

bool ChatController::exportSpecificChat(int chatIndex, const QString& format, const QString& filePath) {
    if (chatIndex < 0 || chatIndex >= m_activeChar.chats.size()) return false;
    const Chat& targetChat = m_activeChar.chats[chatIndex];
    QString fmt = format.toLower();
    if (fmt == QStringLiteral("md") || fmt == QStringLiteral("markdown")) {
        return ExportImport::exportChatToMarkdown(m_activeChar, targetChat, filePath);
    } else if (fmt == QStringLiteral("html")) {
        return ExportImport::exportChatToHtml(m_activeChar, targetChat, filePath);
    } else if (fmt == QStringLiteral("json")) {
        return ExportImport::exportChatToJson(m_activeChar, targetChat, filePath);
    }
    return ExportImport::exportChatToText(m_activeChar, targetChat, filePath);
}

void ChatController::cancelGeneration() {
    if (m_currentProvider && m_currentProvider->isRunning()) {
        m_currentProvider->cancel();
    }
    if (m_isGenerating) {
        m_isGenerating = false;
        m_streamOutputTokens = 0;
        emit isGeneratingChanged();
        emit streamOutputTokensChanged();
    }
}

QString ChatController::authorNote() const {
    if (m_activeChar.chats.isEmpty()) return QString();
    const auto& c = m_activeChar.currentChat();
    return c.authorNote.isEmpty() ? m_activeChar.authorNote : c.authorNote;
}

int ChatController::authorNoteDepth() const {
    if (m_activeChar.chats.isEmpty()) return 3;
    const auto& c = m_activeChar.currentChat();
    return c.authorNote.isEmpty() ? m_activeChar.authorNoteDepth : c.authorNoteDepth;
}

void ChatController::setAuthorNote(const QString& note) {
    if (m_activeChar.chats.isEmpty()) return;
    m_activeChar.currentChat().authorNote = note;
    saveCurrentChatToDb();
    emit authorNoteChanged();
    updateTokenEstimate();
}

void ChatController::setAuthorNoteDepth(int depth) {
    if (m_activeChar.chats.isEmpty()) return;
    m_activeChar.currentChat().authorNoteDepth = depth;
    saveCurrentChatToDb();
    emit authorNoteChanged();
    updateTokenEstimate();
}

void ChatController::toggleMessagePin(int messageIndex) {
    m_messageModel.togglePinned(messageIndex);
    if (messageIndex >= 0 && messageIndex < m_activeChar.currentChat().messages.size()) {
        m_activeChar.currentChat().messages[messageIndex].isPinned = m_messageModel.messageAt(messageIndex).isPinned;
        saveCurrentChatToDb();
    }
}

void ChatController::setMessageEmotion(int messageIndex, const QString& emotion) {
    m_messageModel.setEmotion(messageIndex, emotion);
    if (messageIndex >= 0 && messageIndex < m_activeChar.currentChat().messages.size()) {
        m_activeChar.currentChat().messages[messageIndex].emotion = emotion;
        saveCurrentChatToDb();
    }
}

QString ChatController::getEmotionSprite(const QString& emotion) const {
    QString path = m_activeChar.avatarPath;
    if (!emotion.isEmpty() && m_activeChar.emotionSprites.contains(emotion.toLower())) {
        path = m_activeChar.emotionSprites.value(emotion.toLower());
    }
    QString resolved = AppConfig::instance().resolveAssetPath(path);
    return resolved.isEmpty() ? path : resolved;
}

QStringList ChatController::availableEmotions() const {
    return m_activeChar.emotionSprites.keys();
}

QString ChatController::formatInChat(const QString& rawContent) const {
    if (rawContent.isEmpty()) return QString();
    // 1. Apply inChat / editdisplay regex scripts
    QString formatted = RegexEngine::applyInChatRegex(rawContent, activeRegexScripts());

    // 2. Resolve CBS macros using the same persona that prompt generation uses.
    // A chat-bound persona must not fall back to the unrelated global active persona here.
    const Chat* curChat = m_activeChar.chats.isEmpty() ? nullptr : &m_activeChar.currentChat();
    formatted = PromptEngine::replaceMacros(formatted, m_activeChar, m_activePersona, curChat, &m_activePreset);

    return formatted;
}

bool ChatController::exportChat(const QString& format, const QString& filePath) {
    QString fmt = format.toLower();
    if (fmt == QStringLiteral("md") || fmt == QStringLiteral("markdown")) {
        return ExportImport::exportChatToMarkdown(m_activeChar, m_activeChar.currentChat(), filePath);
    } else if (fmt == QStringLiteral("html")) {
        return ExportImport::exportChatToHtml(m_activeChar, m_activeChar.currentChat(), filePath);
    } else if (fmt == QStringLiteral("json")) {
        return ExportImport::exportChatToJson(m_activeChar, m_activeChar.currentChat(), filePath);
    } else {
        return ExportImport::exportChatToText(m_activeChar, m_activeChar.currentChat(), filePath);
    }
}

QVariantList ChatController::searchMessages(const QString& query) {
    QVariantList results;
    if (query.trimmed().isEmpty()) return results;

    const auto& msgs = m_messageModel.messages();
    for (int i = 0; i < msgs.size(); ++i) {
        QString content = msgs[i].currentContent();
        int foundIdx = content.indexOf(query, 0, Qt::CaseInsensitive);
        if (foundIdx != -1) {
            QVariantMap item;
            item[QStringLiteral("index")] = i;
            item[QStringLiteral("role")] = roleToString(msgs[i].role);
            item[QStringLiteral("name")] = msgs[i].name;
            int start = qMax(0, foundIdx - 30);
            int length = qMin(content.length() - start, 80);
            item[QStringLiteral("snippet")] = content.mid(start, length);
            results.append(item);
        }
    }
    return results;
}

void ChatController::updateTokenEstimate(const QString& draftText) {
    auto globalLore = DatabaseManager::instance().getAllGlobalLorebooks();
    CompiledPrompt prompt = PromptEngine::buildPrompt(
        m_activeChar,
        m_activeChar.currentChat(),
        m_activePreset,
        m_activePersona,
        globalLore,
        draftText
    );
    m_tokenEstimate = prompt.estimatedTokens;
    m_breakdown = prompt.breakdown;
    emit tokenEstimateChanged();
}

void ChatController::startGeneration(const QString& /*userText*/, bool isRegenerate) {
    m_isRegenerating = isRegenerate;
    m_isGenerating = true;
    m_streamOutputTokens = 0;
    emit isGeneratingChanged();
    emit streamOutputTokensChanged();

    if (isRegenerate) {
        int lastIdx = m_messageModel.messages().size() - 1;
        if (lastIdx >= 0 && m_messageModel.messageAt(lastIdx).role == Role::Assistant) {
            // Add an empty new swipe to the assistant message
            m_messageModel.addSwipeToMessage(lastIdx, QString(), QString());
        } else {
            // Create a new assistant message
            Message botMsg;
            botMsg.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
            botMsg.role = Role::Assistant;
            botMsg.name = m_activeChar.name;
            botMsg.timestamp = QDateTime::currentMSecsSinceEpoch();
            m_messageModel.appendMessage(botMsg);
        }
    } else {
        // Normal generation: append new empty Assistant message placeholder
        Message botMsg;
        botMsg.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
        botMsg.role = Role::Assistant;
        botMsg.name = m_activeChar.name;
        botMsg.timestamp = QDateTime::currentMSecsSinceEpoch();
        m_messageModel.appendMessage(botMsg);
    }

    auto globalLore = DatabaseManager::instance().getAllGlobalLorebooks();

    // If regenerating, exclude the last empty assistant placeholder from prompt compilation
    Chat tempChat = m_activeChar.currentChat();
    tempChat.messages = m_messageModel.messages();
    if (!tempChat.messages.isEmpty() && tempChat.messages.last().role == Role::Assistant && tempChat.messages.last().currentContent().isEmpty()) {
        tempChat.messages.removeLast();
    }

    CompiledPrompt compiled = PromptEngine::buildPrompt(
        m_activeChar,
        tempChat,
        m_activePreset,
        m_activePersona,
        globalLore
    );

    // Create provider
    m_currentProvider = AIProvider::create(m_activePreset.provider, this);
    connect(m_currentProvider.get(), &AIProvider::chunkReceived, this, &ChatController::onProviderChunkReceived);
    connect(m_currentProvider.get(), &AIProvider::finished, this, &ChatController::onProviderFinished);
    connect(m_currentProvider.get(), &AIProvider::errorOccurred, this, &ChatController::onProviderError);

    m_currentProvider->sendRequest(compiled, m_activePreset);
}

void ChatController::onProviderChunkReceived(const QString& textChunk, const QString& thoughtChunk) {
    if (!textChunk.isEmpty() || !thoughtChunk.isEmpty()) {
        m_messageModel.updateLastMessageChunk(textChunk, thoughtChunk);
        if (!textChunk.isEmpty()) {
            m_streamOutputTokens += Tokenizer::estimateTokens(textChunk);
            emit streamOutputTokensChanged();
        }
    }
}

void ChatController::onProviderFinished(const QString& fullResponse, const QString& thought, int inTok, int outTok) {
    // Check for emotion tag (e.g. [emotion:happy] or <emotion:blush>)
    static QRegularExpression emoRe(QStringLiteral(R"((?:\[|<)emotion:\s*([a-zA-Z0-9_-]+)(?:\]|>))"), QRegularExpression::CaseInsensitiveOption);
    auto emoMatch = emoRe.match(fullResponse);
    QString detectedEmotion;
    if (emoMatch.hasMatch()) {
        detectedEmotion = emoMatch.captured(1).toLower();
    }

    // Apply postGen regex scripts if any
    QString finalResponse = RegexEngine::applyPostGenRegex(fullResponse, activeRegexScripts());

    m_messageModel.finalizeLastMessage(finalResponse, thought, inTok, outTok);
    if (!detectedEmotion.isEmpty()) {
        int lastRow = m_messageModel.rowCount() - 1;
        if (lastRow >= 0) {
            m_messageModel.setEmotion(lastRow, detectedEmotion);
        }
    }

    m_activeChar.currentChat().messages = m_messageModel.messages();
    m_activeChar.currentChat().lastDate = QDateTime::currentMSecsSinceEpoch();
    m_activeChar.lastInteraction = m_activeChar.currentChat().lastDate;
    saveCurrentChatToDb();

    m_isGenerating = false;
    m_streamOutputTokens = 0;
    emit isGeneratingChanged();
    emit generationFinished(finalResponse);
    emit streamOutputTokensChanged();
    updateTokenEstimate();
}

void ChatController::onProviderError(const QString& errorMessage) {
    m_isGenerating = false;
    m_streamOutputTokens = 0;
    emit isGeneratingChanged();
    emit streamOutputTokensChanged();

    emit errorOccurred(errorMessage);
    emit toastRequested(QStringLiteral("error"), errorMessage);
}

void ChatController::saveCurrentChatToDb() {
    DatabaseManager::instance().saveChat(m_activeChar.id, m_activeChar.currentChat());
    DatabaseManager::instance().saveCharacter(m_activeChar);
}

} // namespace Risu
