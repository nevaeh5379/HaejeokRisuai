#pragma once

#include <QObject>
#include <QCoreApplication>
#include <QString>
#include <QSoundEffect>
#include <memory>

namespace Risu {

class SoundEffectManager : public QObject {
    Q_OBJECT

public:
    static SoundEffectManager& instance();

    Q_INVOKABLE void playSendSound();
    Q_INVOKABLE void playReceiveSound();
    Q_INVOKABLE void playAlertSound();
    Q_INVOKABLE void playCustomSound(const QString& filePath);

private:
    explicit SoundEffectManager(QObject* parent = nullptr);
    void initBuiltinSounds();

    std::unique_ptr<QSoundEffect> m_sendEffect;
    std::unique_ptr<QSoundEffect> m_recvEffect;
    std::unique_ptr<QSoundEffect> m_alertEffect;
};

} // namespace Risu
