#pragma once

#include <QObject>
#include <QString>
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
};

} // namespace Risu
