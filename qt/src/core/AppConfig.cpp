#include "AppConfig.hpp"
#include <QCoreApplication>

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
        return QStringLiteral("file://") + path;
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

void AppConfig::save() {
    QSettings settings(appDataDir() + QStringLiteral("/config.ini"), QSettings::IniFormat);
    settings.setValue(QStringLiteral("theme"), m_theme);
    settings.setValue(QStringLiteral("fontSize"), m_fontSize);
    settings.setValue(QStringLiteral("autoScroll"), m_autoScroll);
    settings.setValue(QStringLiteral("streamDisplay"), m_streamDisplay);
    settings.setValue(QStringLiteral("soundEffects"), m_soundEffects);
    settings.setValue(QStringLiteral("selectedCharacterId"), m_selectedCharacterId);
    settings.setValue(QStringLiteral("selectedPresetId"), m_selectedPresetId);
    settings.setValue(QStringLiteral("selectedPersonaId"), m_selectedPersonaId);
    settings.setValue(QStringLiteral("language"), m_language);
}

void AppConfig::load() {
    QSettings settings(appDataDir() + QStringLiteral("/config.ini"), QSettings::IniFormat);
    m_theme = settings.value(QStringLiteral("theme"), QStringLiteral("dark")).toString();
    m_fontSize = settings.value(QStringLiteral("fontSize"), 15).toInt();
    m_autoScroll = settings.value(QStringLiteral("autoScroll"), true).toBool();
    m_streamDisplay = settings.value(QStringLiteral("streamDisplay"), true).toBool();
    m_soundEffects = settings.value(QStringLiteral("soundEffects"), false).toBool();
    m_selectedCharacterId = settings.value(QStringLiteral("selectedCharacterId"), QString()).toString();
    m_selectedPresetId = settings.value(QStringLiteral("selectedPresetId"), QString()).toString();
    m_selectedPersonaId = settings.value(QStringLiteral("selectedPersonaId"), QString()).toString();
    m_language = settings.value(QStringLiteral("language"), QStringLiteral("ko")).toString();
}

} // namespace Risu
