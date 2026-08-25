#include "AppConfig.hpp"
#include "DatabaseManager.hpp"
#include <QCoreApplication>
#include <QFileInfo>
#include <QUrl>

namespace Risu {

AppConfig& AppConfig::instance() {
    static AppConfig s_instance;
    return s_instance;
}

AppConfig::AppConfig(QObject* parent) : QObject(parent) {
    // Ensure all data directories exist
    QDir().mkpath(appDataDir());
    QDir().mkpath(avatarsDir());
    QDir().mkpath(assetsDir());
    QDir().mkpath(coldStorageDir());
    QDir().mkpath(backupsDir());

    load();
}

QString AppConfig::appDataDir() const {
    QString path = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
    if (path.isEmpty()) {
        path = QDir::homePath() + QStringLiteral("/.risuai-qt");
    }
    return path;
}

QString AppConfig::avatarsDir() const {
    return appDataDir() + QStringLiteral("/avatars");
}

QString AppConfig::assetsDir() const {
    return appDataDir() + QStringLiteral("/assets");
}

QString AppConfig::coldStorageDir() const {
    return appDataDir() + QStringLiteral("/coldstorage");
}

QString AppConfig::databasePath() const {
    if (!m_dbName.isEmpty() && m_dbDriver == QStringLiteral("QSQLITE")) {
        return m_dbName;
    }
    return appDataDir() + QStringLiteral("/risuai.db");
}

QString AppConfig::backupsDir() const {
    return appDataDir() + QStringLiteral("/backups");
}

QString AppConfig::resolveAssetPath(const QString& assetRef) const {
    if (assetRef.isEmpty()) return QString();

    // If it's already an absolute file path that exists
    if (QFileInfo::exists(assetRef)) {
        return assetRef;
    }

    // Strip "assets/" prefix if present
    QString cleanKey = assetRef;
    if (cleanKey.startsWith(QStringLiteral("assets/"))) {
        cleanKey = cleanKey.mid(7);
    } else if (cleanKey.startsWith(QStringLiteral("assets\\"))) {
        cleanKey = cleanKey.mid(7);
    }

    // 1. Check assets directory
    QString inAssets = assetsDir() + QStringLiteral("/") + cleanKey;
    if (QFileInfo::exists(inAssets)) {
        return inAssets;
    }

    // 2. Check avatars directory
    QString inAvatars = avatarsDir() + QStringLiteral("/") + cleanKey;
    if (QFileInfo::exists(inAvatars)) {
        return inAvatars;
    }

    // 3. Fallback: Check if file with png extension exists
    if (!cleanKey.endsWith(QStringLiteral(".png"), Qt::CaseInsensitive)) {
        QString inAssetsPng = inAssets + QStringLiteral(".png");
        if (QFileInfo::exists(inAssetsPng)) {
            return inAssetsPng;
        }
    }

    return inAssets; // Return calculated default path even if not yet on disk
}

QString AppConfig::resolveAssetUrl(const QString& assetRef) const {
    QString path = resolveAssetPath(assetRef);
    if (path.isEmpty()) return QString();
    if (QFileInfo::exists(path)) {
        return QUrl::fromLocalFile(QFileInfo(path).absoluteFilePath()).toString();
    }
    return QString();
}

void AppConfig::setTheme(const QString& theme) {
    if (m_theme != theme) {
        m_theme = theme;
        emit themeChanged(m_theme);
        save();
    }
}

void AppConfig::setFontSize(int size) {
    if (m_fontSize != size && size >= 10 && size <= 32) {
        m_fontSize = size;
        emit fontSizeChanged(m_fontSize);
        save();
    }
}

void AppConfig::setAutoScroll(bool autoScroll) {
    if (m_autoScroll != autoScroll) {
        m_autoScroll = autoScroll;
        emit autoScrollChanged(m_autoScroll);
        save();
    }
}

void AppConfig::setStreamDisplay(bool stream) {
    if (m_streamDisplay != stream) {
        m_streamDisplay = stream;
        emit streamDisplayChanged(m_streamDisplay);
        save();
    }
}

void AppConfig::setSoundEffects(bool sound) {
    if (m_soundEffects != sound) {
        m_soundEffects = sound;
        emit soundEffectsChanged(m_soundEffects);
        save();
    }
}

void AppConfig::setRenderMessageHtml(bool enabled) {
    if (m_renderMessageHtml != enabled) {
        m_renderMessageHtml = enabled;
        emit renderMessageHtmlChanged(m_renderMessageHtml);
        save();
    }
}

void AppConfig::setSelectedCharacterId(const QString& id) {
    if (m_selectedCharacterId != id) {
        m_selectedCharacterId = id;
        emit selectedCharacterIdChanged(m_selectedCharacterId);
        save();
    }
}

void AppConfig::setSelectedPresetId(const QString& id) {
    if (m_selectedPresetId != id) {
        m_selectedPresetId = id;
        emit selectedPresetIdChanged(m_selectedPresetId);
        save();
    }
}

void AppConfig::setSelectedPersonaId(const QString& id) {
    if (m_selectedPersonaId != id) {
        m_selectedPersonaId = id;
        emit selectedPersonaIdChanged(m_selectedPersonaId);
        save();
    }
}

void AppConfig::setLanguage(const QString& lang) {
    if (m_language != lang) {
        m_language = lang;
        emit languageChanged(m_language);
        save();
    }
}

void AppConfig::setDbDriver(const QString& driver) {
    if (m_dbDriver != driver) {
        m_dbDriver = driver;
        emit dbConfigChanged();
        save();
    }
}

void AppConfig::setDbHost(const QString& host) {
    if (m_dbHost != host) {
        m_dbHost = host;
        emit dbConfigChanged();
        save();
    }
}

void AppConfig::setDbPort(int port) {
    if (m_dbPort != port) {
        m_dbPort = port;
        emit dbConfigChanged();
        save();
    }
}

void AppConfig::setDbName(const QString& name) {
    if (m_dbName != name) {
        m_dbName = name;
        emit dbConfigChanged();
        save();
    }
}

void AppConfig::setDbUser(const QString& user) {
    if (m_dbUser != user) {
        m_dbUser = user;
        emit dbConfigChanged();
        save();
    }
}

void AppConfig::setDbPassword(const QString& password) {
    if (m_dbPassword != password) {
        m_dbPassword = password;
        emit dbConfigChanged();
        save();
    }
}

void AppConfig::setDbOptions(const QString& options) {
    if (m_dbOptions != options) {
        m_dbOptions = options;
        emit dbConfigChanged();
        save();
    }
}

QString AppConfig::dbUrl() const {
    DatabaseConfig cfg;
    cfg.driver = m_dbDriver;
    cfg.host = m_dbHost;
    cfg.port = m_dbPort;
    cfg.databaseName = m_dbName.isEmpty() ? databasePath() : m_dbName;
    cfg.userName = m_dbUser;
    cfg.password = m_dbPassword;
    return cfg.toUrl();
}

void AppConfig::setDbUrl(const QString& url) {
    DatabaseConfig cfg = DatabaseConfig::fromUrl(url);
    m_dbDriver = cfg.driver;
    m_dbHost = cfg.host;
    m_dbPort = cfg.port;
    m_dbName = cfg.databaseName;
    m_dbUser = cfg.userName;
    m_dbPassword = cfg.password;
    emit dbConfigChanged();
    save();
}

QString AppConfig::activeDbDriver() const {
    return DatabaseManager::instance().currentConfig().driver;
}

bool AppConfig::isDbConnected() const {
    return DatabaseManager::instance().isConnected();
}

int AppConfig::schemaVersion() const {
    return DatabaseManager::instance().currentSchemaVersion();
}

bool AppConfig::testDbConnection(const QString& driver, const QString& host, int port, const QString& name, const QString& user, const QString& pass, const QString& options) {
    DatabaseConfig cfg;
    cfg.driver = driver;
    cfg.host = host;
    cfg.port = port;
    cfg.databaseName = name;
    cfg.userName = user;
    cfg.password = pass;
    cfg.connectionOptions = options;
    return DatabaseManager::instance().testConnection(cfg);
}

bool AppConfig::applyDbConnection(const QString& driver, const QString& host, int port, const QString& name, const QString& user, const QString& pass, const QString& options) {
    DatabaseConfig cfg;
    cfg.driver = driver;
    cfg.host = host;
    cfg.port = port;
    cfg.databaseName = name;
    cfg.userName = user;
    cfg.password = pass;
    cfg.connectionOptions = options;

    bool ok = DatabaseManager::instance().connectDatabase(cfg);
    if (ok) {
        m_dbDriver = driver;
        m_dbHost = host;
        m_dbPort = port;
        m_dbName = name;
        m_dbUser = user;
        m_dbPassword = pass;
        m_dbOptions = options;
        emit dbConfigChanged();
        emit dbConnectionStatusChanged();
        save();
    }
    return ok;
}

QStringList AppConfig::availableDbDrivers() const {
    return DatabaseManager::instance().availableDrivers();
}

void AppConfig::save() {
    QSettings settings(appDataDir() + QStringLiteral("/config.ini"), QSettings::IniFormat);
    settings.setValue(QStringLiteral("theme"), m_theme);
    settings.setValue(QStringLiteral("fontSize"), m_fontSize);
    settings.setValue(QStringLiteral("autoScroll"), m_autoScroll);
    settings.setValue(QStringLiteral("streamDisplay"), m_streamDisplay);
    settings.setValue(QStringLiteral("soundEffects"), m_soundEffects);
    settings.setValue(QStringLiteral("renderMessageHtml"), m_renderMessageHtml);
    settings.setValue(QStringLiteral("selectedCharacterId"), m_selectedCharacterId);
    settings.setValue(QStringLiteral("selectedPresetId"), m_selectedPresetId);
    settings.setValue(QStringLiteral("selectedPersonaId"), m_selectedPersonaId);
    settings.setValue(QStringLiteral("language"), m_language);

    // Database
    settings.setValue(QStringLiteral("dbDriver"), m_dbDriver);
    settings.setValue(QStringLiteral("dbHost"), m_dbHost);
    settings.setValue(QStringLiteral("dbPort"), m_dbPort);
    settings.setValue(QStringLiteral("dbName"), m_dbName);
    settings.setValue(QStringLiteral("dbUser"), m_dbUser);
    settings.setValue(QStringLiteral("dbPassword"), m_dbPassword);
    settings.setValue(QStringLiteral("dbOptions"), m_dbOptions);
}

void AppConfig::load() {
    QSettings settings(appDataDir() + QStringLiteral("/config.ini"), QSettings::IniFormat);
    m_theme = settings.value(QStringLiteral("theme"), QStringLiteral("dark")).toString();
    m_fontSize = settings.value(QStringLiteral("fontSize"), 15).toInt();
    m_autoScroll = settings.value(QStringLiteral("autoScroll"), true).toBool();
    m_streamDisplay = settings.value(QStringLiteral("streamDisplay"), true).toBool();
    m_soundEffects = settings.value(QStringLiteral("soundEffects"), false).toBool();
    m_renderMessageHtml = settings.value(QStringLiteral("renderMessageHtml"), true).toBool();
    m_selectedCharacterId = settings.value(QStringLiteral("selectedCharacterId"), QString()).toString();
    m_selectedPresetId = settings.value(QStringLiteral("selectedPresetId"), QString()).toString();
    m_selectedPersonaId = settings.value(QStringLiteral("selectedPersonaId"), QString()).toString();
    m_language = settings.value(QStringLiteral("language"), QStringLiteral("ko")).toString();

    // Database
    m_dbDriver = settings.value(QStringLiteral("dbDriver"), QStringLiteral("QSQLITE")).toString();
    m_dbHost = settings.value(QStringLiteral("dbHost"), QStringLiteral("localhost")).toString();
    m_dbPort = settings.value(QStringLiteral("dbPort"), 0).toInt();
    m_dbName = settings.value(QStringLiteral("dbName"), QString()).toString();
    m_dbUser = settings.value(QStringLiteral("dbUser"), QString()).toString();
    m_dbPassword = settings.value(QStringLiteral("dbPassword"), QString()).toString();
    m_dbOptions = settings.value(QStringLiteral("dbOptions"), QString()).toString();
}

} // namespace Risu
