#include "SoundEffectManager.hpp"
#include "AppConfig.hpp"
#include <QBuffer>
#include <QDir>
#include <QUrl>
#include <cmath>
#include <cstring>
#include <QDebug>

namespace Risu {

#pragma pack(push, 1)
struct WavHeader {
    char riff[4] = {'R', 'I', 'F', 'F'};
    quint32 chunkSize = 0;
    char wave[4] = {'W', 'A', 'V', 'E'};
    char fmt[4] = {'f', 'm', 't', ' '};
    quint32 subchunk1Size = 16;
    quint16 audioFormat = 1; // PCM
    quint16 numChannels = 1; // Mono
    quint32 sampleRate = 44100;
    quint32 byteRate = 44100 * 1 * 2; // sampleRate * numChannels * bitsPerSample/8
    quint16 blockAlign = 2; // numChannels * bitsPerSample/8
    quint16 bitsPerSample = 16;
    char data[4] = {'d', 'a', 't', 'a'};
    quint32 subchunk2Size = 0;
};
#pragma pack(pop)

// Helper: create a valid in-memory PCM 16-bit Mono WAV byte array
static QByteArray generateSineWav(int frequency, int durationMs, int sampleRate = 44100) {
    int totalSamples = (sampleRate * durationMs) / 1000;
    QByteArray pcmData;
    pcmData.resize(totalSamples * sizeof(qint16));

    qint16* samples = reinterpret_cast<qint16*>(pcmData.data());
    for (int i = 0; i < totalSamples; ++i) {
        double t = static_cast<double>(i) / sampleRate;
        // Apply envelope decay
        double env = 1.0 - (static_cast<double>(i) / totalSamples);
        double val = std::sin(2.0 * M_PI * frequency * t) * env * 16000.0;
        samples[i] = static_cast<qint16>(val);
    }

    WavHeader header;
    header.sampleRate = sampleRate;
    header.numChannels = 1;
    header.bitsPerSample = 16;
    header.byteRate = sampleRate * 1 * 2;
    header.blockAlign = 2;
    header.subchunk2Size = static_cast<quint32>(pcmData.size());
    header.chunkSize = 36 + header.subchunk2Size;

    QByteArray wav;
    wav.resize(sizeof(WavHeader) + pcmData.size());
    std::memcpy(wav.data(), &header, sizeof(WavHeader));
    std::memcpy(wav.data() + sizeof(WavHeader), pcmData.constData(), pcmData.size());

    return wav;
}

SoundEffectManager& SoundEffectManager::instance() {
    static SoundEffectManager inst;
    return inst;
}

SoundEffectManager::SoundEffectManager(QObject* parent) : QObject(parent) {
    m_sendEffect = std::make_unique<QSoundEffect>(this);
    m_recvEffect = std::make_unique<QSoundEffect>(this);
    m_alertEffect = std::make_unique<QSoundEffect>(this);

    initBuiltinSounds();
}

void SoundEffectManager::initBuiltinSounds() {
    // Generate built-in WAV buffers
    QString tempDir = QDir::tempPath() + QStringLiteral("/risu_sfx");
    QDir().mkpath(tempDir);

    QString sendPath = tempDir + QStringLiteral("/send.wav");
    QString recvPath = tempDir + QStringLiteral("/recv.wav");
    QString alertPath = tempDir + QStringLiteral("/alert.wav");

    auto writeWav = [](const QString& path, int freq, int dur) {
        QFile f(path);
        if (f.open(QIODevice::WriteOnly)) {
            f.write(generateSineWav(freq, dur));
            f.close();
        }
    };

    writeWav(sendPath, 659, 80);
    writeWav(recvPath, 784, 120);
    writeWav(alertPath, 330, 150);

    m_sendEffect->setSource(QUrl::fromLocalFile(sendPath));
    m_sendEffect->setVolume(0.5f);

    m_recvEffect->setSource(QUrl::fromLocalFile(recvPath));
    m_recvEffect->setVolume(0.6f);

    m_alertEffect->setSource(QUrl::fromLocalFile(alertPath));
    m_alertEffect->setVolume(0.7f);
}

void SoundEffectManager::playSendSound() {
    if (AppConfig::instance().soundEffects() && m_sendEffect) {
        m_sendEffect->play();
    }
}

void SoundEffectManager::playReceiveSound() {
    if (AppConfig::instance().soundEffects() && m_recvEffect) {
        m_recvEffect->play();
    }
}

void SoundEffectManager::playAlertSound() {
    if (AppConfig::instance().soundEffects() && m_alertEffect) {
        m_alertEffect->play();
    }
}

void SoundEffectManager::playCustomSound(const QString& filePath) {
    if (!AppConfig::instance().soundEffects() || filePath.isEmpty()) return;

    auto* customEffect = new QSoundEffect(this);
    customEffect->setSource(QUrl::fromLocalFile(filePath));
    customEffect->setVolume(0.6f);
    connect(customEffect, &QSoundEffect::playingChanged, this, [customEffect]() {
        if (!customEffect->isPlaying()) {
            customEffect->deleteLater();
        }
    });
    customEffect->play();
}

} // namespace Risu
