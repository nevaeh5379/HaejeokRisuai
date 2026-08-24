#pragma once

#include <QString>
#include <QList>
#include "../core/Types.hpp"

namespace Risu {

struct MemoryBlock {
    QString id;
    int startMessageIndex = 0;
    int endMessageIndex = 0;
    QString summaryText;
    qint64 timestamp = 0;
};

class MemoryManager {
public:
    // Generate prompt for AI summarizer
    static QString buildSummaryPrompt(const QList<Message>& messages, int startIdx, int endIdx, const QString& charName, const QString& userName);

    // Format memory block for insertion into prompt
    static QString formatMemoryForPrompt(const QString& rawSummary);

    // Evaluate whether the current chat requires summarization based on token count & message threshold
    static bool shouldSummarize(const Chat& chat, int maxMessagesThreshold = 20, int tokenThreshold = 4000);
};

} // namespace Risu
