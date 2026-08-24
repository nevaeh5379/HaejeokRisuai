#pragma once

#include <QObject>
#include <QString>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QMediaPlayer>
#include <QAudioOutput>
#include <memory>

namespace Risu {

enum class TTSProvider {
    OpenAI,
    ElevenLabs,
    Voicevox,
    Custom
};

class TTSManager : public QObject {
    Q_OBJECT

public:
    explicit TTSManager(QObject* parent = nullptr);
    ~TTSManager() override;

    bool isSpeaking() const { return m_isSpeaking; }

    void speak(
        const QString& text,
        TTSProvider provider,
        const QString& apiKey,
        const QString& voiceId,
        const QString& model = QStringLiteral("tts-1"),
        const QString& customEndpoint = QString()
    );

    void stop();

signals:
    void speakingStarted();
    void speakingFinished();
    void errorOccurred(const QString& errorMessage);

private slots:
    void onReplyFinished(QNetworkReply* reply);
    void onMediaPlaybackStateChanged(QMediaPlayer::PlaybackState state);

private:
    QNetworkAccessManager m_netManager;
    std::unique_ptr<QMediaPlayer> m_player;
    std::unique_ptr<QAudioOutput> m_audioOutput;
    bool m_isSpeaking = false;
    QString m_tempAudioFile;
};

} // namespace Risu
