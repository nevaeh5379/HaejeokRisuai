#include "TTSManager.hpp"
#include <QJsonObject>
#include <QJsonDocument>
#include <QFile>
#include <QDir>
#include <QUrl>
#include <QUuid>
#include <QDebug>

namespace Risu {

TTSManager::TTSManager(QObject* parent) : QObject(parent) {
    m_player = std::make_unique<QMediaPlayer>(this);
    m_audioOutput = std::make_unique<QAudioOutput>(this);
    m_player->setAudioOutput(m_audioOutput.get());
    m_audioOutput->setVolume(1.0f);

    connect(m_player.get(), &QMediaPlayer::playbackStateChanged, this, &TTSManager::onMediaPlaybackStateChanged);
}

TTSManager::~TTSManager() {
    stop();
    if (!m_tempAudioFile.isEmpty() && QFile::exists(m_tempAudioFile)) {
        QFile::remove(m_tempAudioFile);
    }
}

void TTSManager::stop() {
    if (m_player) {
        m_player->stop();
    }
    if (m_isSpeaking) {
        m_isSpeaking = false;
        emit speakingFinished();
    }
}

void TTSManager::speak(
    const QString& text,
    TTSProvider provider,
    const QString& apiKey,
    const QString& voiceId,
    const QString& model,
    const QString& customEndpoint
) {
    if (text.trimmed().isEmpty()) return;

    stop();

    QNetworkRequest req;
    QByteArray payload;

    switch (provider) {
        case TTSProvider::OpenAI: {
            QString urlStr = customEndpoint.isEmpty() ? QStringLiteral("https://api.openai.com/v1/audio/speech") : customEndpoint;
            req.setUrl(QUrl(urlStr));
            req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
            req.setRawHeader("Authorization", "Bearer " + apiKey.toUtf8());

            QJsonObject obj;
            obj[QStringLiteral("model")] = model.isEmpty() ? QStringLiteral("tts-1") : model;
            obj[QStringLiteral("voice")] = voiceId.isEmpty() ? QStringLiteral("alloy") : voiceId;
            obj[QStringLiteral("input")] = text;
            obj[QStringLiteral("response_format")] = QStringLiteral("mp3");

            payload = QJsonDocument(obj).toJson(QJsonDocument::Compact);
            break;
        }
        case TTSProvider::ElevenLabs: {
            QString vId = voiceId.isEmpty() ? QStringLiteral("21m00Tcm4TlvDq8ikWAM") : voiceId;
            req.setUrl(QUrl(QStringLiteral("https://api.elevenlabs.io/v1/text-to-speech/") + vId));
            req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
            req.setRawHeader("xi-api-key", apiKey.toUtf8());

            QJsonObject obj;
            obj[QStringLiteral("text")] = text;
            QJsonObject voiceSettings;
            voiceSettings[QStringLiteral("stability")] = 0.5;
            voiceSettings[QStringLiteral("similarity_boost")] = 0.75;
            obj[QStringLiteral("voice_settings")] = voiceSettings;

            payload = QJsonDocument(obj).toJson(QJsonDocument::Compact);
            break;
        }
        case TTSProvider::Voicevox:
        case TTSProvider::Custom:
        default: {
            QString urlStr = customEndpoint.isEmpty() ? QStringLiteral("http://localhost:50021/audio_query") : customEndpoint;
            req.setUrl(QUrl(urlStr));
            req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
            if (!apiKey.isEmpty()) req.setRawHeader("Authorization", "Bearer " + apiKey.toUtf8());

            QJsonObject obj;
            obj[QStringLiteral("text")] = text;
            obj[QStringLiteral("speaker")] = voiceId.isEmpty() ? 1 : voiceId.toInt();

            payload = QJsonDocument(obj).toJson(QJsonDocument::Compact);
            break;
        }
    }

    QNetworkReply* reply = m_netManager.post(req, payload);
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        this->onReplyFinished(reply);
    });
}

void TTSManager::onReplyFinished(QNetworkReply* reply) {
    reply->deleteLater();

    if (reply->error() != QNetworkReply::NoError) {
        emit errorOccurred(QStringLiteral("TTS Network Error: ") + reply->errorString());
        return;
    }

    QByteArray audioData = reply->readAll();
    if (audioData.isEmpty()) {
        emit errorOccurred(QStringLiteral("Received empty TTS audio data."));
        return;
    }

    // Clean up prior temp file
    if (!m_tempAudioFile.isEmpty() && QFile::exists(m_tempAudioFile)) {
        QFile::remove(m_tempAudioFile);
    }

    m_tempAudioFile = QDir::tempPath() + QStringLiteral("/risu_tts_") + QUuid::createUuid().toString(QUuid::WithoutBraces) + QStringLiteral(".mp3");
    QFile f(m_tempAudioFile);
    if (f.open(QIODevice::WriteOnly)) {
        f.write(audioData);
        f.close();

        m_player->setSource(QUrl::fromLocalFile(m_tempAudioFile));
        m_player->play();
        m_isSpeaking = true;
        emit speakingStarted();
    } else {
        emit errorOccurred(QStringLiteral("Failed to write temporary audio file for TTS playback."));
    }
}

void TTSManager::onMediaPlaybackStateChanged(QMediaPlayer::PlaybackState state) {
    if (state == QMediaPlayer::StoppedState) {
        if (m_isSpeaking) {
            m_isSpeaking = false;
            emit speakingFinished();
        }
    }
}

} // namespace Risu
