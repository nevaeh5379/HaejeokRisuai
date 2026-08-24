#include "PresetListModel.hpp"

namespace Risu {

PresetListModel::PresetListModel(QObject* parent) : QAbstractListModel(parent) {
}

int PresetListModel::rowCount(const QModelIndex& parent) const {
    if (parent.isValid()) return 0;
    return m_presets.size();
}

QVariant PresetListModel::data(const QModelIndex& index, int role) const {
    if (!index.isValid() || index.row() < 0 || index.row() >= m_presets.size()) {
        return QVariant();
    }

    const auto& p = m_presets[index.row()];
    switch (role) {
        case IdRole: return p.id;
        case NameRole: return p.name;
        case ProviderRole: return providerTypeToString(p.provider);
        case ModelNameRole: return p.modelName;
        case TemperatureRole: return p.temperature;
        case MaxTokensRole: return p.maxTokens;
        default: return QVariant();
    }
}

QHash<int, QByteArray> PresetListModel::roleNames() const {
    QHash<int, QByteArray> roles;
    roles[IdRole] = "presetId";
    roles[NameRole] = "name";
    roles[ProviderRole] = "provider";
    roles[ModelNameRole] = "modelName";
    roles[TemperatureRole] = "temperature";
    roles[MaxTokensRole] = "maxTokens";
    return roles;
}

void PresetListModel::setPresets(const QList<Preset>& presets) {
    beginResetModel();
    m_presets = presets;
    endResetModel();
    emit countChanged();
}

int PresetListModel::indexOfId(const QString& id) const {
    for (int i = 0; i < m_presets.size(); ++i) {
        if (m_presets[i].id == id) return i;
    }
    return -1;
}

QVariantMap PresetListModel::getPresetAt(int row) const {
    QVariantMap map;
    if (row >= 0 && row < m_presets.size()) {
        const auto& p = m_presets[row];
        map[QStringLiteral("id")] = p.id;
        map[QStringLiteral("name")] = p.name;
        map[QStringLiteral("provider")] = providerTypeToString(p.provider);
        map[QStringLiteral("modelName")] = p.modelName;
        map[QStringLiteral("apiKey")] = p.apiKey;
        map[QStringLiteral("customEndpointUrl")] = p.customEndpointUrl;
        map[QStringLiteral("temperature")] = p.temperature;
        map[QStringLiteral("maxTokens")] = p.maxTokens;
        map[QStringLiteral("contextLimit")] = p.contextLimit;
        map[QStringLiteral("topP")] = p.topP;
        map[QStringLiteral("topK")] = p.topK;
        map[QStringLiteral("frequencyPenalty")] = p.frequencyPenalty;
        map[QStringLiteral("presencePenalty")] = p.presencePenalty;
        map[QStringLiteral("repetitionPenalty")] = p.repetitionPenalty;
        map[QStringLiteral("reasoningEffort")] = p.reasoningEffort;
        map[QStringLiteral("enableStreaming")] = p.enableStreaming;
    }
    return map;
}

} // namespace Risu
