#pragma once

#include <QObject>
#include <QString>
#include <QStringList>
#include <QColor>
#include <QStandardPaths>
#include <QDir>
#include <QSettings>

namespace Risu {

class AppConfig : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString appDataDir READ appDataDir CONSTANT)
    Q_PROPERTY(QString avatarsDir READ avatarsDir CONSTANT)
    Q_PROPERTY(QString assetsDir READ assetsDir CONSTANT)
    Q_PROPERTY(QString coldStorageDir READ coldStorageDir CONSTANT)
    Q_PROPERTY(QString theme READ theme WRITE setTheme NOTIFY themeChanged)
    Q_PROPERTY(int fontSize READ fontSize WRITE setFontSize NOTIFY fontSizeChanged)
    Q_PROPERTY(bool autoScroll READ autoScroll WRITE setAutoScroll NOTIFY autoScrollChanged)
    Q_PROPERTY(bool streamDisplay READ streamDisplay WRITE setStreamDisplay NOTIFY streamDisplayChanged)
    Q_PROPERTY(bool soundEffects READ soundEffects WRITE setSoundEffects NOTIFY soundEffectsChanged)
    Q_PROPERTY(QString selectedCharacterId READ selectedCharacterId WRITE setSelectedCharacterId NOTIFY selectedCharacterIdChanged)
    Q_PROPERTY(QString selectedPresetId READ selectedPresetId WRITE setSelectedPresetId NOTIFY selectedPresetIdChanged)
    Q_PROPERTY(QString selectedPersonaId READ selectedPersonaId WRITE setSelectedPersonaId NOTIFY selectedPersonaIdChanged)
    Q_PROPERTY(QString language READ language WRITE setLanguage NOTIFY languageChanged)

    // Database Configuration Properties
    Q_PROPERTY(QString dbDriver READ dbDriver WRITE setDbDriver NOTIFY dbConfigChanged)
    Q_PROPERTY(QString dbHost READ dbHost WRITE setDbHost NOTIFY dbConfigChanged)
    Q_PROPERTY(int dbPort READ dbPort WRITE setDbPort NOTIFY dbConfigChanged)
    Q_PROPERTY(QString dbName READ dbName WRITE setDbName NOTIFY dbConfigChanged)
    Q_PROPERTY(QString dbUser READ dbUser WRITE setDbUser NOTIFY dbConfigChanged)
    Q_PROPERTY(QString dbPassword READ dbPassword WRITE setDbPassword NOTIFY dbConfigChanged)
    Q_PROPERTY(QString dbOptions READ dbOptions WRITE setDbOptions NOTIFY dbConfigChanged)
    Q_PROPERTY(QString dbUrl READ dbUrl WRITE setDbUrl NOTIFY dbConfigChanged)
    Q_PROPERTY(QString activeDbDriver READ activeDbDriver NOTIFY dbConnectionStatusChanged)
    Q_PROPERTY(bool isDbConnected READ isDbConnected NOTIFY dbConnectionStatusChanged)
    Q_PROPERTY(QString schemaLayout READ schemaLayout CONSTANT)
    Q_PROPERTY(int schemaVersion READ schemaVersion NOTIFY dbConnectionStatusChanged)

public:
    static AppConfig& instance();

    QString appDataDir() const;
    QString avatarsDir() const;
    QString assetsDir() const;
    QString coldStorageDir() const;
    QString databasePath() const;
    QString backupsDir() const;

    Q_INVOKABLE QString resolveAssetPath(const QString& assetRef) const;
    Q_INVOKABLE QString resolveAssetUrl(const QString& assetRef) const;

    QString theme() const { return m_theme; }
    void setTheme(const QString& theme);

    int fontSize() const { return m_fontSize; }
    void setFontSize(int size);

    bool autoScroll() const { return m_autoScroll; }
    void setAutoScroll(bool autoScroll);

    bool streamDisplay() const { return m_streamDisplay; }
    void setStreamDisplay(bool stream);

    bool soundEffects() const { return m_soundEffects; }
    void setSoundEffects(bool sound);

    QString selectedCharacterId() const { return m_selectedCharacterId; }
    void setSelectedCharacterId(const QString& id);

    QString selectedPresetId() const { return m_selectedPresetId; }
    void setSelectedPresetId(const QString& id);

    QString selectedPersonaId() const { return m_selectedPersonaId; }
    void setSelectedPersonaId(const QString& id);

    QString language() const { return m_language; }
    void setLanguage(const QString& lang);

    // Database Configuration Getters / Setters
    QString dbDriver() const { return m_dbDriver; }
    void setDbDriver(const QString& driver);

    QString dbHost() const { return m_dbHost; }
    void setDbHost(const QString& host);

    int dbPort() const { return m_dbPort; }
    void setDbPort(int port);

    QString dbName() const { return m_dbName; }
    void setDbName(const QString& name);

    QString dbUser() const { return m_dbUser; }
    void setDbUser(const QString& user);

    QString dbPassword() const { return m_dbPassword; }
    void setDbPassword(const QString& password);

    QString dbOptions() const { return m_dbOptions; }
    void setDbOptions(const QString& options);

    QString dbUrl() const;
    void setDbUrl(const QString& url);

    QString activeDbDriver() const;
    bool isDbConnected() const;
    QString schemaLayout() const { return QStringLiteral("relational-schema-v3"); }
    int schemaVersion() const;

    Q_INVOKABLE bool testDbConnection(const QString& driver, const QString& host, int port, const QString& name, const QString& user, const QString& pass, const QString& options);
    Q_INVOKABLE bool applyDbConnection(const QString& driver, const QString& host, int port, const QString& name, const QString& user, const QString& pass, const QString& options);
    Q_INVOKABLE QStringList availableDbDrivers() const;

    void save();
    void load();

signals:
    void themeChanged(const QString& theme);
    void fontSizeChanged(int size);
    void autoScrollChanged(bool autoScroll);
    void streamDisplayChanged(bool stream);
    void soundEffectsChanged(bool sound);
    void selectedCharacterIdChanged(const QString& id);
    void selectedPresetIdChanged(const QString& id);
    void selectedPersonaIdChanged(const QString& id);
    void languageChanged(const QString& lang);
    void dbConfigChanged();
    void dbConnectionStatusChanged();

private:
    explicit AppConfig(QObject* parent = nullptr);

    QString m_theme = QStringLiteral("dark");
    int m_fontSize = 15;
    bool m_autoScroll = true;
    bool m_streamDisplay = true;
    bool m_soundEffects = false;
    QString m_selectedCharacterId;
    QString m_selectedPresetId;
    QString m_selectedPersonaId;
    QString m_language = QStringLiteral("ko");

    // Database settings
    QString m_dbDriver = QStringLiteral("QSQLITE");
    QString m_dbHost = QStringLiteral("localhost");
    int m_dbPort = 0;
    QString m_dbName;
    QString m_dbUser;
    QString m_dbPassword;
    QString m_dbOptions;
};

} // namespace Risu
