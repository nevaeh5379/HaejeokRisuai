#include "ScriptingEngine.hpp"
#include <QRegularExpression>
#include <QJSValue>
#include <QRandomGenerator>
#include <QDebug>

namespace Risu {

QString ScriptingEngine::evaluateExpression(
    const QString& jsCode,
    Chat& chat,
    const Character& character,
    const Persona& user
) {
    QJSEngine engine;

    // Expose Variables Object
    QJSValue varObj = engine.newObject();
    for (auto it = chat.chatVariables.begin(); it != chat.chatVariables.end(); ++it) {
        varObj.setProperty(it.key(), engine.toScriptValue(it.value()));
    }
    engine.globalObject().setProperty(QStringLiteral("vars"), varObj);

    // Expose Character Object
    QJSValue charObj = engine.newObject();
    charObj.setProperty(QStringLiteral("name"), character.name);
    charObj.setProperty(QStringLiteral("description"), character.description);
    charObj.setProperty(QStringLiteral("personality"), character.personality);
    engine.globalObject().setProperty(QStringLiteral("char"), charObj);

    // Expose User Object
    QJSValue userObj = engine.newObject();
    userObj.setProperty(QStringLiteral("name"), user.name);
    userObj.setProperty(QStringLiteral("description"), user.description);
    engine.globalObject().setProperty(QStringLiteral("user"), userObj);

    // Expose helper functions in JS
    engine.evaluate(
        QStringLiteral(
            "function getvar(k, defVal) { return (vars && vars[k] !== undefined) ? vars[k] : (defVal !== undefined ? defVal : ''); }\n"
            "function setvar(k, v) { if (!vars) vars = {}; vars[k] = v; return v; }\n"
            "function roll(min, max) { if (max === undefined) { max = min; min = 1; } return Math.floor(Math.random() * (max - min + 1)) + min; }\n"
        )
    );

    QJSValue result = engine.evaluate(jsCode);

    // Sync updated vars back to chat
    QJSValue varKeys = engine.evaluate(QStringLiteral("Object.keys(vars)"));
    if (varKeys.isArray()) {
        quint32 len = varKeys.property(QStringLiteral("length")).toUInt();
        QJSValue updatedVars = engine.globalObject().property(QStringLiteral("vars"));
        for (quint32 i = 0; i < len; ++i) {
            QString key = varKeys.property(i).toString();
            chat.chatVariables[key] = updatedVars.property(key).toString();
        }
    }

    if (result.isError()) {
        qWarning() << "JS Evaluation error:" << result.toString();
        return QString();
    }

    if (result.isUndefined() || result.isNull()) {
        return QString();
    }

    return result.toString();
}

QString ScriptingEngine::processScriptBlocks(
    const QString& text,
    Chat& chat,
    const Character& character,
    const Persona& user
) {
    QString output = text;

    // Matches {{eval: ... }} or {{js: ... }}
    static const QRegularExpression evalRegex(QStringLiteral(R"(\{\{(?:eval|js):([\s\S]*?)\}\})"));
    auto it = evalRegex.globalMatch(output);

    // To replace cleanly without offset drift, collect replacements in reverse
    struct Replacement {
        int start;
        int length;
        QString val;
    };
    QList<Replacement> reps;

    while (it.hasNext()) {
        auto match = it.next();
        QString jsCode = match.captured(1).trimmed();
        QString resultStr = evaluateExpression(jsCode, chat, character, user);
        reps.append({static_cast<int>(match.capturedStart()), static_cast<int>(match.capturedLength()), resultStr});
    }

    for (int i = reps.size() - 1; i >= 0; --i) {
        output.replace(reps[i].start, reps[i].length, reps[i].val);
    }

    return output;
}

} // namespace Risu
