#pragma once

#include <QString>
#include "../core/Types.hpp"

namespace Risu {

class ExportImport {
public:
    static bool exportFullBackup(const QString& targetFilePath);
    static bool importFullBackup(const QString& sourceFilePath);

    static bool exportChatToMarkdown(const Character& character, const Chat& chat, const QString& targetFilePath);
    static bool exportChatToHtml(const Character& character, const Chat& chat, const QString& targetFilePath);
    static bool exportChatToText(const Character& character, const Chat& chat, const QString& targetFilePath);
    static bool exportChatToJson(const Character& character, const Chat& chat, const QString& targetFilePath);
};

} // namespace Risu
