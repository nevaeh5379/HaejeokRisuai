#include "CharacterController.hpp"
#include "../core/DatabaseManager.hpp"
#include "../core/AppConfig.hpp"
#include "../storage/CharacterCardIO.hpp"
#include <QFile>
#include <QFileInfo>
#include <QDir>
#include <QDebug>

namespace Risu {

CharacterController::CharacterController(QObject* parent) : QObject(parent) {
    connect(&DatabaseManager::instance(), &DatabaseManager::charactersChanged, this, &CharacterController::refreshCharacters);
    refreshCharacters();

    QString selId = AppConfig::instance().selectedCharacterId();
    if (!selId.isEmpty()) {
        selectCharacter(selId);
    }
}

void CharacterController::refreshCharacters() {
    auto chars = DatabaseManager::instance().getAllCharacters();
    m_charModel.setCharacters(chars);
    emit characterCountChanged();

    if (!m_selectedCharId.isEmpty()) {
        auto opt = DatabaseManager::instance().getCharacter(m_selectedCharId);
        if (opt) {
            m_selectedChar = *opt;
            emit selectedCharacterChanged();
        }
    }
}

void CharacterController::selectCharacter(const QString& characterId) {
    auto opt = DatabaseManager::instance().getCharacter(characterId);
    if (opt) {
        m_selectedCharId = characterId;
        m_selectedChar = *opt;
        AppConfig::instance().setSelectedCharacterId(characterId);
        emit selectedCharacterChanged();
    }
}

void CharacterController::clearSelection() {
    m_selectedCharId.clear();
    m_selectedChar = Character();
    AppConfig::instance().setSelectedCharacterId(QString());
    emit selectedCharacterChanged();
}

QVariantMap CharacterController::selectedCharacter() const {
    QVariantMap map;
    if (m_selectedChar.id.isEmpty()) return map;

    map[QStringLiteral("id")] = m_selectedChar.id;
    map[QStringLiteral("name")] = m_selectedChar.name;
    QString resolvedAvatar = AppConfig::instance().resolveAssetPath(m_selectedChar.avatarPath);
    map[QStringLiteral("avatarPath")] = resolvedAvatar.isEmpty() ? m_selectedChar.avatarPath : resolvedAvatar;
    map[QStringLiteral("firstMessage")] = m_selectedChar.firstMessage;
    map[QStringLiteral("description")] = m_selectedChar.description;
    map[QStringLiteral("personality")] = m_selectedChar.personality;
    map[QStringLiteral("scenario")] = m_selectedChar.scenario;
    map[QStringLiteral("exampleMessage")] = m_selectedChar.exampleMessage;
    map[QStringLiteral("creatorNotes")] = m_selectedChar.creatorNotes;
    map[QStringLiteral("systemPrompt")] = m_selectedChar.systemPrompt;
    map[QStringLiteral("postHistoryInstructions")] = m_selectedChar.postHistoryInstructions;
    map[QStringLiteral("creator")] = m_selectedChar.creator;
    map[QStringLiteral("characterVersion")] = m_selectedChar.characterVersion;
    map[QStringLiteral("authorNote")] = m_selectedChar.authorNote;
    map[QStringLiteral("authorNoteDepth")] = m_selectedChar.authorNoteDepth;
    map[QStringLiteral("alternateGreetings")] = m_selectedChar.alternateGreetings;
    map[QStringLiteral("tags")] = m_selectedChar.tags.join(QStringLiteral(", "));
    map[QStringLiteral("backgroundHTML")] = m_selectedChar.backgroundHTML;
    map[QStringLiteral("backgroundCSS")] = m_selectedChar.backgroundCSS;
    map[QStringLiteral("largePortrait")] = m_selectedChar.largePortrait;

    QVariantMap emoMap;
    for (auto it = m_selectedChar.emotionSprites.constBegin(); it != m_selectedChar.emotionSprites.constEnd(); ++it) {
        emoMap[it.key()] = it.value();
    }
    map[QStringLiteral("emotionSprites")] = emoMap;

    return map;
}

QString CharacterController::createNewCharacter(const QString& name) {
    Character c;
    c.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    c.name = name.isEmpty() ? QStringLiteral("New Character") : name;
    c.firstMessage = QStringLiteral("Hello! Let's start a conversation.");
    c.lastInteraction = QDateTime::currentMSecsSinceEpoch();

    Chat defChat;
    defChat.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    defChat.name = QStringLiteral("Main Chat");
    defChat.firstMessageIndex = 0;
    defChat.lastDate = c.lastInteraction;

    Message m;
    m.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    m.role = Role::Assistant;
    m.name = c.name;
    m.setCurrentContent(c.firstMessage);
    m.timestamp = c.lastInteraction;
    defChat.messages.append(m);
    c.chats.append(defChat);

    DatabaseManager::instance().saveCharacter(c);
    selectCharacter(c.id);

    emit toastRequested(QStringLiteral("success"), QStringLiteral("Character created: ") + c.name);
    return c.id;
}

bool CharacterController::saveCharacterDetails(const QVariantMap& data) {
    QString id = data.value(QStringLiteral("id")).toString();
    if (id.isEmpty()) return false;

    auto opt = DatabaseManager::instance().getCharacter(id);
    if (!opt) return false;

    Character c = *opt;
    if (data.contains(QStringLiteral("name"))) c.name = data.value(QStringLiteral("name")).toString();
    if (data.contains(QStringLiteral("avatarPath"))) c.avatarPath = data.value(QStringLiteral("avatarPath")).toString();
    if (data.contains(QStringLiteral("firstMessage"))) c.firstMessage = data.value(QStringLiteral("firstMessage")).toString();
    if (data.contains(QStringLiteral("description"))) c.description = data.value(QStringLiteral("description")).toString();
    if (data.contains(QStringLiteral("personality"))) c.personality = data.value(QStringLiteral("personality")).toString();
    if (data.contains(QStringLiteral("scenario"))) c.scenario = data.value(QStringLiteral("scenario")).toString();
    if (data.contains(QStringLiteral("exampleMessage"))) c.exampleMessage = data.value(QStringLiteral("exampleMessage")).toString();
    if (data.contains(QStringLiteral("creatorNotes"))) c.creatorNotes = data.value(QStringLiteral("creatorNotes")).toString();
    if (data.contains(QStringLiteral("systemPrompt"))) c.systemPrompt = data.value(QStringLiteral("systemPrompt")).toString();
    if (data.contains(QStringLiteral("postHistoryInstructions"))) c.postHistoryInstructions = data.value(QStringLiteral("postHistoryInstructions")).toString();
    if (data.contains(QStringLiteral("creator"))) c.creator = data.value(QStringLiteral("creator")).toString();
    if (data.contains(QStringLiteral("characterVersion"))) c.characterVersion = data.value(QStringLiteral("characterVersion")).toString();
    if (data.contains(QStringLiteral("authorNote"))) c.authorNote = data.value(QStringLiteral("authorNote")).toString();
    if (data.contains(QStringLiteral("authorNoteDepth"))) c.authorNoteDepth = data.value(QStringLiteral("authorNoteDepth")).toInt();

    if (data.contains(QStringLiteral("tags"))) {
        QString tagStr = data.value(QStringLiteral("tags")).toString();
        c.tags = tagStr.split(QLatin1Char(','), Qt::SkipEmptyParts);
        for (auto& t : c.tags) t = t.trimmed();
    }

    if (data.contains(QStringLiteral("alternateGreetings"))) {
        c.alternateGreetings = data.value(QStringLiteral("alternateGreetings")).toStringList();
    }

    if (data.contains(QStringLiteral("emotionSprites"))) {
        QVariantMap emoMap = data.value(QStringLiteral("emotionSprites")).toMap();
        c.emotionSprites.clear();
        for (auto it = emoMap.constBegin(); it != emoMap.constEnd(); ++it) {
            c.emotionSprites[it.key()] = it.value().toString();
        }
    }

    bool ok = DatabaseManager::instance().saveCharacter(c);
    if (ok) {
        m_selectedChar = c;
        emit selectedCharacterChanged();
        emit toastRequested(QStringLiteral("success"), QStringLiteral("Character saved successfully."));
    }
    return ok;
}

bool CharacterController::deleteCharacter(const QString& characterId) {
    bool ok = DatabaseManager::instance().deleteCharacter(characterId);
    if (ok) {
        if (m_selectedCharId == characterId) {
            auto all = DatabaseManager::instance().getAllCharacters();
            if (!all.isEmpty()) {
                selectCharacter(all.first().id);
            } else {
                m_selectedCharId.clear();
                m_selectedChar = Character();
                emit selectedCharacterChanged();
            }
        }
        emit toastRequested(QStringLiteral("info"), QStringLiteral("Character deleted."));
    }
    return ok;
}

bool CharacterController::importCardFromFile(const QString& filePath) {
    auto optChar = CharacterCardIO::importFromFile(filePath);
    if (!optChar) {
        emit toastRequested(QStringLiteral("error"), QStringLiteral("Failed to import character card from file."));
        return false;
    }

    Character c = *optChar;
    DatabaseManager::instance().saveCharacter(c);
    selectCharacter(c.id);

    emit toastRequested(QStringLiteral("success"), QStringLiteral("Imported character: ") + c.name);
    return true;
}

bool CharacterController::exportCardToPng(const QString& characterId, const QString& targetFilePath) {
    auto opt = DatabaseManager::instance().getCharacter(characterId);
    if (!opt) return false;

    bool ok = CharacterCardIO::exportToPngCard(*opt, targetFilePath);
    if (ok) {
        emit toastRequested(QStringLiteral("success"), QStringLiteral("Exported character card (PNG)"));
    } else {
        emit toastRequested(QStringLiteral("error"), QStringLiteral("Failed to export PNG card."));
    }
    return ok;
}

bool CharacterController::exportCardToJson(const QString& characterId, const QString& targetFilePath) {
    auto opt = DatabaseManager::instance().getCharacter(characterId);
    if (!opt) return false;

    bool ok = CharacterCardIO::exportToJsonFile(*opt, targetFilePath);
    if (ok) {
        emit toastRequested(QStringLiteral("success"), QStringLiteral("Exported character card (JSON)"));
    } else {
        emit toastRequested(QStringLiteral("error"), QStringLiteral("Failed to export JSON card."));
    }
    return ok;
}

void CharacterController::setAvatarImage(const QString& characterId, const QString& sourceImagePath) {
    auto opt = DatabaseManager::instance().getCharacter(characterId);
    if (!opt) return;

    Character c = *opt;
    QString ext = QFileInfo(sourceImagePath).suffix();
    if (ext.isEmpty()) ext = QStringLiteral("png");

    QString destPath = AppConfig::instance().avatarsDir() + QStringLiteral("/") + c.id + QStringLiteral(".") + ext;
    QFile::remove(destPath);
    if (QFile::copy(sourceImagePath, destPath)) {
        c.avatarPath = destPath;
        DatabaseManager::instance().saveCharacter(c);
        if (m_selectedCharId == characterId) {
            m_selectedChar.avatarPath = destPath;
            emit selectedCharacterChanged();
        }
        emit toastRequested(QStringLiteral("success"), QStringLiteral("Avatar updated."));
    }
}

} // namespace Risu
