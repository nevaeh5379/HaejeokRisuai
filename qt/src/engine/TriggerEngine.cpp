#include "TriggerEngine.hpp"
#include <QRegularExpression>
#include <QUuid>

namespace Risu {

QJsonObject TriggerRule::toJson() const {
    QJsonObject obj;
    obj[QStringLiteral("id")] = id;
    obj[QStringLiteral("name")] = name;
    obj[QStringLiteral("enabled")] = enabled;
    obj[QStringLiteral("eventType")] = static_cast<int>(eventType);
    obj[QStringLiteral("conditionKeyword")] = conditionKeyword;
    obj[QStringLiteral("actionType")] = static_cast<int>(actionType);
    obj[QStringLiteral("targetKey")] = targetKey;
    obj[QStringLiteral("targetValue")] = targetValue;
    return obj;
}

TriggerRule TriggerRule::fromJson(const QJsonObject& json) {
    TriggerRule r;
    r.id = json.value(QStringLiteral("id")).toString(QUuid::createUuid().toString(QUuid::WithoutBraces));
    r.name = json.value(QStringLiteral("name")).toString(QStringLiteral("Trigger Rule"));
    r.enabled = json.value(QStringLiteral("enabled")).toBool(true);
    r.eventType = static_cast<TriggerEventType>(json.value(QStringLiteral("eventType")).toInt(0));
    r.conditionKeyword = json.value(QStringLiteral("conditionKeyword")).toString();
    r.actionType = static_cast<TriggerActionType>(json.value(QStringLiteral("actionType")).toInt(0));
    r.targetKey = json.value(QStringLiteral("targetKey")).toString();
    r.targetValue = json.value(QStringLiteral("targetValue")).toString();
    return r;
}

bool TriggerEngine::evaluateCondition(const TriggerRule& rule, const QString& contextText) {
    if (!rule.enabled) return false;
    if (rule.conditionKeyword.trimmed().isEmpty()) return true;

    // Try regex match first
    QRegularExpression re(rule.conditionKeyword, QRegularExpression::CaseInsensitiveOption);
    if (re.isValid()) {
        return re.match(contextText).hasMatch();
    }

    return contextText.contains(rule.conditionKeyword, Qt::CaseInsensitive);
}

void TriggerEngine::executeTriggers(
    TriggerEventType event,
    const QString& contextText,
    const QList<TriggerRule>& rules,
    Chat& chat,
    QString& outSystemInjection,
    QString& outModifiedText
) {
    outModifiedText = contextText;

    for (const auto& rule : rules) {
        if (!rule.enabled || rule.eventType != event) continue;

        if (evaluateCondition(rule, contextText)) {
            switch (rule.actionType) {
                case TriggerActionType::SetVariable: {
                    if (!rule.targetKey.isEmpty()) {
                        chat.chatVariables[rule.targetKey] = rule.targetValue;
                    }
                    break;
                }
                case TriggerActionType::InjectSystemPrompt: {
                    if (!rule.targetValue.isEmpty()) {
                        if (!outSystemInjection.isEmpty()) outSystemInjection += QStringLiteral("\n");
                        outSystemInjection += rule.targetValue;
                    }
                    break;
                }
                case TriggerActionType::InjectMessage: {
                    if (!rule.targetValue.isEmpty()) {
                        Message m;
                        m.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
                        m.role = Role::System;
                        m.name = QStringLiteral("System");
                        m.setCurrentContent(rule.targetValue);
                        m.timestamp = QDateTime::currentMSecsSinceEpoch();
                        chat.messages.append(m);
                    }
                    break;
                }
                case TriggerActionType::ModifyResponse: {
                    if (!rule.targetKey.isEmpty() && !rule.targetValue.isEmpty()) {
                        outModifiedText.replace(rule.targetKey, rule.targetValue);
                    }
                    break;
                }
                case TriggerActionType::PlaySound:
                default:
                    break;
            }
        }
    }
}

} // namespace Risu
