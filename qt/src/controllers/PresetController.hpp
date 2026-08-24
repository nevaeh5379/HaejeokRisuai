#pragma once

#include <QObject>
#include <QVariantMap>
#include "../core/Types.hpp"
#include "../models/PresetListModel.hpp"

namespace Risu {

class PresetController : public QObject {
    Q_OBJECT
    Q_PROPERTY(PresetListModel* presetModel READ presetModel CONSTANT)
    Q_PROPERTY(QVariantMap activePreset READ activePreset NOTIFY activePresetChanged)
    Q_PROPERTY(QString activePresetId READ activePresetId NOTIFY activePresetChanged)

public:
    explicit PresetController(QObject* parent = nullptr);

    PresetListModel* presetModel() { return &m_presetModel; }
    QVariantMap activePreset() const;
    QString activePresetId() const { return m_activePresetId; }

public slots:
    void refreshPresets();
    void selectPreset(const QString& presetId);
    QString createPreset(const QString& name, const QString& providerStr);
    bool savePresetDetails(const QVariantMap& data);
    bool deletePreset(const QString& presetId);

signals:
    void activePresetChanged();
    void toastRequested(const QString& type, const QString& message);

private:
    PresetListModel m_presetModel;
    QString m_activePresetId;
    Preset m_activePreset;
};

} // namespace Risu
