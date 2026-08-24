#pragma once

#include <QList>
#include "../core/Types.hpp"

namespace Risu {

struct ActiveModuleData {
    QList<LorebookEntry> lorebooks;
    QList<RegexScript> regexScripts;
};

// Resolves Risu modules selected globally, per-character, and per-chat.
// Plugin/CJS execution intentionally remains outside this native compatibility layer.
class ModuleEngine {
public:
    static ActiveModuleData resolveActiveModules(
        const Character& character,
        const Chat& chat
    );
};

} // namespace Risu
