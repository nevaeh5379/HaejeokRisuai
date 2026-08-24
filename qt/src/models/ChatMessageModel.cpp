#include "ChatMessageModel.hpp"

namespace Risu {

ChatMessageModel::ChatMessageModel(QObject* parent) : QAbstractListModel(parent) {
}

int ChatMessageModel::rowCount(const QModelIndex& parent) const {
    if (parent.isValid()) return 0;
    return m_messages.size();
}

QVariant ChatMessageModel::data(const QModelIndex& index, int role) const {
    if (!index.isValid() || index.row() < 0 || index.row() >= m_messages.size()) {
        return QVariant();
    }

    const auto& m = m_messages[index.row()];
    switch (role) {
        case IdRole: return m.id;
        case RoleRole: return roleToString(m.role);
        case IsUserRole: return m.role == Role::User;
        case NameRole: return m.name;
        case ContentRole: return m.currentContent();
        case ThoughtRole: return m.currentThought();
        case TimestampRole: return m.timestamp;
        case FormattedTimeRole: {
            QDateTime dt = QDateTime::fromMSecsSinceEpoch(m.timestamp > 0 ? m.timestamp : QDateTime::currentMSecsSinceEpoch());
            return dt.toString(QStringLiteral("hh:mm AP"));
        }
        case CurrentSwipeIndexRole: return m.currentSwipeIndex;
        case SwipeCountRole: return m.swipes.size();
        case IsCommentRole: return m.isComment;
        case DisabledRole: return m.disabled;
        case IsPinnedRole: return m.isPinned;
        case EmotionRole: return m.emotion;
        case AttachmentPathRole: return m.attachmentPath;
        default: return QVariant();
    }
}

QHash<int, QByteArray> ChatMessageModel::roleNames() const {
    QHash<int, QByteArray> roles;
    roles[IdRole] = "msgId";
    roles[RoleRole] = "role";
    roles[IsUserRole] = "isUser";
    roles[NameRole] = "name";
    roles[ContentRole] = "content";
    roles[ThoughtRole] = "thought";
    roles[TimestampRole] = "timestamp";
    roles[FormattedTimeRole] = "formattedTime";
    roles[CurrentSwipeIndexRole] = "currentSwipeIndex";
    roles[SwipeCountRole] = "swipeCount";
    roles[IsCommentRole] = "isComment";
    roles[DisabledRole] = "disabled";
    roles[IsPinnedRole] = "isPinned";
    roles[EmotionRole] = "emotion";
    roles[AttachmentPathRole] = "attachmentPath";
    return roles;
}

void ChatMessageModel::setMessages(const QList<Message>& messages) {
    beginResetModel();
    m_messages = messages;
    endResetModel();
    emit countChanged();
}

void ChatMessageModel::appendMessage(const Message& msg) {
    int row = m_messages.size();
    beginInsertRows(QModelIndex(), row, row);
    m_messages.append(msg);
    endInsertRows();
    emit countChanged();
}

void ChatMessageModel::updateLastMessageChunk(const QString& textChunk, const QString& thoughtChunk) {
    if (m_messages.isEmpty()) return;

    int lastRow = m_messages.size() - 1;
    auto& lastMsg = m_messages[lastRow];

    QString curContent = lastMsg.currentContent() + textChunk;
    QString curThought = lastMsg.currentThought() + thoughtChunk;

    lastMsg.setCurrentContent(curContent, curThought);

    QModelIndex idx = index(lastRow, 0);
    emit dataChanged(idx, idx, {ContentRole, ThoughtRole});
    emit messageUpdated(lastRow);
}

void ChatMessageModel::finalizeLastMessage(const QString& fullResponse, const QString& thought, int inTok, int outTok) {
    if (m_messages.isEmpty()) return;

    int lastRow = m_messages.size() - 1;
    auto& lastMsg = m_messages[lastRow];

    lastMsg.setCurrentContent(fullResponse, thought);
    if (!lastMsg.swipes.isEmpty() && lastMsg.currentSwipeIndex >= 0 && lastMsg.currentSwipeIndex < lastMsg.swipes.size()) {
        lastMsg.swipes[lastMsg.currentSwipeIndex].inputTokens = inTok;
        lastMsg.swipes[lastMsg.currentSwipeIndex].outputTokens = outTok;
    }

    QModelIndex idx = index(lastRow, 0);
    emit dataChanged(idx, idx, {ContentRole, ThoughtRole, TimestampRole, FormattedTimeRole});
    emit messageUpdated(lastRow);
}

void ChatMessageModel::editMessage(int row, const QString& newContent) {
    if (row < 0 || row >= m_messages.size()) return;

    m_messages[row].setCurrentContent(newContent);
    QModelIndex idx = index(row, 0);
    emit dataChanged(idx, idx, {ContentRole});
    emit messageUpdated(row);
}

void ChatMessageModel::removeMessageAt(int row) {
    if (row < 0 || row >= m_messages.size()) return;

    beginRemoveRows(QModelIndex(), row, row);
    m_messages.removeAt(row);
    endRemoveRows();
    emit countChanged();
}

void ChatMessageModel::swipeLeft(int row) {
    if (row < 0 || row >= m_messages.size()) return;

    auto& m = m_messages[row];
    if (m.currentSwipeIndex > 0) {
        m.currentSwipeIndex--;
        QModelIndex idx = index(row, 0);
        emit dataChanged(idx, idx, {ContentRole, ThoughtRole, CurrentSwipeIndexRole});
        emit messageUpdated(row);
    }
}

void ChatMessageModel::swipeRight(int row) {
    if (row < 0 || row >= m_messages.size()) return;

    auto& m = m_messages[row];
    if (m.currentSwipeIndex < m.swipes.size() - 1) {
        m.currentSwipeIndex++;
        QModelIndex idx = index(row, 0);
        emit dataChanged(idx, idx, {ContentRole, ThoughtRole, CurrentSwipeIndexRole});
        emit messageUpdated(row);
    }
}

void ChatMessageModel::addSwipeToMessage(int row, const QString& content, const QString& thought) {
    if (row < 0 || row >= m_messages.size()) return;

    m_messages[row].addSwipe(content, thought);
    QModelIndex idx = index(row, 0);
    emit dataChanged(idx, idx, {ContentRole, ThoughtRole, CurrentSwipeIndexRole, SwipeCountRole});
    emit messageUpdated(row);
}

void ChatMessageModel::togglePinned(int row) {
    if (row < 0 || row >= m_messages.size()) return;

    m_messages[row].isPinned = !m_messages[row].isPinned;
    QModelIndex idx = index(row, 0);
    emit dataChanged(idx, idx, {IsPinnedRole});
    emit messageUpdated(row);
}

void ChatMessageModel::setEmotion(int row, const QString& emotion) {
    if (row < 0 || row >= m_messages.size()) return;

    m_messages[row].emotion = emotion;
    QModelIndex idx = index(row, 0);
    emit dataChanged(idx, idx, {EmotionRole});
    emit messageUpdated(row);
}

void ChatMessageModel::clear() {
    beginResetModel();
    m_messages.clear();
    endResetModel();
    emit countChanged();
}

const Message& ChatMessageModel::messageAt(int row) const {
    static const Message s_emptyMsg;
    if (row >= 0 && row < m_messages.size()) {
        return m_messages[row];
    }
    return s_emptyMsg;
}

QVariantMap ChatMessageModel::get(int row) const {
    if (row < 0 || row >= m_messages.size()) {
        return QVariantMap();
    }
    const auto& m = m_messages[row];
    QVariantMap map;
    map[QStringLiteral("msgId")] = m.id;
    map[QStringLiteral("role")] = roleToString(m.role);
    map[QStringLiteral("isUser")] = (m.role == Role::User);
    map[QStringLiteral("name")] = m.name;
    map[QStringLiteral("content")] = m.currentContent();
    map[QStringLiteral("thought")] = m.currentThought();
    map[QStringLiteral("timestamp")] = m.timestamp;
    map[QStringLiteral("formattedTime")] = QDateTime::fromMSecsSinceEpoch(m.timestamp).toString(QStringLiteral("hh:mm AP"));
    map[QStringLiteral("currentSwipeIndex")] = m.currentSwipeIndex;
    map[QStringLiteral("swipeCount")] = m.swipes.size();
    map[QStringLiteral("isComment")] = m.isComment;
    map[QStringLiteral("disabled")] = m.disabled;
    map[QStringLiteral("isPinned")] = m.isPinned;
    map[QStringLiteral("emotion")] = m.emotion;
    map[QStringLiteral("attachmentPath")] = m.attachmentPath;
    return map;
}

} // namespace Risu
