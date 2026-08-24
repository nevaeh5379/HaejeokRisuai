#pragma once

#include <QObject>
#include <QString>
#include <QVariantMap>
#include "../core/Types.hpp"
#include "../models/GroupListModel.hpp"
#include "../models/ChatMessageModel.hpp"
#include "../network/AIProvider.hpp"

namespace Risu {

class GroupChatController : public QObject {
    Q_OBJECT

    Q_PROPERTY(GroupListModel* groupModel READ groupModel CONSTANT)
    Q_PROPERTY(ChatMessageModel* messageModel READ messageModel CONSTANT)
    Q_PROPERTY(QVariantMap activeGroup READ activeGroup NOTIFY activeGroupChanged)
    Q_PROPERTY(QString activeGroupId READ activeGroupId NOTIFY activeGroupChanged)
    Q_PROPERTY(bool isGenerating READ isGenerating NOTIFY isGeneratingChanged)
    Q_PROPERTY(QString currentSpeakerName READ currentSpeakerName NOTIFY currentSpeakerChanged)

public:
    explicit GroupChatController(QObject* parent = nullptr);
    ~GroupChatController() override = default;

    GroupListModel* groupModel() { return &m_groupModel; }
    ChatMessageModel* messageModel() { return &m_messageModel; }
    QVariantMap activeGroup() const;
    QString activeGroupId() const { return m_activeGroupId; }
    bool isGenerating() const { return m_isGenerating; }
    QString currentSpeakerName() const;

public slots:
    void refreshGroups();
    void selectGroup(const QString& groupId);
    QString createGroup(const QString& name, const QString& description = QString());
    bool saveGroupDetails(const QVariantMap& data);
    bool deleteGroup(const QString& groupId);

    void addCharacterToGroup(const QString& characterId);
    void removeCharacterFromGroup(const QString& characterId);
    void setSpeakerMode(const QString& mode);

    void sendMessage(const QString& userText);
    void cancelGeneration();

signals:
    void activeGroupChanged();
    void isGeneratingChanged();
    void currentSpeakerChanged();
    void toastRequested(const QString& type, const QString& message);

private slots:
    void onProviderChunkReceived(const QString& textChunk, const QString& thoughtChunk);
    void onProviderFinished(const QString& fullResponse, const QString& thought, int inTok, int outTok);
    void onProviderError(const QString& errorMessage);

private:
    Character determineNextSpeaker();
    void saveCurrentGroupChat();

    GroupListModel m_groupModel;
    ChatMessageModel m_messageModel;
    QString m_activeGroupId;
    GroupChatRoom m_activeGroup;
    bool m_isGenerating = false;
    std::unique_ptr<AIProvider> m_currentProvider;
    Character m_currentSpeakingChar;
};

} // namespace Risu
