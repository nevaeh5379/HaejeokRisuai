#include "PresetController.hpp"
#include "../core/DatabaseManager.hpp"
#include "../core/AppConfig.hpp"
#include <QDebug>

namespace Risu {

PresetController::PresetController(QObject* parent) : QObject(parent) {
    connect(&DatabaseManager::instance(), &DatabaseManager::presetsChanged, this, &PresetController::refreshPresets);
    refreshPresets();

    QString selId = AppConfig::instance().selectedPresetId();
    if (!selId.isEmpty()) {
        selectPreset(selId);
    }
}

void PresetController::refreshPresets() {
    auto presets = DatabaseManager::instance().getAllPresets();
    m_presetModel.setPresets(presets);

    if (!m_activePresetId.isEmpty()) {
        auto opt = DatabaseManager::instance().getPreset(m_activePresetId);
        if (opt) {
            m_activePreset = *opt;
            emit activePresetChanged();
        }
    }
}

void PresetController::selectPreset(const QString& presetId) {
    auto opt = DatabaseManager::instance().getPreset(presetId);
    if (opt) {
        m_activePresetId = presetId;
        m_activePreset = *opt;
        AppConfig::instance().setSelectedPresetId(presetId);
        emit activePresetChanged();
    }
}

QVariantMap PresetController::activePreset() const {
    QVariantMap map;
    if (m_activePreset.id.isEmpty()) return map;

    map[QStringLiteral("id")] = m_activePreset.id;
    map[QStringLiteral("name")] = m_activePreset.name;
    map[QStringLiteral("provider")] = providerTypeToString(m_activePreset.provider);
    map[QStringLiteral("modelName")] = m_activePreset.modelName;
    map[QStringLiteral("apiKey")] = m_activePreset.apiKey;
    map[QStringLiteral("customEndpointUrl")] = m_activePreset.customEndpointUrl;
    map[QStringLiteral("temperature")] = m_activePreset.temperature;
    map[QStringLiteral("maxTokens")] = m_activePreset.maxTokens;
    map[QStringLiteral("contextLimit")] = m_activePreset.contextLimit;
    map[QStringLiteral("topP")] = m_activePreset.topP;
    map[QStringLiteral("topK")] = m_activePreset.topK;
    map[QStringLiteral("frequencyPenalty")] = m_activePreset.frequencyPenalty;
    map[QStringLiteral("presencePenalty")] = m_activePreset.presencePenalty;
    map[QStringLiteral("repetitionPenalty")] = m_activePreset.repetitionPenalty;
    map[QStringLiteral("reasoningEffort")] = m_activePreset.reasoningEffort;
    map[QStringLiteral("enableStreaming")] = m_activePreset.enableStreaming;
    map[QStringLiteral("stopSequences")] = m_activePreset.stopSequences.join(QStringLiteral(", "));
    map[QStringLiteral("mainPrompt")] = m_activePreset.mainPrompt;
    map[QStringLiteral("jailbreakPrompt")] = m_activePreset.jailbreakPrompt;
    map[QStringLiteral("globalNote")] = m_activePreset.globalNote;
    map[QStringLiteral("postHistoryInstructions")] = m_activePreset.postHistoryInstructions;
    map[QStringLiteral("enableJailbreak")] = m_activePreset.enableJailbreak;
    map[QStringLiteral("formattingOrder")] = m_activePreset.formattingOrder;

    return map;
}

QString PresetController::createPreset(const QString& name, const QString& providerStr) {
    Preset p;
    p.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    p.name = name.isEmpty() ? QStringLiteral("New Preset") : name;
    p.provider = stringToProviderType(providerStr);
    if (p.provider == ProviderType::AnthropicClaude) p.modelName = QStringLiteral("claude-3-7-sonnet-20250219");
    else if (p.provider == ProviderType::GoogleGemini) p.modelName = QStringLiteral("gemini-2.5-flash");
    else if (p.provider == ProviderType::Ollama) p.modelName = QStringLiteral("llama3.3");
    else p.modelName = QStringLiteral("gpt-4o-mini");

    p.mainPrompt = QStringLiteral("Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.\nBe proactive, creative, and drive the plot and conversation forward.");

    DatabaseManager::instance().savePreset(p);
    selectPreset(p.id);

    emit toastRequested(QStringLiteral("success"), QStringLiteral("Preset created: ") + p.name);
    return p.id;
}

bool PresetController::savePresetDetails(const QVariantMap& data) {
    QString id = data.value(QStringLiteral("id")).toString();
    if (id.isEmpty()) return false;

    auto opt = DatabaseManager::instance().getPreset(id);
    if (!opt) return false;

    Preset p = *opt;
    if (data.contains(QStringLiteral("name"))) p.name = data.value(QStringLiteral("name")).toString();
    if (data.contains(QStringLiteral("provider"))) p.provider = stringToProviderType(data.value(QStringLiteral("provider")).toString());
    if (data.contains(QStringLiteral("modelName"))) p.modelName = data.value(QStringLiteral("modelName")).toString();
    if (data.contains(QStringLiteral("apiKey"))) p.apiKey = data.value(QStringLiteral("apiKey")).toString();
    if (data.contains(QStringLiteral("customEndpointUrl"))) p.customEndpointUrl = data.value(QStringLiteral("customEndpointUrl")).toString();
    if (data.contains(QStringLiteral("temperature"))) p.temperature = data.value(QStringLiteral("temperature")).toDouble();
    if (data.contains(QStringLiteral("maxTokens"))) p.maxTokens = data.value(QStringLiteral("maxTokens")).toInt();
    if (data.contains(QStringLiteral("contextLimit"))) p.contextLimit = data.value(QStringLiteral("contextLimit")).toInt();
    if (data.contains(QStringLiteral("topP"))) p.topP = data.value(QStringLiteral("topP")).toDouble();
    if (data.contains(QStringLiteral("topK"))) p.topK = data.value(QStringLiteral("topK")).toInt();
    if (data.contains(QStringLiteral("frequencyPenalty"))) p.frequencyPenalty = data.value(QStringLiteral("frequencyPenalty")).toDouble();
    if (data.contains(QStringLiteral("presencePenalty"))) p.presencePenalty = data.value(QStringLiteral("presencePenalty")).toDouble();
    if (data.contains(QStringLiteral("repetitionPenalty"))) p.repetitionPenalty = data.value(QStringLiteral("repetitionPenalty")).toDouble();
    if (data.contains(QStringLiteral("reasoningEffort"))) p.reasoningEffort = data.value(QStringLiteral("reasoningEffort")).toInt();
    if (data.contains(QStringLiteral("enableStreaming"))) p.enableStreaming = data.value(QStringLiteral("enableStreaming")).toBool();

    if (data.contains(QStringLiteral("stopSequences"))) {
        QString s = data.value(QStringLiteral("stopSequences")).toString();
        p.stopSequences = s.split(QLatin1Char(','), Qt::SkipEmptyParts);
        for (auto& str : p.stopSequences) str = str.trimmed();
    }

    if (data.contains(QStringLiteral("mainPrompt"))) p.mainPrompt = data.value(QStringLiteral("mainPrompt")).toString();
    if (data.contains(QStringLiteral("jailbreakPrompt"))) p.jailbreakPrompt = data.value(QStringLiteral("jailbreakPrompt")).toString();
    if (data.contains(QStringLiteral("globalNote"))) p.globalNote = data.value(QStringLiteral("globalNote")).toString();
    if (data.contains(QStringLiteral("postHistoryInstructions"))) p.postHistoryInstructions = data.value(QStringLiteral("postHistoryInstructions")).toString();
    if (data.contains(QStringLiteral("enableJailbreak"))) p.enableJailbreak = data.value(QStringLiteral("enableJailbreak")).toBool();

    bool ok = DatabaseManager::instance().savePreset(p);
    if (ok) {
        m_activePreset = p;
        emit activePresetChanged();
        emit toastRequested(QStringLiteral("success"), QStringLiteral("Preset saved."));
    }
    return ok;
}

bool PresetController::deletePreset(const QString& presetId) {
    if (m_presetModel.rowCount() <= 1) {
        emit toastRequested(QStringLiteral("warning"), QStringLiteral("Cannot delete the only preset."));
        return false;
    }

    bool ok = DatabaseManager::instance().deletePreset(presetId);
    if (ok) {
        if (m_activePresetId == presetId) {
            auto all = DatabaseManager::instance().getAllPresets();
            if (!all.isEmpty()) {
                selectPreset(all.first().id);
            }
        }
        emit toastRequested(QStringLiteral("info"), QStringLiteral("Preset deleted."));
    }
    return ok;
}

} // namespace Risu
