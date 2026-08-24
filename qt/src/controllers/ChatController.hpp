#pragma once

#include <QObject>
#include <QString>
#include <QStringList>
#include <memory>
#include "../core/Types.hpp"
#include "../models/ChatMessageModel.hpp"
#include "../network/AIProvider.hpp"

#include "../core/AppConfig.hpp"

namespace Risu {

class ChatController : public QObject {
    Q_OBJECT
    Q_PROPERTY(ChatMessageModel* messageModel READ messageModel CONSTANT)
    Q_PROPERTY(QString activeCharacterId READ activeCharacterId NOTIFY activeCharacterChanged)
    Q_PROPERTY(QString activeCharacterName READ activeCharacterName NOTIFY activeCharacterChanged)
    Q_PROPERTY(QString activeCharacterAvatar READ activeCharacterAvatar NOTIFY activeCharacterChanged)
    Q_PROPERTY(QString backgroundHTML READ backgroundHTML NOTIFY activeCharacterChanged)
    Q_PROPERTY(QString backgroundCSS READ backgroundCSS NOTIFY activeCharacterChanged)
    Q_PROPERTY(bool largePortrait READ largePortrait NOTIFY activeCharacterChanged)
    Q_PROPERTY(QString activePresetName READ activePresetName NOTIFY activePresetChanged)
    Q_PROPERTY(QString activePresetModel READ activePresetModel NOTIFY activePresetChanged)
    Q_PROPERTY(bool isGenerating READ isGenerating NOTIFY isGeneratingChanged)
    Q_PROPERTY(QString currentChatName READ currentChatName NOTIFY currentChatChanged)
    Q_PROPERTY(int currentChatIndex READ currentChatIndex NOTIFY currentChatChanged)
    Q_PROPERTY(QStringList chatNames READ chatNames NOTIFY chatListChanged)
    Q_PROPERTY(int tokenEstimate READ tokenEstimate NOTIFY tokenEstimateChanged)
    Q_PROPERTY(int estimatedPromptTokens READ tokenEstimate NOTIFY tokenEstimateChanged)
    Q_PROPERTY(int streamOutputTokens READ streamOutputTokens NOTIFY streamOutputTokensChanged)
    Q_PROPERTY(int systemTokens READ systemTokens NOTIFY tokenEstimateChanged)
    Q_PROPERTY(int lorebookTokens READ lorebookTokens NOTIFY tokenEstimateChanged)
    Q_PROPERTY(int historyTokens READ historyTokens NOTIFY tokenEstimateChanged)
    Q_PROPERTY(int authorNoteTokens READ authorNoteTokens NOTIFY tokenEstimateChanged)
    Q_PROPERTY(QString authorNote READ authorNote WRITE setAuthorNote NOTIFY authorNoteChanged)
    Q_PROPERTY(int authorNoteDepth READ authorNoteDepth WRITE setAuthorNoteDepth NOTIFY authorNoteChanged)

public:
    explicit ChatController(QObject* parent = nullptr);
    ~ChatController() override;

    ChatMessageModel* messageModel() { return &m_messageModel; }

    QString activeCharacterId() const { return m_activeChar.id; }
    QString activeCharacterName() const { return m_activeChar.name; }
    QString activeCharacterAvatar() const {
        QString resolved = AppConfig::instance().resolveAssetPath(m_activeChar.avatarPath);
        return resolved.isEmpty() ? m_activeChar.avatarPath : resolved;
    }
    QString backgroundHTML() const { return m_activeChar.backgroundHTML; }
    QString backgroundCSS() const { return m_activeChar.backgroundCSS; }
    bool largePortrait() const { return m_activeChar.largePortrait; }
    QString activePresetName() const { return m_activePreset.name; }
    QString activePresetModel() const { return m_activePreset.modelName; }
    bool isGenerating() const { return m_isGenerating; }
    QString currentChatName() const;
    int currentChatIndex() const { return m_activeChar.currentChatIndex; }
    QStringList chatNames() const;
    int tokenEstimate() const { return m_tokenEstimate; }
    int streamOutputTokens() const { return m_streamOutputTokens; }
    int systemTokens() const { return m_breakdown.systemTokens; }
    int lorebookTokens() const { return m_breakdown.lorebookTokens; }
    int historyTokens() const { return m_breakdown.historyTokens; }
    int authorNoteTokens() const { return m_breakdown.authorNoteTokens; }
    QString authorNote() const;
    int authorNoteDepth() const;

    void loadCharacter(const QString& characterId);
    void reloadPreset();

public slots:
    void sendMessage(const QString& userText, const QString& attachmentPath = QString());
    void regenerateLastMessage();
    void swipeLeft(int messageIndex);
    void swipeRight(int messageIndex);
    void editMessage(int messageIndex, const QString& newText);
    void deleteMessage(int messageIndex);
    void forkChat(int messageIndex);
    void clearCurrentChat();
    void clearChatMessages() { clearCurrentChat(); }
    void createNewChat(const QString& chatName = QString());
    void createNewChatSession(const QString& chatName = QString()) { createNewChat(chatName); }
    void switchChat(int chatIndex);
    void switchChatSession(int chatIndex) { switchChat(chatIndex); }
    void deleteChat(int chatIndex);
    void deleteChatSession(const QString& chatId);
    void deleteChatSession(int chatIndex) { deleteChat(chatIndex); }
    void cancelGeneration();
    void updateTokenEstimate(const QString& draftText = QString());

    void setAuthorNote(const QString& note);
    void setAuthorNoteDepth(int depth);
    void setChatAuthorNote(const QString& note, int depth) { setAuthorNote(note); setAuthorNoteDepth(depth); }
    void toggleMessagePin(int messageIndex);
    void setMessageEmotion(int messageIndex, const QString& emotion);
    bool exportChat(const QString& format, const QString& filePath);
    QVariantList searchMessages(const QString& query);
    QString getEmotionSprite(const QString& emotion) const;
    QString formatInChat(const QString& rawContent) const;
    QStringList availableEmotions() const;

signals:
    void activeCharacterChanged();
    void activePresetChanged();
    void isGeneratingChanged();
    void generationFinished(const QString& response);
    void currentChatChanged();
    void chatListChanged();
    void tokenEstimateChanged();
    void streamOutputTokensChanged();
    void authorNoteChanged();
    void errorOccurred(const QString& errorMessage);
    void toastRequested(const QString& type, const QString& message);

private slots:
    void onProviderChunkReceived(const QString& textChunk, const QString& thoughtChunk);
    void onProviderFinished(const QString& fullResponse, const QString& thought, int inTok, int outTok);
    void onProviderError(const QString& errorMessage);

private:
    void saveCurrentChatToDb();
    void startGeneration(const QString& userText = QString(), bool isRegenerate = false);

    Character m_activeChar;
    Preset m_activePreset;
    Persona m_activePersona;
    ChatMessageModel m_messageModel;
    std::unique_ptr<AIProvider> m_currentProvider;
    bool m_isGenerating = false;
    int m_tokenEstimate = 0;
    int m_streamOutputTokens = 0;
    TokenBreakdown m_breakdown;
    bool m_isRegenerating = false;
};

} // namespace Risu
