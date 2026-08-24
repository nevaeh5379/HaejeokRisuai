#include "LorebookListModel.hpp"

namespace Risu {

LorebookListModel::LorebookListModel(QObject* parent) : QAbstractListModel(parent) {
}

int LorebookListModel::rowCount(const QModelIndex& parent) const {
    if (parent.isValid()) return 0;
    return m_entries.size();
}

QVariant LorebookListModel::data(const QModelIndex& index, int role) const {
    if (!index.isValid() || index.row() < 0 || index.row() >= m_entries.size()) {
        return QVariant();
    }

    const auto& e = m_entries[index.row()];
    switch (role) {
        case IdRole: return e.id;
        case KeyRole: return e.key;
        case SecondKeyRole: return e.secondKey;
        case CommentRole: return e.comment;
        case ContentRole: return e.content;
        case ModeRole: return e.mode;
        case InsertOrderRole: return e.insertOrder;
        case AlwaysActiveRole: return e.alwaysActive;
        case SelectiveRole: return e.selective;
        case UseRegexRole: return e.useRegex;
        case CaseSensitiveRole: return e.caseSensitive;
        case ScanDepthRole: return e.scanDepth;
        case EnabledRole: return e.enabled;
        default: return QVariant();
    }
}

QHash<int, QByteArray> LorebookListModel::roleNames() const {
    QHash<int, QByteArray> roles;
    roles[IdRole] = "loreId";
    roles[KeyRole] = "key";
    roles[SecondKeyRole] = "secondKey";
    roles[CommentRole] = "comment";
    roles[ContentRole] = "content";
    roles[ModeRole] = "mode";
    roles[InsertOrderRole] = "insertOrder";
    roles[AlwaysActiveRole] = "alwaysActive";
    roles[SelectiveRole] = "selective";
    roles[UseRegexRole] = "useRegex";
    roles[CaseSensitiveRole] = "caseSensitive";
    roles[ScanDepthRole] = "scanDepth";
    roles[EnabledRole] = "enabled";
    return roles;
}

void LorebookListModel::setEntries(const QList<LorebookEntry>& entries) {
    beginResetModel();
    m_entries = entries;
    endResetModel();
    emit countChanged();
}

std::optional<LorebookEntry> LorebookListModel::entryAt(int row) const {
    if (row >= 0 && row < m_entries.size()) {
        return m_entries[row];
    }
    return std::nullopt;
}

int LorebookListModel::indexOfId(const QString& id) const {
    for (int i = 0; i < m_entries.size(); ++i) {
        if (m_entries[i].id == id) return i;
    }
    return -1;
}

QVariantMap LorebookListModel::getEntryAt(int row) const {
    QVariantMap map;
    if (row >= 0 && row < m_entries.size()) {
        const auto& e = m_entries[row];
        map[QStringLiteral("id")] = e.id;
        map[QStringLiteral("key")] = e.key;
        map[QStringLiteral("secondKey")] = e.secondKey;
        map[QStringLiteral("comment")] = e.comment;
        map[QStringLiteral("content")] = e.content;
        map[QStringLiteral("mode")] = e.mode;
        map[QStringLiteral("insertOrder")] = e.insertOrder;
        map[QStringLiteral("alwaysActive")] = e.alwaysActive;
        map[QStringLiteral("selective")] = e.selective;
        map[QStringLiteral("useRegex")] = e.useRegex;
        map[QStringLiteral("caseSensitive")] = e.caseSensitive;
        map[QStringLiteral("scanDepth")] = e.scanDepth;
        map[QStringLiteral("enabled")] = e.enabled;
    }
    return map;
}

} // namespace Risu
