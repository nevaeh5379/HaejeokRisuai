#pragma once

#include <QString>
#include <QList>
#include <QVariantMap>
#include <QJsonObject>
#include <QJsonArray>
#include "../core/Types.hpp"

namespace Risu {

enum class TriggerEventType {
    OnMessageSent,
    OnResponseReceived,
    OnChatOpened,
    OnKeywordMatched
};

enum class TriggerActionType {
    SetVariable,
    InjectSystemPrompt,
    InjectMessage,
    PlaySound,
    ModifyResponse
};

struct TriggerRule {
    QString id;
    QString name;
    bool enabled = true;
    TriggerEventType eventType = TriggerEventType::OnMessageSent;
    QString conditionKeyword; // e.g. regex or substring match
    TriggerActionType actionType = TriggerActionType::SetVariable;
    QString targetKey;        // variable name or key
    QString targetValue;      // variable value or content to inject

    QJsonObject toJson() const;
    static TriggerRule fromJson(const QJsonObject& json);
};

class TriggerEngine {
public:
    static bool evaluateCondition(const TriggerRule& rule, const QString& contextText);

    static void executeTriggers(
        TriggerEventType event,
        const QString& contextText,
        const QList<TriggerRule>& rules,
        Chat& chat,
        QString& outSystemInjection,
        QString& outModifiedText
    );
};

} // namespace Risu
