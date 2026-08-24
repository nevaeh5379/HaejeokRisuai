#pragma once

#include <QObject>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QSqlError>
#include <QList>
#include "Types.hpp"

namespace Risu {

class DatabaseManager : public QObject {
    Q_OBJECT

public:
    static DatabaseManager& instance();

    bool initDatabase();
    void closeDatabase();

    // Characters CRUD
    QList<Character> getAllCharacters();
    bool saveCharacter(const Character& character);
    bool deleteCharacter(const QString& characterId);
    std::optional<Character> getCharacter(const QString& characterId);

    // Chats & Messages
    QList<Chat> getChatsForCharacter(const QString& characterId);
    bool saveChat(const QString& characterId, const Chat& chat);
    bool deleteChat(const QString& chatId);

    QList<Message> getMessagesForChat(const QString& chatId);
    bool saveMessages(const QString& chatId, const QList<Message>& messages);
    bool addMessage(const QString& chatId, const Message& message, int order);
    bool updateMessage(const QString& chatId, const Message& message);
    bool deleteMessage(const QString& messageId);

    // Presets CRUD
    QList<Preset> getAllPresets();
    bool savePreset(const Preset& preset);
    bool deletePreset(const QString& presetId);
    std::optional<Preset> getPreset(const QString& presetId);

    // Personas CRUD
    QList<Persona> getAllPersonas();
    bool savePersona(const Persona& persona);
    bool deletePersona(const QString& personaId);
    std::optional<Persona> getActivePersona();
    bool setActivePersona(const QString& personaId);

    // Global Lorebooks CRUD
    QList<LorebookEntry> getAllGlobalLorebooks();
    bool saveGlobalLorebook(const LorebookEntry& entry);
    bool deleteGlobalLorebook(const QString& entryId);

    // Group Chat Rooms CRUD
    QList<GroupChatRoom> getAllGroups();
    bool saveGroup(const GroupChatRoom& group);
    bool deleteGroup(const QString& groupId);
    std::optional<GroupChatRoom> getGroup(const QString& groupId);

    // Full export / import
    QJsonObject exportFullDatabase();
    bool importFullDatabase(const QJsonObject& rootObj);

signals:
    void charactersChanged();
    void presetsChanged();
    void personasChanged();
    void lorebooksChanged();
    void groupsChanged();
    void errorOccurred(const QString& message);

private:
    explicit DatabaseManager(QObject* parent = nullptr);
    ~DatabaseManager();

    void createDefaultDataIfEmpty();
    QSqlDatabase m_db;
};

} // namespace Risu
