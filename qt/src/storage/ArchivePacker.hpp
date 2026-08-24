#pragma once

#include <QString>
#include <QByteArray>
#include <QMap>
#include <QList>
#include <optional>
#include "../core/Types.hpp"

namespace Risu {

struct CharacterArchiveBundle {
    Character character;
    QByteArray avatarData;
    QMap<QString, QByteArray> emotionSprites;
    QList<LorebookEntry> lorebooks;
};

class ArchivePacker {
public:
    // Pack character, avatar, emotions, and lorebooks into a unified portable binary payload (.risup / .charx bundle)
    static QByteArray packToBundle(
        const Character& character,
        const QList<LorebookEntry>& lorebooks = {}
    );

    // Unpack portable bundle payload into CharacterArchiveBundle
    static std::optional<CharacterArchiveBundle> unpackFromBundle(const QByteArray& bundleData);

    // Save bundle to file
    static bool saveBundleToFile(
        const QString& filePath,
        const Character& character,
        const QList<LorebookEntry>& lorebooks = {}
    );

    // Load bundle from file
    static std::optional<CharacterArchiveBundle> loadBundleFromFile(const QString& filePath);
};

} // namespace Risu
