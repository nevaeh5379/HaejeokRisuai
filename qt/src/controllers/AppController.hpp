#pragma once

#include <QObject>
#include <QString>
#include "ChatController.hpp"
#include "CharacterController.hpp"
#include "PresetController.hpp"
#include "LorebookController.hpp"
#include "PersonaController.hpp"
#include "TTSController.hpp"
#include "ImageGenController.hpp"
#include "GroupChatController.hpp"
#include "APIServerController.hpp"
#include "../core/AppConfig.hpp"

namespace Risu {

class AppController : public QObject {
    Q_OBJECT
    Q_PROPERTY(ChatController* chat READ chat CONSTANT)
    Q_PROPERTY(CharacterController* character READ character CONSTANT)
    Q_PROPERTY(PresetController* preset READ preset CONSTANT)
    Q_PROPERTY(LorebookController* lorebook READ lorebook CONSTANT)
    Q_PROPERTY(PersonaController* persona READ persona CONSTANT)
    Q_PROPERTY(TTSController* tts READ tts CONSTANT)
    Q_PROPERTY(ImageGenController* imageGen READ imageGen CONSTANT)
    Q_PROPERTY(GroupChatController* group READ group CONSTANT)
    Q_PROPERTY(APIServerController* apiServer READ apiServer CONSTANT)
    Q_PROPERTY(AppConfig* config READ config CONSTANT)
    Q_PROPERTY(QString appVersion READ appVersion CONSTANT)

public:
    explicit AppController(QObject* parent = nullptr);

    ChatController* chat() { return &m_chatCtrl; }
    CharacterController* character() { return &m_charCtrl; }
    PresetController* preset() { return &m_presetCtrl; }
    LorebookController* lorebook() { return &m_loreCtrl; }
    PersonaController* persona() { return &m_personaCtrl; }
    TTSController* tts() { return &m_ttsCtrl; }
    ImageGenController* imageGen() { return &m_imageGenCtrl; }
    GroupChatController* group() { return &m_groupCtrl; }
    APIServerController* apiServer() { return &m_apiServerCtrl; }
    AppConfig* config() { return &AppConfig::instance(); }
    QString appVersion() const { return QStringLiteral("2026.8 Native Qt (C++/QML)"); }

public slots:
    void showToast(const QString& type, const QString& message);
    bool backupData(const QString& targetFilePath);
    bool restoreData(const QString& sourceFilePath);
    void openDirectory(const QString& dirPath);

signals:
    void toastTriggered(const QString& type, const QString& message);

private:
    ChatController m_chatCtrl;
    CharacterController m_charCtrl;
    PresetController m_presetCtrl;
    LorebookController m_loreCtrl;
    PersonaController m_personaCtrl;
    TTSController m_ttsCtrl;
    ImageGenController m_imageGenCtrl;
    GroupChatController m_groupCtrl;
    APIServerController m_apiServerCtrl;
};

} // namespace Risu
