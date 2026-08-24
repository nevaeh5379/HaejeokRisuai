#include "PluginEngine.hpp"
#include <QDebug>

namespace Risu {

PluginEngine& PluginEngine::instance() {
    static PluginEngine inst;
    return inst;
}

PluginEngine::PluginEngine() {
}

void PluginEngine::registerPlugin(const PluginInfo& plugin) {
    for (int i = 0; i < m_plugins.size(); ++i) {
        if (m_plugins[i].id == plugin.id) {
            m_plugins[i] = plugin;
            return;
        }
    }
    m_plugins.append(plugin);
}

void PluginEngine::unregisterPlugin(const QString& pluginId) {
    for (int i = 0; i < m_plugins.size(); ++i) {
        if (m_plugins[i].id == pluginId) {
            m_plugins.removeAt(i);
            return;
        }
    }
}

void PluginEngine::setPluginEnabled(const QString& pluginId, bool enabled) {
    for (auto& p : m_plugins) {
        if (p.id == pluginId) {
            p.enabled = enabled;
            return;
        }
    }
}

QList<PluginInfo> PluginEngine::plugins() const {
    return m_plugins;
}

PluginInfo PluginEngine::getPlugin(const QString& pluginId) const {
    for (const auto& p : m_plugins) {
        if (p.id == pluginId) return p;
    }
    return PluginInfo{};
}

void PluginEngine::clear() {
    m_plugins.clear();
}

QString PluginEngine::applyPreRequestHooks(
    const QString& rawPrompt,
    Chat& chat,
    const Character& character,
    const Persona& persona
) {
    QString currentPrompt = rawPrompt;

    for (const auto& plugin : m_plugins) {
        if (!plugin.enabled || plugin.script.trimmed().isEmpty()) continue;

        QJSEngine engine;

        // Populate Character context
        QJSValue charObj = engine.newObject();
        charObj.setProperty(QStringLiteral("name"), character.name);
        charObj.setProperty(QStringLiteral("description"), character.description);
        engine.globalObject().setProperty(QStringLiteral("char"), charObj);

        // Populate User context
        QJSValue userObj = engine.newObject();
        userObj.setProperty(QStringLiteral("name"), persona.name);
        userObj.setProperty(QStringLiteral("description"), persona.description);
        engine.globalObject().setProperty(QStringLiteral("user"), userObj);

        // Populate Variables
        QJSValue varsObj = engine.newObject();
        for (auto it = chat.chatVariables.begin(); it != chat.chatVariables.end(); ++it) {
            varsObj.setProperty(it.key(), it.value());
        }
        engine.globalObject().setProperty(QStringLiteral("vars"), varsObj);

        // Expose helper functions in JS
        engine.evaluate(
            QStringLiteral(
                "function getvar(k, defVal) { return (vars && vars[k] !== undefined) ? vars[k] : (defVal !== undefined ? defVal : ''); }\n"
                "function setvar(k, v) { if (!vars) vars = {}; vars[k] = String(v); return v; }\n"
            )
        );

        // Evaluate Plugin Script
        QJSValue evalResult = engine.evaluate(plugin.script, plugin.name + QStringLiteral(".js"));
        if (evalResult.isError()) {
            qWarning() << "[PluginEngine] Error evaluating plugin script:" << plugin.name << evalResult.toString();
            continue;
        }

        // Call onPreRequest if defined
        QJSValue preFn = engine.globalObject().property(QStringLiteral("onPreRequest"));
        if (preFn.isCallable()) {
            QJSValueList args;
            args.append(currentPrompt);
            QJSValue hookResult = preFn.call(args);
            if (hookResult.isString()) {
                currentPrompt = hookResult.toString();
            }
        }

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
    }

    return currentPrompt;
}

QString PluginEngine::applyPostResponseHooks(
    const QString& rawResponse,
    Chat& chat,
    const Character& character
) {
    QString currentResponse = rawResponse;

    for (const auto& plugin : m_plugins) {
        if (!plugin.enabled || plugin.script.trimmed().isEmpty()) continue;

        QJSEngine engine;

        // Populate Character context
        QJSValue charObj = engine.newObject();
        charObj.setProperty(QStringLiteral("name"), character.name);
        charObj.setProperty(QStringLiteral("description"), character.description);
        engine.globalObject().setProperty(QStringLiteral("char"), charObj);

        // Populate Variables
        QJSValue varsObj = engine.newObject();
        for (auto it = chat.chatVariables.begin(); it != chat.chatVariables.end(); ++it) {
            varsObj.setProperty(it.key(), it.value());
        }
        engine.globalObject().setProperty(QStringLiteral("vars"), varsObj);

        // Expose helper functions in JS
        engine.evaluate(
            QStringLiteral(
                "function getvar(k, defVal) { return (vars && vars[k] !== undefined) ? vars[k] : (defVal !== undefined ? defVal : ''); }\n"
                "function setvar(k, v) { if (!vars) vars = {}; vars[k] = String(v); return v; }\n"
            )
        );

        // Evaluate Plugin Script
        QJSValue evalResult = engine.evaluate(plugin.script, plugin.name + QStringLiteral(".js"));
        if (evalResult.isError()) {
            qWarning() << "[PluginEngine] Error evaluating plugin script:" << plugin.name << evalResult.toString();
            continue;
        }

        // Call onPostResponse if defined
        QJSValue postFn = engine.globalObject().property(QStringLiteral("onPostResponse"));
        if (postFn.isCallable()) {
            QJSValueList args;
            args.append(currentResponse);
            QJSValue hookResult = postFn.call(args);
            if (hookResult.isString()) {
                currentResponse = hookResult.toString();
            }
        }

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
    }

    return currentResponse;
}

} // namespace Risu
