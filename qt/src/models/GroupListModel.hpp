#pragma once

#include <QAbstractListModel>
#include <QList>
#include <QVariantMap>
#include "../core/Types.hpp"

namespace Risu {

class GroupListModel : public QAbstractListModel {
    Q_OBJECT
    Q_PROPERTY(int count READ rowCount NOTIFY countChanged)

public:
    enum GroupRoles {
        IdRole = Qt::UserRole + 1,
        NameRole,
        DescriptionRole,
        AvatarPathRole,
        SpeakerModeRole,
        MemberCountRole,
        MembersRole,
        LastInteractionRole
    };

    explicit GroupListModel(QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = QModelIndex()) const override;
    QVariant data(const QModelIndex& index, int role = Qt::DisplayRole) const override;
    QHash<int, QByteArray> roleNames() const override;

    void setGroups(const QList<GroupChatRoom>& groups);
    const QList<GroupChatRoom>& groups() const { return m_groups; }
    std::optional<GroupChatRoom> groupAt(int row) const;
    Q_INVOKABLE QVariantMap getGroupAt(int row) const;
    Q_INVOKABLE int indexOfId(const QString& id) const;

signals:
    void countChanged();

private:
    QList<GroupChatRoom> m_groups;
};

} // namespace Risu
