#pragma once

#include <QAbstractListModel>
#include <QList>
#include <QDateTime>
#include "../core/Types.hpp"

namespace Risu {

class ChatMessageModel : public QAbstractListModel {
    Q_OBJECT
    Q_PROPERTY(int count READ rowCount NOTIFY countChanged)

public:
    enum MessageRoles {
        IdRole = Qt::UserRole + 1,
        RoleRole,
        IsUserRole,
        NameRole,
        ContentRole,
        ThoughtRole,
        TimestampRole,
        FormattedTimeRole,
        CurrentSwipeIndexRole,
        SwipeCountRole,
        IsCommentRole,
        DisabledRole,
        IsPinnedRole,
        EmotionRole,
        AttachmentPathRole
    };

    explicit ChatMessageModel(QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = QModelIndex()) const override;
    QVariant data(const QModelIndex& index, int role = Qt::DisplayRole) const override;
    QHash<int, QByteArray> roleNames() const override;

    void setMessages(const QList<Message>& messages);
    const QList<Message>& messages() const { return m_messages; }

    // Mutations
    void appendMessage(const Message& msg);
    void updateLastMessageChunk(const QString& textChunk, const QString& thoughtChunk);
    void finalizeLastMessage(const QString& fullResponse, const QString& thought, int inTok, int outTok);
    
    Q_INVOKABLE void editMessage(int row, const QString& newContent);
    Q_INVOKABLE void removeMessageAt(int row);
    Q_INVOKABLE void swipeLeft(int row);
    Q_INVOKABLE void swipeRight(int row);
    Q_INVOKABLE void togglePinned(int row);
    Q_INVOKABLE void setEmotion(int row, const QString& emotion);
    void addSwipeToMessage(int row, const QString& content, const QString& thought = QString());
    Q_INVOKABLE void clear();

    const Message& messageAt(int row) const;
    Q_INVOKABLE QVariantMap get(int row) const;

signals:
    void countChanged();
    void messageUpdated(int row);

private:
    QList<Message> m_messages;
};

} // namespace Risu
