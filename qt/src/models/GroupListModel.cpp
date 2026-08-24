#include "GroupListModel.hpp"
#include <QJsonArray>

namespace Risu {

GroupListModel::GroupListModel(QObject* parent) : QAbstractListModel(parent) {
}

int GroupListModel::rowCount(const QModelIndex& parent) const {
    if (parent.isValid()) return 0;
    return m_groups.size();
}

QVariant GroupListModel::data(const QModelIndex& index, int role) const {
    if (!index.isValid() || index.row() < 0 || index.row() >= m_groups.size()) {
        return QVariant();
    }

    const auto& g = m_groups[index.row()];
    switch (role) {
        case IdRole: return g.id;
        case NameRole: return g.name;
        case DescriptionRole: return g.description;
        case AvatarPathRole: return g.avatarPath;
        case SpeakerModeRole: return speakerModeToString(g.speakerMode);
        case MemberCountRole: return g.members.size();
        case MembersRole: {
            QVariantList memList;
            for (const auto& m : g.members) {
                QVariantMap map;
                map[QStringLiteral("characterId")] = m.characterId;
                map[QStringLiteral("name")] = m.name;
                map[QStringLiteral("avatarPath")] = m.avatarPath;
                map[QStringLiteral("enabled")] = m.enabled;
                memList.append(map);
            }
            return memList;
        }
        case LastInteractionRole: return g.lastInteraction;
        default: return QVariant();
    }
}

QHash<int, QByteArray> GroupListModel::roleNames() const {
    QHash<int, QByteArray> roles;
    roles[IdRole] = "groupId";
    roles[NameRole] = "name";
    roles[DescriptionRole] = "description";
    roles[AvatarPathRole] = "avatarPath";
    roles[SpeakerModeRole] = "speakerMode";
    roles[MemberCountRole] = "memberCount";
    roles[MembersRole] = "members";
    roles[LastInteractionRole] = "lastInteraction";
    return roles;
}

void GroupListModel::setGroups(const QList<GroupChatRoom>& groups) {
    beginResetModel();
    m_groups = groups;
    endResetModel();
    emit countChanged();
}

std::optional<GroupChatRoom> GroupListModel::groupAt(int row) const {
    if (row >= 0 && row < m_groups.size()) {
        return m_groups[row];
    }
    return std::nullopt;
}

QVariantMap GroupListModel::getGroupAt(int row) const {
    QVariantMap map;
    auto g = groupAt(row);
    if (g) {
        map[QStringLiteral("id")] = g->id;
        map[QStringLiteral("name")] = g->name;
        map[QStringLiteral("description")] = g->description;
        map[QStringLiteral("avatarPath")] = g->avatarPath;
        map[QStringLiteral("speakerMode")] = speakerModeToString(g->speakerMode);
        map[QStringLiteral("memberCount")] = g->members.size();
    }
    return map;
}

int GroupListModel::indexOfId(const QString& id) const {
    for (int i = 0; i < m_groups.size(); ++i) {
        if (m_groups[i].id == id) return i;
    }
    return -1;
}

} // namespace Risu
