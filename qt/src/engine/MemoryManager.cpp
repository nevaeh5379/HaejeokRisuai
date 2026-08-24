#include "MemoryManager.hpp"
#include "Tokenizer.hpp"
#include <QDateTime>

namespace Risu {

QString MemoryManager::buildSummaryPrompt(
    const QList<Message>& messages,
    int startIdx,
    int endIdx,
    const QString& charName,
    const QString& userName
) {
    QString dialogue;
    int from = qMax(0, startIdx);
    int to = qMin(messages.size() - 1, endIdx);

    for (int i = from; i <= to; ++i) {
        const auto& m = messages[i];
        if (m.disabled) continue;
        QString sender = m.name.isEmpty() ? (m.role == Role::User ? userName : charName) : m.name;
        dialogue += QStringLiteral("[%1]: %2\n").arg(sender, m.currentContent());
    }

    QString prompt = QStringLiteral(
        "Summarize the following conversation history concisely in 2-4 sentences, preserving key events, relationships, established facts, and emotional shifts.\n\n"
        "=== Conversation to Summarize ===\n%1\n\n"
        "=== Summary Output ==="
    ).arg(dialogue);

    return prompt;
}

QString MemoryManager::formatMemoryForPrompt(const QString& rawSummary) {
    if (rawSummary.trimmed().isEmpty()) return QString();
    return QStringLiteral("[Summary of previous events:\n%1\n]").arg(rawSummary.trimmed());
}

bool MemoryManager::shouldSummarize(const Chat& chat, int maxMessagesThreshold, int tokenThreshold) {
    if (chat.messages.size() < maxMessagesThreshold) return false;

    int totalTokens = 0;
    for (const auto& m : chat.messages) {
        totalTokens += Tokenizer::estimateTokens(m.currentContent());
        if (totalTokens >= tokenThreshold) return true;
    }

    return false;
}

} // namespace Risu
