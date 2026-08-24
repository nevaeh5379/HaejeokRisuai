#include "GroupChatController.hpp"
#include "../core/DatabaseManager.hpp"
#include "../core/AppConfig.hpp"
#include "../engine/PromptEngine.hpp"
#include "../engine/Tokenizer.hpp"
#include <QRandomGenerator>
#include <QUuid>
#include <QDebug>

namespace Risu {

GroupChatController::GroupChatController(QObject* parent) : QObject(parent) {
    connect(&DatabaseManager::instance(), &DatabaseManager::groupsChanged, this, &GroupChatController::refreshGroups);
    refreshGroups();
}

void GroupChatController::refreshGroups() {
    auto groups = DatabaseManager::instance().getAllGroups();
    m_groupModel.setGroups(groups);

    if (!m_activeGroupId.isEmpty()) {
        auto opt = DatabaseManager::instance().getGroup(m_activeGroupId);
        if (opt) {
            m_activeGroup = *opt;
            m_messageModel.setMessages(m_activeGroup.currentChat().messages);
            emit activeGroupChanged();
            emit currentSpeakerChanged();
        }
    }
}

void GroupChatController::selectGroup(const QString& groupId) {
    auto opt = DatabaseManager::instance().getGroup(groupId);
    if (opt) {
        m_activeGroupId = groupId;
        m_activeGroup = *opt;
        m_messageModel.setMessages(m_activeGroup.currentChat().messages);
        emit activeGroupChanged();
        emit currentSpeakerChanged();
    }
}

QVariantMap GroupChatController::activeGroup() const {
    QVariantMap map;
    if (m_activeGroup.id.isEmpty()) return map;

    map[QStringLiteral("id")] = m_activeGroup.id;
    map[QStringLiteral("name")] = m_activeGroup.name;
    map[QStringLiteral("description")] = m_activeGroup.description;
    map[QStringLiteral("avatarPath")] = m_activeGroup.avatarPath;
    map[QStringLiteral("speakerMode")] = speakerModeToString(m_activeGroup.speakerMode);
    map[QStringLiteral("currentSpeakerIndex")] = m_activeGroup.currentSpeakerIndex;
    map[QStringLiteral("memberCount")] = m_activeGroup.members.size();

    QVariantList memList;
    for (const auto& m : m_activeGroup.members) {
        QVariantMap mMap;
        mMap[QStringLiteral("characterId")] = m.characterId;
        mMap[QStringLiteral("name")] = m.name;
        mMap[QStringLiteral("avatarPath")] = m.avatarPath;
        mMap[QStringLiteral("enabled")] = m.enabled;
        memList.append(mMap);
    }
    map[QStringLiteral("members")] = memList;

    return map;
}

QString GroupChatController::currentSpeakerName() const {
    if (m_activeGroup.members.isEmpty()) return QStringLiteral("None");
    int idx = m_activeGroup.currentSpeakerIndex % m_activeGroup.members.size();
    if (idx >= 0 && idx < m_activeGroup.members.size()) {
        return m_activeGroup.members[idx].name;
    }
    return QStringLiteral("None");
}

QString GroupChatController::createGroup(const QString& name, const QString& description) {
    GroupChatRoom g;
    g.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    g.name = name.isEmpty() ? QStringLiteral("New Group Room") : name;
    g.description = description;
    g.lastInteraction = QDateTime::currentMSecsSinceEpoch();

    Chat defChat;
    defChat.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    defChat.name = QStringLiteral("Main Group Chat");
    defChat.lastDate = g.lastInteraction;
    g.chats.append(defChat);

    DatabaseManager::instance().saveGroup(g);
    selectGroup(g.id);

    emit toastRequested(QStringLiteral("success"), QStringLiteral("Group chat created: ") + g.name);
    return g.id;
}

bool GroupChatController::saveGroupDetails(const QVariantMap& data) {
    QString id = data.value(QStringLiteral("id")).toString();
    if (id.isEmpty()) return false;

    auto opt = DatabaseManager::instance().getGroup(id);
    if (!opt) return false;

    GroupChatRoom g = *opt;
    if (data.contains(QStringLiteral("name"))) g.name = data.value(QStringLiteral("name")).toString();
    if (data.contains(QStringLiteral("description"))) g.description = data.value(QStringLiteral("description")).toString();
    if (data.contains(QStringLiteral("avatarPath"))) g.avatarPath = data.value(QStringLiteral("avatarPath")).toString();
    if (data.contains(QStringLiteral("speakerMode"))) g.speakerMode = stringToSpeakerMode(data.value(QStringLiteral("speakerMode")).toString());

    bool ok = DatabaseManager::instance().saveGroup(g);
    if (ok) {
        m_activeGroup = g;
        emit activeGroupChanged();
        emit toastRequested(QStringLiteral("success"), QStringLiteral("Group settings saved."));
    }
    return ok;
}

bool GroupChatController::deleteGroup(const QString& groupId) {
    bool ok = DatabaseManager::instance().deleteGroup(groupId);
    if (ok) {
        if (m_activeGroupId == groupId) {
            m_activeGroupId.clear();
            m_activeGroup = GroupChatRoom();
            m_messageModel.clear();
            emit activeGroupChanged();
        }
        emit toastRequested(QStringLiteral("info"), QStringLiteral("Group chat deleted."));
    }
    return ok;
}

void GroupChatController::addCharacterToGroup(const QString& characterId) {
    auto charOpt = DatabaseManager::instance().getCharacter(characterId);
    if (!charOpt) return;

    for (const auto& m : m_activeGroup.members) {
        if (m.characterId == characterId) {
            emit toastRequested(QStringLiteral("warning"), QStringLiteral("Character is already in this group."));
            return;
        }
    }

    GroupMember mem;
    mem.characterId = charOpt->id;
    mem.name = charOpt->name;
    mem.avatarPath = charOpt->avatarPath;
    mem.enabled = true;
    mem.order = m_activeGroup.members.size();

    m_activeGroup.members.append(mem);
    DatabaseManager::instance().saveGroup(m_activeGroup);

    emit activeGroupChanged();
    emit currentSpeakerChanged();
    emit toastRequested(QStringLiteral("success"), QStringLiteral("Added ") + charOpt->name + QStringLiteral(" to group."));
}

void GroupChatController::removeCharacterFromGroup(const QString& characterId) {
    for (int i = 0; i < m_activeGroup.members.size(); ++i) {
        if (m_activeGroup.members[i].characterId == characterId) {
            m_activeGroup.members.removeAt(i);
            DatabaseManager::instance().saveGroup(m_activeGroup);
            emit activeGroupChanged();
            emit currentSpeakerChanged();
            emit toastRequested(QStringLiteral("info"), QStringLiteral("Removed character from group."));
            return;
        }
    }
}

void GroupChatController::setSpeakerMode(const QString& mode) {
    m_activeGroup.speakerMode = stringToSpeakerMode(mode);
    DatabaseManager::instance().saveGroup(m_activeGroup);
    emit activeGroupChanged();
}

Character GroupChatController::determineNextSpeaker() {
    QList<GroupMember> activeMembers;
    for (const auto& m : m_activeGroup.members) {
        if (m.enabled) activeMembers.append(m);
    }

    if (activeMembers.isEmpty()) return Character();

    GroupMember chosen;
    if (m_activeGroup.speakerMode == SpeakerSelectionMode::Random) {
        int idx = QRandomGenerator::global()->bounded(activeMembers.size());
        chosen = activeMembers[idx];
    } else {
        // Round Robin
        int idx = m_activeGroup.currentSpeakerIndex % activeMembers.size();
        chosen = activeMembers[idx];
        m_activeGroup.currentSpeakerIndex = (idx + 1) % activeMembers.size();
    }

    auto optChar = DatabaseManager::instance().getCharacter(chosen.characterId);
    if (optChar) return *optChar;

    Character fallback;
    fallback.name = chosen.name;
    return fallback;
}

void GroupChatController::sendMessage(const QString& userText) {
    if (userText.trimmed().isEmpty() || m_isGenerating || m_activeGroup.id.isEmpty()) return;

    // 1. Append User Message
    Message userMsg;
    userMsg.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    userMsg.role = Role::User;
    auto personaOpt = DatabaseManager::instance().getActivePersona();
    userMsg.name = personaOpt ? personaOpt->name : QStringLiteral("User");
    userMsg.setCurrentContent(userText);
    userMsg.timestamp = QDateTime::currentMSecsSinceEpoch();

    m_messageModel.appendMessage(userMsg);
    m_activeGroup.currentChat().messages = m_messageModel.messages();

    // 2. Select Next Speaker Character
    m_currentSpeakingChar = determineNextSpeaker();
    if (m_currentSpeakingChar.name.isEmpty()) {
        emit toastRequested(QStringLiteral("warning"), QStringLiteral("No active characters in group to reply."));
        return;
    }

    // 3. Append Assistant Placeholder Message
    Message botMsg;
    botMsg.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    botMsg.role = Role::Assistant;
    botMsg.name = m_currentSpeakingChar.name;
    botMsg.timestamp = QDateTime::currentMSecsSinceEpoch();
    m_messageModel.appendMessage(botMsg);

    m_isGenerating = true;
    emit isGeneratingChanged();
    emit currentSpeakerChanged();

    // 4. Build Prompt with active preset & global lorebooks
    auto presets = DatabaseManager::instance().getAllPresets();
    Preset activePreset = presets.isEmpty() ? Preset() : presets.first();
    Persona activePersona = personaOpt ? *personaOpt : Persona();
    auto globalLore = DatabaseManager::instance().getAllGlobalLorebooks();

    CompiledPrompt compiled = PromptEngine::buildPrompt(
        m_currentSpeakingChar,
        m_activeGroup.currentChat(),
        activePreset,
        activePersona,
        globalLore
    );

    // 5. Send Streaming Request
    m_currentProvider = AIProvider::create(activePreset.provider, this);
    connect(m_currentProvider.get(), &AIProvider::chunkReceived, this, &GroupChatController::onProviderChunkReceived);
    connect(m_currentProvider.get(), &AIProvider::finished, this, &GroupChatController::onProviderFinished);
    connect(m_currentProvider.get(), &AIProvider::errorOccurred, this, &GroupChatController::onProviderError);

    m_currentProvider->sendRequest(compiled, activePreset);
}

void GroupChatController::onProviderChunkReceived(const QString& textChunk, const QString& thoughtChunk) {
    if (!textChunk.isEmpty() || !thoughtChunk.isEmpty()) {
        m_messageModel.updateLastMessageChunk(textChunk, thoughtChunk);
    }
}

void GroupChatController::onProviderFinished(const QString& fullResponse, const QString& thought, int inTok, int outTok) {
    m_messageModel.finalizeLastMessage(fullResponse, thought, inTok, outTok);
    m_activeGroup.currentChat().messages = m_messageModel.messages();
    m_activeGroup.lastInteraction = QDateTime::currentMSecsSinceEpoch();

    saveCurrentGroupChat();

    m_isGenerating = false;
    emit isGeneratingChanged();
}

void GroupChatController::onProviderError(const QString& errorMessage) {
    m_isGenerating = false;
    emit isGeneratingChanged();
    emit toastRequested(QStringLiteral("error"), errorMessage);
}

void GroupChatController::cancelGeneration() {
    if (m_currentProvider) {
        m_currentProvider->cancel();
    }
    m_isGenerating = false;
    emit isGeneratingChanged();
}

void GroupChatController::saveCurrentGroupChat() {
    DatabaseManager::instance().saveGroup(m_activeGroup);
}

} // namespace Risu
