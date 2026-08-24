#include "ArchivePacker.hpp"
#include "../core/AppConfig.hpp"
#include <QFile>
#include <QFileInfo>
#include <QDir>
#include <QDataStream>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QDebug>

namespace Risu {

static const quint32 ARCHIVE_MAGIC = 0x52495355; // 'RISU'
static const quint32 ARCHIVE_VERSION = 1;

QByteArray ArchivePacker::packToBundle(
    const Character& character,
    const QList<LorebookEntry>& lorebooks
) {
    QByteArray result;
    QDataStream out(&result, QIODevice::WriteOnly);
    out.setVersion(QDataStream::Qt_6_5);

    // Write header
    out << ARCHIVE_MAGIC;
    out << ARCHIVE_VERSION;

    // 1. Character JSON
    QJsonObject charJson = character.toJson();
    QByteArray charJsonBytes = QJsonDocument(charJson).toJson(QJsonDocument::Compact);
    out << qCompress(charJsonBytes);

    // 2. Avatar Image Data
    QByteArray avatarBytes;
    if (!character.avatarPath.isEmpty()) {
        QFile avFile(character.avatarPath);
        if (avFile.open(QIODevice::ReadOnly)) {
            avatarBytes = avFile.readAll();
        }
    }
    out << avatarBytes;

    // 3. Emotion Sprites
    QMap<QString, QByteArray> emotionBytesMap;
    for (auto it = character.emotionSprites.begin(); it != character.emotionSprites.end(); ++it) {
        QFile emoFile(it.value());
        if (emoFile.open(QIODevice::ReadOnly)) {
            emotionBytesMap[it.key()] = emoFile.readAll();
        }
    }
    out << emotionBytesMap;

    // 4. Lorebooks JSON
    QJsonArray loreArray;
    for (const auto& lb : lorebooks) {
        loreArray.append(lb.toJson());
    }
    QByteArray loreBytes = QJsonDocument(loreArray).toJson(QJsonDocument::Compact);
    out << qCompress(loreBytes);

    return result;
}

std::optional<CharacterArchiveBundle> ArchivePacker::unpackFromBundle(const QByteArray& bundleData) {
    if (bundleData.size() < 8) return std::nullopt;

    QDataStream in(bundleData);
    in.setVersion(QDataStream::Qt_6_5);

    quint32 magic = 0;
    quint32 version = 0;
    in >> magic;
    in >> version;

    if (magic != ARCHIVE_MAGIC || version > ARCHIVE_VERSION) {
        qWarning() << "[ArchivePacker] Invalid magic or unsupported version:" << magic << version;
        return std::nullopt;
    }

    CharacterArchiveBundle bundle;

    // 1. Character JSON
    QByteArray compressedCharJson;
    in >> compressedCharJson;
    QByteArray charJsonBytes = qUncompress(compressedCharJson);
    QJsonDocument charDoc = QJsonDocument::fromJson(charJsonBytes);
    if (!charDoc.isObject()) {
        qWarning() << "[ArchivePacker] Corrupted character JSON in bundle";
        return std::nullopt;
    }
    bundle.character = Character::fromJson(charDoc.object());

    // 2. Avatar Image Data
    in >> bundle.avatarData;

    // 3. Emotion Sprites
    in >> bundle.emotionSprites;

    // 4. Lorebooks JSON
    QByteArray compressedLore;
    in >> compressedLore;
    if (!compressedLore.isEmpty()) {
        QByteArray loreBytes = qUncompress(compressedLore);
        QJsonDocument loreDoc = QJsonDocument::fromJson(loreBytes);
        if (loreDoc.isArray()) {
            QJsonArray arr = loreDoc.array();
            for (const auto& val : arr) {
                if (val.isObject()) {
                    bundle.lorebooks.append(LorebookEntry::fromJson(val.toObject()));
                }
            }
        }
    }

    return bundle;
}

bool ArchivePacker::saveBundleToFile(
    const QString& filePath,
    const Character& character,
    const QList<LorebookEntry>& lorebooks
) {
    QByteArray data = packToBundle(character, lorebooks);
    if (data.isEmpty()) return false;

    QFile file(filePath);
    if (!file.open(QIODevice::WriteOnly)) {
        qWarning() << "[ArchivePacker] Failed to write bundle to:" << filePath;
        return false;
    }

    file.write(data);
    file.close();
    return true;
}

std::optional<CharacterArchiveBundle> ArchivePacker::loadBundleFromFile(const QString& filePath) {
    QFile file(filePath);
    if (!file.open(QIODevice::ReadOnly)) {
        qWarning() << "[ArchivePacker] Failed to open bundle file:" << filePath;
        return std::nullopt;
    }

    QByteArray data = file.readAll();
    file.close();

    return unpackFromBundle(data);
}

} // namespace Risu
