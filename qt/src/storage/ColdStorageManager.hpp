#pragma once

#include <QString>
#include <QList>
#include <optional>
#include "../core/Types.hpp"

namespace Risu {

// Exact cold storage header constant from RisuAI (src/ts/process/coldstorageData.ts)
const QString COLD_STORAGE_HEADER = QStringLiteral("\uEF01COLDSTORAGE\uEF01");

class ColdStorageManager {
public:
    static ColdStorageManager& instance();

    // Directory path for cold storage files
    QString coldStorageDir() const;

    // Check if a chat is currently archived in cold storage
    bool isChatArchived(const Chat& chat) const;

    // Archive chat messages to compressed cold storage on disk and replace with placeholder
    bool archiveChat(Chat& chat);

    // Restore archived chat messages from cold storage on disk
    bool restoreChat(Chat& chat);

    // Low-level save/load of message arrays
    bool saveToColdStorage(const QString& key, const QList<Message>& messages);
    std::optional<QList<Message>> loadFromColdStorage(const QString& key);
    bool removeColdStorage(const QString& key);

private:
    ColdStorageManager();
};

} // namespace Risu
