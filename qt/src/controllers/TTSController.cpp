#include "TTSController.hpp"
#include <QSettings>

namespace Risu {

TTSController::TTSController(QObject* parent) : QObject(parent) {
    QSettings settings;
    m_ttsEnabled = settings.value(QStringLiteral("tts/enabled"), false).toBool();
    m_autoSpeak = settings.value(QStringLiteral("tts/autoSpeak"), false).toBool();
    m_provider = settings.value(QStringLiteral("tts/provider"), QStringLiteral("openai")).toString();
    m_apiKey = settings.value(QStringLiteral("tts/apiKey"), QString()).toString();
    m_voiceId = settings.value(QStringLiteral("tts/voiceId"), QStringLiteral("alloy")).toString();
    m_model = settings.value(QStringLiteral("tts/model"), QStringLiteral("tts-1")).toString();
    m_customEndpoint = settings.value(QStringLiteral("tts/customEndpoint"), QString()).toString();

    connect(&m_ttsManager, &TTSManager::speakingStarted, this, &TTSController::isSpeakingChanged);
    connect(&m_ttsManager, &TTSManager::speakingFinished, this, &TTSController::isSpeakingChanged);
    connect(&m_ttsManager, &TTSManager::errorOccurred, this, [this](const QString& err) {
        emit toastRequested(QStringLiteral("error"), err);
    });
}

void TTSController::setTtsEnabled(bool enabled) {
    if (m_ttsEnabled != enabled) {
        m_ttsEnabled = enabled;
        QSettings().setValue(QStringLiteral("tts/enabled"), enabled);
        emit ttsEnabledChanged();
    }
}

void TTSController::setAutoSpeak(bool autoSpk) {
    if (m_autoSpeak != autoSpk) {
        m_autoSpeak = autoSpk;
        QSettings().setValue(QStringLiteral("tts/autoSpeak"), autoSpk);
        emit autoSpeakChanged();
    }
}

void TTSController::setProvider(const QString& prov) {
    if (m_provider != prov) {
        m_provider = prov;
        QSettings().setValue(QStringLiteral("tts/provider"), prov);
        emit providerChanged();
    }
}

void TTSController::setApiKey(const QString& key) {
    if (m_apiKey != key) {
        m_apiKey = key;
        QSettings().setValue(QStringLiteral("tts/apiKey"), key);
        emit apiKeyChanged();
    }
}

void TTSController::setVoiceId(const QString& vId) {
    if (m_voiceId != vId) {
        m_voiceId = vId;
        QSettings().setValue(QStringLiteral("tts/voiceId"), vId);
        emit voiceIdChanged();
    }
}

void TTSController::setModel(const QString& mdl) {
    if (m_model != mdl) {
        m_model = mdl;
        QSettings().setValue(QStringLiteral("tts/model"), mdl);
        emit modelChanged();
    }
}

void TTSController::setCustomEndpoint(const QString& ep) {
    if (m_customEndpoint != ep) {
        m_customEndpoint = ep;
        QSettings().setValue(QStringLiteral("tts/customEndpoint"), ep);
        emit customEndpointChanged();
    }
}

void TTSController::speak(const QString& text) {
    if (text.trimmed().isEmpty()) return;

    TTSProvider prov = TTSProvider::OpenAI;
    if (m_provider == QStringLiteral("elevenlabs")) prov = TTSProvider::ElevenLabs;
    else if (m_provider == QStringLiteral("voicevox")) prov = TTSProvider::Voicevox;
    else if (m_provider == QStringLiteral("custom")) prov = TTSProvider::Custom;

    m_ttsManager.speak(text, prov, m_apiKey, m_voiceId, m_model, m_customEndpoint);
}

void TTSController::stop() {
    m_ttsManager.stop();
}

} // namespace Risu
