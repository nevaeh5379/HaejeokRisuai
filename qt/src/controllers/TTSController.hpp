#pragma once

#include <QObject>
#include <QString>
#include "../network/TTSManager.hpp"

namespace Risu {

class TTSController : public QObject {
    Q_OBJECT

    Q_PROPERTY(bool ttsEnabled READ ttsEnabled WRITE setTtsEnabled NOTIFY ttsEnabledChanged)
    Q_PROPERTY(bool autoSpeak READ autoSpeak WRITE setAutoSpeak NOTIFY autoSpeakChanged)
    Q_PROPERTY(QString provider READ provider WRITE setProvider NOTIFY providerChanged)
    Q_PROPERTY(QString apiKey READ apiKey WRITE setApiKey NOTIFY apiKeyChanged)
    Q_PROPERTY(QString voiceId READ voiceId WRITE setVoiceId NOTIFY voiceIdChanged)
    Q_PROPERTY(QString model READ model WRITE setModel NOTIFY modelChanged)
    Q_PROPERTY(QString customEndpoint READ customEndpoint WRITE setCustomEndpoint NOTIFY customEndpointChanged)
    Q_PROPERTY(bool isSpeaking READ isSpeaking NOTIFY isSpeakingChanged)

public:
    explicit TTSController(QObject* parent = nullptr);

    bool ttsEnabled() const { return m_ttsEnabled; }
    void setTtsEnabled(bool enabled);

    bool autoSpeak() const { return m_autoSpeak; }
    void setAutoSpeak(bool autoSpk);

    QString provider() const { return m_provider; }
    void setProvider(const QString& prov);

    QString apiKey() const { return m_apiKey; }
    void setApiKey(const QString& key);

    QString voiceId() const { return m_voiceId; }
    void setVoiceId(const QString& vId);

    QString model() const { return m_model; }
    void setModel(const QString& mdl);

    QString customEndpoint() const { return m_customEndpoint; }
    void setCustomEndpoint(const QString& ep);

    bool isSpeaking() const { return m_ttsManager.isSpeaking(); }

public slots:
    void speak(const QString& text);
    void stop();

signals:
    void ttsEnabledChanged();
    void autoSpeakChanged();
    void providerChanged();
    void apiKeyChanged();
    void voiceIdChanged();
    void modelChanged();
    void customEndpointChanged();
    void isSpeakingChanged();
    void toastRequested(const QString& type, const QString& message);

private:
    TTSManager m_ttsManager;
    bool m_ttsEnabled = false;
    bool m_autoSpeak = false;
    QString m_provider = QStringLiteral("openai");
    QString m_apiKey;
    QString m_voiceId = QStringLiteral("alloy");
    QString m_model = QStringLiteral("tts-1");
    QString m_customEndpoint;
};

} // namespace Risu
