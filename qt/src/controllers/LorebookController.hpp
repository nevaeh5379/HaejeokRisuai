#pragma once

#include <QObject>
#include <QVariantMap>
#include "../core/Types.hpp"
#include "../models/LorebookListModel.hpp"

namespace Risu {

class LorebookController : public QObject {
    Q_OBJECT
    Q_PROPERTY(LorebookListModel* lorebookModel READ lorebookModel CONSTANT)

public:
    explicit LorebookController(QObject* parent = nullptr);

    LorebookListModel* lorebookModel() { return &m_loreModel; }

public slots:
    void refreshLorebooks();
    QString createNewEntry();
    bool saveEntry(const QVariantMap& data);
    bool deleteEntry(const QString& entryId);
    bool importLorebookFromJson(const QString& filePath);
    bool exportLorebookToJson(const QString& targetFilePath);

signals:
    void toastRequested(const QString& type, const QString& message);

private:
    LorebookListModel m_loreModel;
};

} // namespace Risu
