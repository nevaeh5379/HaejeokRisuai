#include "AppController.hpp"
#include "../storage/ExportImport.hpp"
#include <QDesktopServices>
#include <QUrl>

namespace Risu {

AppController::AppController(QObject* parent) : QObject(parent) {
    // Connect toast signals from child controllers
    connect(&m_chatCtrl, &ChatController::toastRequested, this, &AppController::showToast);
    connect(&m_charCtrl, &CharacterController::toastRequested, this, &AppController::showToast);
    connect(&m_presetCtrl, &PresetController::toastRequested, this, &AppController::showToast);
    connect(&m_loreCtrl, &LorebookController::toastRequested, this, &AppController::showToast);
    connect(&m_personaCtrl, &PersonaController::toastRequested, this, &AppController::showToast);
    connect(&m_ttsCtrl, &TTSController::toastRequested, this, &AppController::showToast);
    connect(&m_imageGenCtrl, &ImageGenController::toastRequested, this, &AppController::showToast);
    connect(&m_groupCtrl, &GroupChatController::toastRequested, this, &AppController::showToast);
    connect(&m_apiServerCtrl, &APIServerController::toastRequested, this, &AppController::showToast);

    // Sync character selection to chat controller
    connect(&m_charCtrl, &CharacterController::selectedCharacterChanged, this, [this]() {
        QVariantMap selected = m_charCtrl.selectedCharacter();
        QString id = selected.value(QStringLiteral("id")).toString();
        if (!id.isEmpty() && id != m_chatCtrl.activeCharacterId()) {
            m_chatCtrl.loadCharacter(id);
        }
    });

    // Auto-speak on generation finish
    connect(&m_chatCtrl, &ChatController::generationFinished, this, [this](const QString& response) {
        if (m_ttsCtrl.ttsEnabled() && m_ttsCtrl.autoSpeak() && !response.isEmpty()) {
            m_ttsCtrl.speak(response);
        }
    });

    // Sync preset selection
    connect(&m_presetCtrl, &PresetController::activePresetChanged, this, [this]() {
        m_chatCtrl.reloadPreset();
    });
}

void AppController::showToast(const QString& type, const QString& message) {
    emit toastTriggered(type, message);
}

bool AppController::backupData(const QString& targetFilePath) {
    bool ok = ExportImport::exportFullBackup(targetFilePath);
    if (ok) {
        showToast(QStringLiteral("success"), QStringLiteral("Full backup successfully created."));
    } else {
        showToast(QStringLiteral("error"), QStringLiteral("Failed to export backup."));
    }
    return ok;
}

bool AppController::restoreData(const QString& sourceFilePath) {
    bool ok = ExportImport::importFullBackup(sourceFilePath);
    if (ok) {
        m_charCtrl.refreshCharacters();
        m_presetCtrl.refreshPresets();
        m_personaCtrl.refreshPersonas();
        m_loreCtrl.refreshLorebooks();
        showToast(QStringLiteral("success"), QStringLiteral("Database restored successfully!"));
    } else {
        showToast(QStringLiteral("error"), QStringLiteral("Failed to restore backup."));
    }
    return ok;
}

void AppController::openDirectory(const QString& dirPath) {
    QDesktopServices::openUrl(QUrl::fromLocalFile(dirPath));
}

} // namespace Risu
