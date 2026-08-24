#include "CharacterCardIO.hpp"
#include "../core/AppConfig.hpp"
#include <QFile>
#include <QFileInfo>
#include <QDir>
#include <QImage>
#include <QBuffer>
#include <QDebug>

namespace Risu {

// Table-based CRC32
quint32 CharacterCardIO::calculateCrc32(const QByteArray& data) {
    static quint32 crcTable[256];
    static bool tableInitialized = false;

    if (!tableInitialized) {
        for (quint32 i = 0; i < 256; ++i) {
            quint32 c = i;
            for (int j = 0; j < 8; ++j) {
                if (c & 1) {
                    c = 0xEDB88320L ^ (c >> 1);
                } else {
                    c >>= 1;
                }
            }
            crcTable[i] = c;
        }
        tableInitialized = true;
    }

    quint32 c = 0xFFFFFFFFL;
    const unsigned char* p = reinterpret_cast<const unsigned char*>(data.constData());
    int len = data.size();
    for (int i = 0; i < len; ++i) {
        c = crcTable[(c ^ p[i]) & 0xFF] ^ (c >> 8);
    }
    return c ^ 0xFFFFFFFFL;
}

QByteArray CharacterCardIO::extractPngTextChunk(const QByteArray& pngData, const QString& chunkKey) {
    if (pngData.size() < 8) return QByteArray();

    // Check PNG signature: \x89PNG\r\n\x1a\n
    static const char pngSig[] = { '\x89', 'P', 'N', 'G', '\r', '\n', '\x1a', '\n' };
    if (memcmp(pngData.constData(), pngSig, 8) != 0) {
        return QByteArray();
    }

    int pos = 8;
    int totalSize = pngData.size();

    while (pos + 12 <= totalSize) {
        quint32 length = (static_cast<quint8>(pngData[pos]) << 24) |
                         (static_cast<quint8>(pngData[pos + 1]) << 16) |
                         (static_cast<quint8>(pngData[pos + 2]) << 8) |
                         (static_cast<quint8>(pngData[pos + 3]));

        QByteArray type = pngData.mid(pos + 4, 4);

        if (type == "IEND") {
            break;
        }

        if (type == "tEXt" && pos + 8 + static_cast<int>(length) <= totalSize) {
            QByteArray chunkData = pngData.mid(pos + 8, length);
            int nullPos = chunkData.indexOf('\0');
            if (nullPos > 0) {
                QString key = QString::fromUtf8(chunkData.left(nullPos));
                if (key.compare(chunkKey, Qt::CaseInsensitive) == 0) {
                    return chunkData.mid(nullPos + 1);
                }
            }
        }

        pos += 12 + length;
    }

    return QByteArray();
}

QByteArray CharacterCardIO::embedPngTextChunk(const QByteArray& pngData, const QString& chunkKey, const QByteArray& textValue) {
    if (pngData.size() < 8) return pngData;

    QByteArray result;
    result.append(pngData.left(8)); // Header

    int pos = 8;
    int totalSize = pngData.size();
    bool inserted = false;

    // Prepare new chunk
    QByteArray keyUtf8 = chunkKey.toUtf8();
    QByteArray chunkPayload;
    chunkPayload.append(keyUtf8);
    chunkPayload.append('\0');
    chunkPayload.append(textValue);

    quint32 newChunkLen = chunkPayload.size();
    QByteArray newChunkHeader;
    newChunkHeader.append(static_cast<char>((newChunkLen >> 24) & 0xFF));
    newChunkHeader.append(static_cast<char>((newChunkLen >> 16) & 0xFF));
    newChunkHeader.append(static_cast<char>((newChunkLen >> 8) & 0xFF));
    newChunkHeader.append(static_cast<char>(newChunkLen & 0xFF));
    newChunkHeader.append("tEXt");

    QByteArray crcData;
    crcData.append("tEXt");
    crcData.append(chunkPayload);
    quint32 crc = calculateCrc32(crcData);

    QByteArray newChunkCrc;
    newChunkCrc.append(static_cast<char>((crc >> 24) & 0xFF));
    newChunkCrc.append(static_cast<char>((crc >> 16) & 0xFF));
    newChunkCrc.append(static_cast<char>((crc >> 8) & 0xFF));
    newChunkCrc.append(static_cast<char>(crc & 0xFF));

    while (pos + 12 <= totalSize) {
        quint32 length = (static_cast<quint8>(pngData[pos]) << 24) |
                         (static_cast<quint8>(pngData[pos + 1]) << 16) |
                         (static_cast<quint8>(pngData[pos + 2]) << 8) |
                         (static_cast<quint8>(pngData[pos + 3]));

        QByteArray type = pngData.mid(pos + 4, 4);

        if (type == "IEND") {
            if (!inserted) {
                // Insert our chunk right before IEND
                result.append(newChunkHeader);
                result.append(chunkPayload);
                result.append(newChunkCrc);
                inserted = true;
            }
            result.append(pngData.mid(pos, 12 + length));
            break;
        }

        // Skip existing tEXt chunks with the same key
        if (type == "tEXt") {
            QByteArray chunkData = pngData.mid(pos + 8, length);
            int nullPos = chunkData.indexOf('\0');
            if (nullPos > 0) {
                QString existingKey = QString::fromUtf8(chunkData.left(nullPos));
                if (existingKey.compare(chunkKey, Qt::CaseInsensitive) == 0 ||
                    existingKey == QStringLiteral("chara") ||
                    existingKey == QStringLiteral("ccv3")) {
                    pos += 12 + length;
                    continue;
                }
            }
        }

        result.append(pngData.mid(pos, 12 + length));
        pos += 12 + length;
    }

    return result;
}

std::optional<Character> CharacterCardIO::importFromFile(const QString& filePath) {
    QFileInfo fi(filePath);
    if (!fi.exists()) return std::nullopt;

    QString ext = fi.suffix().toLower();
    if (ext == QStringLiteral("png")) {
        return importFromPng(filePath);
    } else if (ext == QStringLiteral("json") || ext == QStringLiteral("risum") || ext == QStringLiteral("charx")) {
        QFile f(filePath);
        if (f.open(QIODevice::ReadOnly)) {
            QByteArray data = f.readAll();
            f.close();
            return importFromJson(data);
        }
    }
    return std::nullopt;
}

std::optional<Character> CharacterCardIO::importFromPng(const QString& pngFilePath) {
    QFile f(pngFilePath);
    if (!f.open(QIODevice::ReadOnly)) return std::nullopt;
    QByteArray pngData = f.readAll();
    f.close();

    // 1. Try 'ccv3' chunk (Character Card V3)
    QByteArray ccv3Raw = extractPngTextChunk(pngData, QStringLiteral("ccv3"));
    if (!ccv3Raw.isEmpty()) {
        QByteArray decoded = QByteArray::fromBase64(ccv3Raw);
        if (decoded.isEmpty()) decoded = ccv3Raw; // Try raw utf8 if not base64
        auto optChar = importFromJson(decoded, pngFilePath);
        if (optChar) return optChar;
    }

    // 2. Try 'chara' chunk (Character Card V2 / Tavern)
    QByteArray charaRaw = extractPngTextChunk(pngData, QStringLiteral("chara"));
    if (!charaRaw.isEmpty()) {
        QByteArray decoded = QByteArray::fromBase64(charaRaw);
        if (decoded.isEmpty()) decoded = charaRaw;
        auto optChar = importFromJson(decoded, pngFilePath);
        if (optChar) return optChar;
    }

    return std::nullopt;
}

std::optional<Character> CharacterCardIO::importFromJson(const QByteArray& jsonData, const QString& avatarPath) {
    QJsonParseError err;
    QJsonDocument doc = QJsonDocument::fromJson(jsonData, &err);
    if (doc.isNull() || !doc.isObject()) {
        qWarning() << "Failed to parse Character JSON:" << err.errorString();
        return std::nullopt;
    }

    QJsonObject root = doc.object();
    Character c;
    c.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    c.lastInteraction = QDateTime::currentMSecsSinceEpoch();

    // Check if it's CCv2 or CCv3 with spec & data wrapper
    if (root.contains(QStringLiteral("spec")) && root.contains(QStringLiteral("data")) && root.value(QStringLiteral("data")).isObject()) {
        QJsonObject data = root.value(QStringLiteral("data")).toObject();
        c.name = data.value(QStringLiteral("name")).toString();
        c.description = data.value(QStringLiteral("description")).toString();
        c.personality = data.value(QStringLiteral("personality")).toString();
        c.scenario = data.value(QStringLiteral("scenario")).toString();
        c.firstMessage = data.value(QStringLiteral("first_mes")).toString();
        c.exampleMessage = data.value(QStringLiteral("mes_example")).toString();
        c.creatorNotes = data.value(QStringLiteral("creator_notes")).toString();
        c.systemPrompt = data.value(QStringLiteral("system_prompt")).toString();
        c.postHistoryInstructions = data.value(QStringLiteral("post_history_instructions")).toString();
        c.creator = data.value(QStringLiteral("creator")).toString();
        c.characterVersion = data.value(QStringLiteral("character_version")).toString();

        if (data.contains(QStringLiteral("alternate_greetings")) && data.value(QStringLiteral("alternate_greetings")).isArray()) {
            QJsonArray altArr = data.value(QStringLiteral("alternate_greetings")).toArray();
            for (const auto& a : altArr) c.alternateGreetings.append(a.toString());
        }

        if (data.contains(QStringLiteral("tags")) && data.value(QStringLiteral("tags")).isArray()) {
            QJsonArray tagArr = data.value(QStringLiteral("tags")).toArray();
            for (const auto& t : tagArr) c.tags.append(t.toString());
        }

        // Lorebook in character_book
        if (data.contains(QStringLiteral("character_book")) && data.value(QStringLiteral("character_book")).isObject()) {
            QJsonObject book = data.value(QStringLiteral("character_book")).toObject();
            if (book.contains(QStringLiteral("entries")) && book.value(QStringLiteral("entries")).isArray()) {
                QJsonArray entArr = book.value(QStringLiteral("entries")).toArray();
                for (const auto& entItem : entArr) {
                    QJsonObject entObj = entItem.toObject();
                    LorebookEntry l;
                    l.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
                    l.comment = entObj.value(QStringLiteral("comment")).toString();
                    l.content = entObj.value(QStringLiteral("content")).toString();
                    l.insertOrder = entObj.value(QStringLiteral("insertion_order")).toInt(100);
                    l.enabled = entObj.value(QStringLiteral("enabled")).toBool(true);

                    // Keys
                    if (entObj.value(QStringLiteral("keys")).isArray()) {
                        QStringList kList;
                        for (const auto& k : entObj.value(QStringLiteral("keys")).toArray()) kList.append(k.toString());
                        l.key = kList.join(QStringLiteral(", "));
                    } else {
                        l.key = entObj.value(QStringLiteral("key")).toString();
                    }

                    if (entObj.value(QStringLiteral("secondary_keys")).isArray()) {
                        QStringList kList;
                        for (const auto& k : entObj.value(QStringLiteral("secondary_keys")).toArray()) kList.append(k.toString());
                        l.secondKey = kList.join(QStringLiteral(", "));
                    } else {
                        l.secondKey = entObj.value(QStringLiteral("secondary_key")).toString();
                    }

                    c.globalLore.append(l);
                }
            }
        }

        // RisuAI extensions
        if (data.contains(QStringLiteral("extensions")) && data.value(QStringLiteral("extensions")).isObject()) {
            QJsonObject ext = data.value(QStringLiteral("extensions")).toObject();
            if (ext.contains(QStringLiteral("risuai")) && ext.value(QStringLiteral("risuai")).isObject()) {
                QJsonObject risu = ext.value(QStringLiteral("risuai")).toObject();
                if (risu.contains(QStringLiteral("customScripts")) && risu.value(QStringLiteral("customScripts")).isArray()) {
                    for (const auto& s : risu.value(QStringLiteral("customScripts")).toArray()) {
                        c.customScripts.append(RegexScript::fromJson(s.toObject()));
                    }
                }
            }
        }
    } else {
        // Direct Risu / Tavern format
        c = Character::fromJson(root);
    }

    // Save avatar image if provided
    if (!avatarPath.isEmpty() && QFile::exists(avatarPath)) {
        QString avatarDest = AppConfig::instance().avatarsDir() + QStringLiteral("/") + c.id + QStringLiteral(".png");
        QFile::copy(avatarPath, avatarDest);
        c.avatarPath = avatarDest;
    }

    // Ensure at least one chat
    if (c.chats.isEmpty()) {
        Chat defChat;
        defChat.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
        defChat.name = QStringLiteral("Main Chat");
        defChat.firstMessageIndex = 0;
        defChat.lastDate = c.lastInteraction;

        if (!c.firstMessage.isEmpty()) {
            Message m;
            m.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
            m.role = Role::Assistant;
            m.name = c.name;
            m.setCurrentContent(c.firstMessage);
            m.timestamp = c.lastInteraction;
            defChat.messages.append(m);
        }

        c.chats.append(defChat);
    }

    return c;
}

bool CharacterCardIO::exportToJsonFile(const Character& character, const QString& targetFilePath) {
    QJsonObject root = character.toJson();
    QJsonDocument doc(root);
    QFile f(targetFilePath);
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        f.write(doc.toJson(QJsonDocument::Indented));
        f.close();
        return true;
    }
    return false;
}

bool CharacterCardIO::exportToPngCard(const Character& character, const QString& targetFilePath, const QString& sourceImagePath) {
    QByteArray pngData;
    if (!sourceImagePath.isEmpty() && QFile::exists(sourceImagePath)) {
        QFile inF(sourceImagePath);
        if (inF.open(QIODevice::ReadOnly)) {
            pngData = inF.readAll();
            inF.close();
        }
    } else if (!character.avatarPath.isEmpty() && QFile::exists(character.avatarPath)) {
        QFile inF(character.avatarPath);
        if (inF.open(QIODevice::ReadOnly)) {
            pngData = inF.readAll();
            inF.close();
        }
    }

    // If no source PNG, generate a blank placeholder image
    if (pngData.isEmpty()) {
        QImage img(400, 600, QImage::Format_ARGB32);
        img.fill(QColor(30, 32, 48));
        QBuffer buffer(&pngData);
        buffer.open(QIODevice::WriteOnly);
        img.save(&buffer, "PNG");
    }

    // Build CCv2 JSON Spec
    QJsonObject root;
    root[QStringLiteral("spec")] = QStringLiteral("chara_card_v2");
    root[QStringLiteral("spec_version")] = QStringLiteral("2.0");

    QJsonObject data;
    data[QStringLiteral("name")] = character.name;
    data[QStringLiteral("description")] = character.description;
    data[QStringLiteral("personality")] = character.personality;
    data[QStringLiteral("scenario")] = character.scenario;
    data[QStringLiteral("first_mes")] = character.firstMessage;
    data[QStringLiteral("mes_example")] = character.exampleMessage;
    data[QStringLiteral("creator_notes")] = character.creatorNotes;
    data[QStringLiteral("system_prompt")] = character.systemPrompt;
    data[QStringLiteral("post_history_instructions")] = character.postHistoryInstructions;
    data[QStringLiteral("creator")] = character.creator;
    data[QStringLiteral("character_version")] = character.characterVersion;

    QJsonArray altArr;
    for (const auto& a : character.alternateGreetings) altArr.append(a);
    data[QStringLiteral("alternate_greetings")] = altArr;

    QJsonArray tagArr;
    for (const auto& t : character.tags) tagArr.append(t);
    data[QStringLiteral("tags")] = tagArr;

    // Character book
    if (!character.globalLore.isEmpty()) {
        QJsonObject book;
        QJsonArray entArr;
        for (const auto& l : character.globalLore) {
            QJsonObject ent;
            ent[QStringLiteral("comment")] = l.comment;
            ent[QStringLiteral("content")] = l.content;
            ent[QStringLiteral("insertion_order")] = l.insertOrder;
            ent[QStringLiteral("enabled")] = l.enabled;
            ent[QStringLiteral("key")] = l.key;
            ent[QStringLiteral("secondary_key")] = l.secondKey;
            entArr.append(ent);
        }
        book[QStringLiteral("entries")] = entArr;
        data[QStringLiteral("character_book")] = book;
    }

    root[QStringLiteral("data")] = data;

    QByteArray jsonBytes = QJsonDocument(root).toJson(QJsonDocument::Compact);
    QByteArray base64Json = jsonBytes.toBase64();

    QByteArray embeddedPng = embedPngTextChunk(pngData, QStringLiteral("chara"), base64Json);

    QFile outF(targetFilePath);
    if (outF.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        outF.write(embeddedPng);
        outF.close();
        return true;
    }

    return false;
}

} // namespace Risu
