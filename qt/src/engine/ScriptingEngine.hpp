#pragma once

#include <QString>
#include <QVariantMap>
#include <QJSEngine>
#include "../core/Types.hpp"

namespace Risu {

class ScriptingEngine {
public:
    static QString evaluateExpression(
        const QString& jsCode,
        Chat& chat,
        const Character& character,
        const Persona& user
    );

    static QString processScriptBlocks(
        const QString& text,
        Chat& chat,
        const Character& character,
        const Persona& user
    );
};

} // namespace Risu
