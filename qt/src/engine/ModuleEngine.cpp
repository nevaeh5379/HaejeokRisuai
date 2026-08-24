#include "ModuleEngine.hpp"
#include "../core/DatabaseManager.hpp"

#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <QSet>

namespace Risu {

static QJsonArray readJsonArraySetting(const QString& key) {
    const QString raw = DatabaseManager::instance().getSystemSetting(key, QString()).toString();
    if (raw.isEmpty()) return {};
    const QJsonDocument doc = QJsonDocument::fromJson(raw.toUtf8());
    return doc.isArray() ? doc.array() : QJsonArray{};
}

static void appendIds(QSet<QString>& ids, const QJsonArray& values) {
    for (const auto& value : values) {
        if (value.isString() && !value.toString().isEmpty()) ids.insert(value.toString());
    }
}

ActiveModuleData ModuleEngine::resolveActiveModules(
    const Character& character,
    const Chat& chat
) {
    ActiveModuleData result;
    QSet<QString> activeIds;
    appendIds(activeIds, readJsonArraySetting(QStringLiteral("enabledModules")));
    if (character.rawData.value(QStringLiteral("modules")).isArray()) {
        appendIds(activeIds, character.rawData.value(QStringLiteral("modules")).toArray());
    }
    for (const auto& moduleId : chat.modules) {
        if (!moduleId.isEmpty()) activeIds.insert(moduleId);
    }

    const QString integration = DatabaseManager::instance()
        .getSystemSetting(QStringLiteral("moduleIntergration"), QString()).toString();
    for (const auto& moduleId : integration.split(QLatin1Char(','), Qt::SkipEmptyParts)) {
        activeIds.insert(moduleId.trimmed());
    }

    if (activeIds.isEmpty()) return result;

    const QJsonArray modules = readJsonArraySetting(QStringLiteral("modules"));
    for (const auto& value : modules) {
        if (!value.isObject()) continue;
        const QJsonObject module = value.toObject();
        const QString id = module.value(QStringLiteral("id")).toString();
        const QString moduleNamespace = module.value(QStringLiteral("namespace")).toString();
        if (!activeIds.contains(id) && (moduleNamespace.isEmpty() || !activeIds.contains(moduleNamespace))) {
            continue;
        }
        QJsonValue loreValue = module.value(QStringLiteral("lorebook"));
        if (!loreValue.isArray()) loreValue = module.value(QStringLiteral("lorebooks"));
        if (loreValue.isArray()) {
            for (const auto& loreItem : loreValue.toArray()) {
                if (!loreItem.isObject()) continue;
                result.lorebooks.append(LorebookEntry::fromJson(loreItem.toObject()));
            }
        }

        const QJsonValue regexValue = module.value(QStringLiteral("regex"));
        if (regexValue.isArray()) {
            for (const auto& regexItem : regexValue.toArray()) {
                if (!regexItem.isObject()) continue;
                result.regexScripts.append(RegexScript::fromJson(regexItem.toObject()));
            }
        }
    }

    return result;
}

} // namespace Risu
