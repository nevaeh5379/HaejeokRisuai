#pragma once

#include <QString>
#include <QList>
#include <QPair>
#include "../core/Types.hpp"

namespace Risu {

struct CompiledPromptMessage {
    QString role;     // "system", "user", "assistant"
    QString content;
    QString name;
};

struct TokenBreakdown {
    int systemTokens = 0;
    int lorebookTokens = 0;
    int historyTokens = 0;
    int authorNoteTokens = 0;
    int totalTokens = 0;
};

struct CompiledPrompt {
    QList<CompiledPromptMessage> messages;
    int estimatedTokens = 0;
    TokenBreakdown breakdown;
    QString systemPromptCombined;
    QString authorNoteText;
};

class PromptEngine {
public:
    static CompiledPrompt buildPrompt(
        const Character& character,
        const Chat& chat,
        const Preset& preset,
        const Persona& persona,
        const QList<LorebookEntry>& globalLorebooks,
        const QString& extraUserMessage = QString()
    );

    static QString replaceMacros(
        const QString& text,
        const Character& character,
        const Persona& persona,
        const Chat* chat = nullptr,
        const Preset* preset = nullptr
    );

    static QString scanAndInjectLorebooks(
        const QList<LorebookEntry>& lorebooks,
        const QList<Message>& messages,
        const Character& character,
        const Persona& persona,
        const Chat* chat = nullptr
    );
};

} // namespace Risu
