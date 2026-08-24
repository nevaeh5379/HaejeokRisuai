#pragma once

#include <QString>
#include <QList>
#include <QJsonObject>
#include <QJsonArray>
#include <QJSEngine>
#include <QJSValue>
#include <memory>
#include "../core/Types.hpp"

namespace Risu {

struct PluginInfo {
    QString id;
    QString name;
    QString description;
    QString version;
    QString author;
    bool enabled = true;
    QString script;

    QJsonObject toJson() const {
        QJsonObject obj;
        obj[QStringLiteral("id")] = id;
        obj[QStringLiteral("name")] = name;
        obj[QStringLiteral("description")] = description;
        obj[QStringLiteral("version")] = version;
        obj[QStringLiteral("author")] = author;
        obj[QStringLiteral("enabled")] = enabled;
        obj[QStringLiteral("script")] = script;
        return obj;
    }

    static PluginInfo fromJson(const QJsonObject& obj) {
        PluginInfo p;
        p.id = obj.value(QStringLiteral("id")).toString();
        p.name = obj.value(QStringLiteral("name")).toString();
        p.description = obj.value(QStringLiteral("description")).toString();
        p.version = obj.value(QStringLiteral("version")).toString(QStringLiteral("1.0.0"));
        p.author = obj.value(QStringLiteral("author")).toString();
        p.enabled = obj.value(QStringLiteral("enabled")).toBool(true);
        p.script = obj.value(QStringLiteral("script")).toString();
        return p;
    }
};

class PluginEngine {
public:
    static PluginEngine& instance();

    void registerPlugin(const PluginInfo& plugin);
    void unregisterPlugin(const QString& pluginId);
    void setPluginEnabled(const QString& pluginId, bool enabled);
    QList<PluginInfo> plugins() const;
    PluginInfo getPlugin(const QString& pluginId) const;

    QString applyPreRequestHooks(
        const QString& rawPrompt,
        Chat& chat,
        const Character& character,
        const Persona& persona
    );

    QString applyPostResponseHooks(
        const QString& rawResponse,
        Chat& chat,
        const Character& character
    );

    void clear();

private:
    PluginEngine();
    QList<PluginInfo> m_plugins;
};

} // namespace Risu
