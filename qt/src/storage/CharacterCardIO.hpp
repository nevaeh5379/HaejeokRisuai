#pragma once

#include <QString>
#include <QByteArray>
#include <optional>
#include "../core/Types.hpp"

namespace Risu {

class CharacterCardIO {
public:
    // Import character from file (PNG card, WebP card, or JSON card)
    static std::optional<Character> importFromFile(const QString& filePath);

    // Import from raw JSON string or bytes
    static std::optional<Character> importFromJson(const QByteArray& jsonData, const QString& avatarPath = QString());

    // Import from PNG with tEXt metadata ('chara' or 'ccv3')
    static std::optional<Character> importFromPng(const QString& pngFilePath);

    // Export character to JSON file
    static bool exportToJsonFile(const Character& character, const QString& targetFilePath);

    // Export character to PNG card file (embeds CCv2/CCv3 metadata into PNG tEXt chunk)
    static bool exportToPngCard(const Character& character, const QString& targetFilePath, const QString& sourceImagePath = QString());

    // Helper: extract PNG chunk text
    static QByteArray extractPngTextChunk(const QByteArray& pngData, const QString& chunkKey);

    // Helper: embed PNG text chunk
    static QByteArray embedPngTextChunk(const QByteArray& pngData, const QString& chunkKey, const QByteArray& textValue);

private:
    static quint32 calculateCrc32(const QByteArray& data);
};

} // namespace Risu
