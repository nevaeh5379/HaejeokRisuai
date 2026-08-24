#pragma once

#include <QAbstractListModel>
#include <QList>
#include <QVariantMap>
#include "../core/Types.hpp"

namespace Risu {

class LorebookListModel : public QAbstractListModel {
    Q_OBJECT
    Q_PROPERTY(int count READ rowCount NOTIFY countChanged)

public:
    enum LorebookRoles {
        IdRole = Qt::UserRole + 1,
        KeyRole,
        SecondKeyRole,
        CommentRole,
        ContentRole,
        ModeRole,
        InsertOrderRole,
        AlwaysActiveRole,
        SelectiveRole,
        UseRegexRole,
        CaseSensitiveRole,
        ScanDepthRole,
        EnabledRole
    };

    explicit LorebookListModel(QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = QModelIndex()) const override;
    QVariant data(const QModelIndex& index, int role = Qt::DisplayRole) const override;
    QHash<int, QByteArray> roleNames() const override;

    void setEntries(const QList<LorebookEntry>& entries);
    const QList<LorebookEntry>& entries() const { return m_entries; }
    std::optional<LorebookEntry> entryAt(int row) const;
    Q_INVOKABLE QVariantMap getEntryAt(int row) const;
    Q_INVOKABLE int indexOfId(const QString& id) const;

signals:
    void countChanged();

private:
    QList<LorebookEntry> m_entries;
};

} // namespace Risu
