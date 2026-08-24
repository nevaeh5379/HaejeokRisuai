#pragma once

#include <QObject>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QSqlError>
#include <QList>
#include <QString>
#include <QUrl>
#include <optional>
#include "Types.hpp"

namespace Risu {

enum class DatabaseDialect {
    SQLite,
    PostgreSQL,
    Oracle,
    MySQL
};

struct DatabaseConfig {
    QString driver = QStringLiteral("QSQLITE"); // "QSQLITE", "QPSQL", "QODBC", "QOCI", "QMYSQL"
    QString host = QStringLiteral("localhost");
    int port = 0; // 0 = default for driver (5432 for Postgres, 1521 for Oracle, 3306 for MySQL)
    QString databaseName; // path for SQLite, db name for Postgres/MySQL, SID/service name for Oracle
    QString userName;
    QString password;
    QString connectionOptions;
    QString schema = QStringLiteral("public");

    static DatabaseConfig fromUrl(const QString& urlStr);
    QString toUrl() const;
    DatabaseDialect dialect() const;
};

class DatabaseManager : public QObject {
    Q_OBJECT

public:
    static DatabaseManager& instance();

    // Database Initialization & Connection
    bool initDatabase();
    bool connectDatabase(const DatabaseConfig& config);
    bool testConnection(const DatabaseConfig& config, QString* errorMessage = nullptr);
    void closeDatabase();

    DatabaseConfig currentConfig() const { return m_config; }
    DatabaseDialect currentDialect() const { return m_dialect; }
    QString currentSchemaLayout() const { return QStringLiteral("relational-schema-v3"); }
    int currentSchemaVersion() const;
    bool isRelationalV3() const { return true; }
    bool isConnected() const;
    QStringList availableDrivers() const;

    // Characters CRUD (Normalized relational-schema-v3)
    QList<Character> getAllCharacters();
    bool saveCharacter(const Character& character);
    bool deleteCharacter(const QString& characterId);
    std::optional<Character> getCharacter(const QString& characterId);

    // Chats & Messages (Normalized relational-schema-v3)
    QList<Chat> getChatsForCharacter(const QString& characterId);
    bool saveChat(const QString& characterId, const Chat& chat);
    bool deleteChat(const QString& chatId);

    QList<Message> getMessagesForChat(const QString& chatId);
    bool saveMessages(const QString& chatId, const QList<Message>& messages);
    bool addMessage(const QString& chatId, const Message& message, int order = -1);
    bool updateMessage(const QString& chatId, const Message& message);
    bool deleteMessage(const QString& messageId);

    // Presets CRUD
    QList<Preset> getAllPresets();
    bool savePreset(const Preset& preset);
    bool deletePreset(const QString& presetId);
    std::optional<Preset> getPreset(const QString& presetId);

    // Personas CRUD
    QList<Persona> getAllPersonas();
    std::optional<Persona> getPersona(const QString& personaId);
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

    // System Settings & Plugin Storage
    bool setSystemSetting(const QString& key, const QVariant& value, const QString& domain = QStringLiteral("general"));
    QVariant getSystemSetting(const QString& key, const QVariant& defaultValue = QVariant());
    bool setPluginCustomStorage(const QString& key, const QJsonObject& value);
    QJsonObject getPluginCustomStorage(const QString& key);

    // Full export / import with relational-schema-v3 metadata
    QJsonObject exportFullDatabase();
    bool importFullDatabase(const QJsonObject& rootObj);

signals:
    void databaseConnected(const QString& driver, const QString& databaseName);
    void databaseDisconnected();
    void charactersChanged();
    void presetsChanged();
    void personasChanged();
    void lorebooksChanged();
    void groupsChanged();
    void errorOccurred(const QString& message);

private:
    explicit DatabaseManager(QObject* parent = nullptr);
    ~DatabaseManager();

    bool setupSchemaV3();
    bool setupSchemaSQLite();
    bool setupSchemaPostgres();
    bool setupSchemaOracle();
    bool setupSchemaGeneric();
    void createDefaultDataIfEmpty();
    void migrateLegacyDataIfPresent();

    bool executeSql(const QString& sql, const QVariantList& params = {});

    QSqlDatabase m_db;
    DatabaseConfig m_config;
    DatabaseDialect m_dialect = DatabaseDialect::SQLite;
};

} // namespace Risu
