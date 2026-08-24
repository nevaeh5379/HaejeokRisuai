#pragma once

#include <QAbstractListModel>
#include <QList>
#include <QVariantMap>
#include "../core/Types.hpp"

namespace Risu {

class PresetListModel : public QAbstractListModel {
    Q_OBJECT
    Q_PROPERTY(int count READ rowCount NOTIFY countChanged)

public:
    enum PresetRoles {
        IdRole = Qt::UserRole + 1,
        NameRole,
        ProviderRole,
        ModelNameRole,
        TemperatureRole,
        MaxTokensRole
    };

    explicit PresetListModel(QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = QModelIndex()) const override;
    QVariant data(const QModelIndex& index, int role = Qt::DisplayRole) const override;
    QHash<int, QByteArray> roleNames() const override;

    void setPresets(const QList<Preset>& presets);
    const QList<Preset>& presets() const { return m_presets; }

    Q_INVOKABLE int indexOfId(const QString& id) const;
    Q_INVOKABLE QVariantMap getPresetAt(int row) const;

signals:
    void countChanged();

private:
    QList<Preset> m_presets;
};

} // namespace Risu
