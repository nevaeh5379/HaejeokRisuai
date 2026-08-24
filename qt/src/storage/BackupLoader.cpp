#include "BackupLoader.hpp"
#include "../core/AppConfig.hpp"
#include "../core/DatabaseManager.hpp"
#include "../core/Types.hpp"

#include <QFile>
#include <QFileInfo>
#include <QDir>
#include <QDebug>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <fstream>
#include <vector>
#include <zlib.h>
#include <nlohmann/json.hpp>

namespace Risu {

static std::vector<uint8_t> decompressGzip(const uint8_t* data, size_t size) {
    if (!data || size == 0) return {};

    z_stream strm = {};
    // 16 + MAX_WBITS handles gzip header; 32 + MAX_WBITS handles either zlib or gzip header
    if (inflateInit2(&strm, 32 + MAX_WBITS) != Z_OK) {
        if (inflateInit(&strm) != Z_OK) {
            return {};
        }
    }

    strm.next_in = const_cast<uint8_t*>(data);
    strm.avail_in = size;

    std::vector<uint8_t> out;
    std::vector<uint8_t> buffer(256 * 1024);
    int ret = Z_OK;

    do {
        strm.next_out = buffer.data();
        strm.avail_out = buffer.size();
        ret = inflate(&strm, Z_NO_FLUSH);
        if (ret != Z_OK && ret != Z_STREAM_END && ret != Z_BUF_ERROR) {
            inflateEnd(&strm);
            return {};
        }
        out.insert(out.end(), buffer.data(), buffer.data() + (buffer.size() - strm.avail_out));
    } while (ret != Z_STREAM_END && strm.avail_out == 0);

    inflateEnd(&strm);
    return out;
}

BackupLoader::BackupLoader(QObject* parent) : QObject(parent) {
}

bool BackupLoader::isBinaryBackup(const QString& filePath) {
    QFileInfo fi(filePath);
    if (!fi.exists() || fi.size() < 8) return false;
    QString ext = fi.suffix().toLower();
    if (ext == QStringLiteral("bin") || ext == QStringLiteral("risubackup")) return true;

    // Check first 4 bytes as entry length
    std::ifstream f(filePath.toStdString(), std::ios::binary);
    if (!f) return false;
    uint32_t nameLen = 0;
    if (f.read(reinterpret_cast<char*>(&nameLen), 4)) {
        if (nameLen > 0 && nameLen < 1024) {
            std::string name(nameLen, '\0');
            if (f.read(&name[0], nameLen)) {
                if (name.find(".png") != std::string::npos || 
                    name.find(".json") != std::string::npos ||
                    name.find("database.risudat") != std::string::npos ||
                    name.find("assets/") != std::string::npos) {
                    return true;
                }
            }
        }
    }
    return false;
}

bool BackupLoader::isJsonBackup(const QString& filePath) {
    QFileInfo fi(filePath);
    if (!fi.exists()) return false;
    QString ext = fi.suffix().toLower();
    return ext == QStringLiteral("json");
}

BackupImportResult BackupLoader::importBackupFile(const QString& filePath, std::function<void(int current, int total, const QString& status)> progressCb) {
    if (!QFile::exists(filePath)) {
        BackupImportResult res;
        res.success = false;
        res.errorMessage = QStringLiteral("File not found: ") + filePath;
        emit finished(false, res.errorMessage);
        return res;
    }

    if (isBinaryBackup(filePath)) {
        return importBinaryBackup(filePath, progressCb);
    } else {
        return importJsonBackup(filePath, progressCb);
    }
}

BackupImportResult BackupLoader::importBinaryBackup(const QString& filePath, std::function<void(int, int, const QString&)> progressCb) {
    BackupImportResult result;
    std::ifstream f(filePath.toStdString(), std::ios::binary);
    if (!f) {
        result.success = false;
        result.errorMessage = QStringLiteral("Failed to open binary file");
        emit finished(false, result.errorMessage);
        return result;
    }

    QString assetsDir = AppConfig::instance().assetsDir();
    QString avatarsDir = AppConfig::instance().avatarsDir();
    QString coldStorageDir = AppConfig::instance().coldStorageDir();
    QDir().mkpath(assetsDir);
    QDir().mkpath(avatarsDir);
    QDir().mkpath(coldStorageDir);

    std::vector<uint8_t> databaseRaw;

    if (progressCb) progressCb(10, 100, QStringLiteral("Reading binary container entries..."));
    emit progress(10, 100, QStringLiteral("Reading binary container entries..."));

    // First pass or stream unpack
    while (f) {
        uint32_t nameLen = 0;
        if (!f.read(reinterpret_cast<char*>(&nameLen), 4)) break;
        if (nameLen == 0 || nameLen > 65536) break;

        std::string name(nameLen, '\0');
        f.read(&name[0], nameLen);

        uint32_t dataLen = 0;
        if (!f.read(reinterpret_cast<char*>(&dataLen), 4)) break;

        QString qName = QString::fromUtf8(name.c_str(), static_cast<int>(nameLen));

        if (qName == QStringLiteral("database.risudat")) {
            databaseRaw.resize(dataLen);
            f.read(reinterpret_cast<char*>(databaseRaw.data()), dataLen);
        } else if (qName.startsWith(QStringLiteral("coldstorage_"))) {
            std::vector<char> coldData(dataLen);
            f.read(coldData.data(), dataLen);
            QString targetPath = coldStorageDir + QStringLiteral("/") + qName;
            QFile outF(targetPath);
            if (outF.open(QIODevice::WriteOnly)) {
                outF.write(coldData.data(), dataLen);
                outF.close();
                result.coldStorageCount++;
            }
        } else {
            // Asset file (e.g. assets/xxx.png or xxx.png)
            std::vector<char> assetData(dataLen);
            f.read(assetData.data(), dataLen);

            QString cleanName = qName;
            if (cleanName.startsWith(QStringLiteral("assets/"))) {
                cleanName = cleanName.mid(7);
            } else if (cleanName.startsWith(QStringLiteral("assets\\"))) {
                cleanName = cleanName.mid(7);
            }

            QString targetAssetPath = assetsDir + QStringLiteral("/") + cleanName;
            QFile outF(targetAssetPath);
            if (outF.open(QIODevice::WriteOnly)) {
                outF.write(assetData.data(), dataLen);
                outF.close();
                result.assetsCount++;
            }

            // Also mirror to avatarsDir if it is a png
            if (cleanName.endsWith(QStringLiteral(".png"), Qt::CaseInsensitive)) {
                QString targetAvatarPath = avatarsDir + QStringLiteral("/") + cleanName;
                if (!QFile::exists(targetAvatarPath)) {
                    QFile::copy(targetAssetPath, targetAvatarPath);
                }
            }
        }
    }

    if (databaseRaw.empty()) {
        result.success = false;
        result.errorMessage = QStringLiteral("database.risudat not found in backup archive");
        emit finished(false, result.errorMessage);
        return result;
    }

    if (progressCb) progressCb(50, 100, QStringLiteral("Decompressing and parsing database..."));
    emit progress(50, 100, QStringLiteral("Decompressing and parsing database..."));

    // Check magic header: \0RISUSAVE\0\x08 (11 bytes)
    static const uint8_t magicCompHeader[] = { 0x00, 'R', 'I', 'S', 'U', 'S', 'A', 'V', 'E', 0x00, 0x08 };
    static const uint8_t magicRawHeader[]  = { 0x00, 'R', 'I', 'S', 'U', 'S', 'A', 'V', 'E', 0x00, 0x07 };

    std::vector<uint8_t> msgpackData;

    if (databaseRaw.size() >= 11 && memcmp(databaseRaw.data(), magicCompHeader, 11) == 0) {
        msgpackData = decompressGzip(databaseRaw.data() + 11, databaseRaw.size() - 11);
    } else if (databaseRaw.size() >= 11 && memcmp(databaseRaw.data(), magicRawHeader, 11) == 0) {
        msgpackData.assign(databaseRaw.begin() + 11, databaseRaw.end());
    } else {
        // Try gzip decompress on entire buffer
        msgpackData = decompressGzip(databaseRaw.data(), databaseRaw.size());
        if (msgpackData.empty()) {
            msgpackData = std::move(databaseRaw);
        }
    }

    if (msgpackData.empty()) {
        result.success = false;
        result.errorMessage = QStringLiteral("Failed to decompress database.risudat");
        emit finished(false, result.errorMessage);
        return result;
    }

    nlohmann::json j;
    try {
        j = nlohmann::json::from_msgpack(msgpackData);
    } catch (const std::exception& e) {
        // Try JSON parse fallback
        try {
            std::string str(reinterpret_cast<const char*>(msgpackData.data()), msgpackData.size());
            j = nlohmann::json::parse(str);
        } catch (const std::exception& e2) {
            result.success = false;
            result.errorMessage = QStringLiteral("MessagePack/JSON parse failed: ") + QString::fromUtf8(e.what());
            emit finished(false, result.errorMessage);
            return result;
        }
    }

    if (progressCb) progressCb(70, 100, QStringLiteral("Writing database to SQLite..."));
    emit progress(70, 100, QStringLiteral("Writing database to SQLite..."));

    // Convert to QJsonObject for high-level structure import
    std::string dumped = j.dump();
    QJsonDocument doc = QJsonDocument::fromJson(QByteArray::fromRawData(dumped.data(), static_cast<int>(dumped.size())));
    if (doc.isNull() || !doc.isObject()) {
        result.success = false;
        result.errorMessage = QStringLiteral("Failed to construct QJsonObject from parsed data");
        emit finished(false, result.errorMessage);
        return result;
    }

    QJsonObject rootObj = doc.object();

    // Import into DatabaseManager
    DatabaseManager& db = DatabaseManager::instance();

    // 1. Characters
    if (rootObj.contains(QStringLiteral("characters"))) {
        QJsonValue charsVal = rootObj.value(QStringLiteral("characters"));
        if (charsVal.isArray()) {
            QJsonArray arr = charsVal.toArray();
            for (const auto& item : arr) {
                Character c = Character::fromJson(item.toObject());
                if (!c.id.isEmpty()) {
                    db.saveCharacter(c);
                    result.charactersCount++;
                }
            }
        } else if (charsVal.isObject()) {
            QJsonObject obj = charsVal.toObject();
            for (auto it = obj.begin(); it != obj.end(); ++it) {
                Character c = Character::fromJson(it.value().toObject());
                if (!c.id.isEmpty()) {
                    db.saveCharacter(c);
                    result.charactersCount++;
                }
            }
        }
    }

    // 2. Bot Presets
    if (rootObj.contains(QStringLiteral("botPresets")) || rootObj.contains(QStringLiteral("presets"))) {
        QJsonValue pVal = rootObj.contains(QStringLiteral("botPresets")) ? rootObj.value(QStringLiteral("botPresets")) : rootObj.value(QStringLiteral("presets"));
        if (pVal.isArray()) {
            for (const auto& item : pVal.toArray()) {
                Preset p = Preset::fromJson(item.toObject());
                if (!p.id.isEmpty()) {
                    db.savePreset(p);
                    result.presetsCount++;
                }
            }
        } else if (pVal.isObject()) {
            QJsonObject obj = pVal.toObject();
            for (auto it = obj.begin(); it != obj.end(); ++it) {
                Preset p = Preset::fromJson(it.value().toObject());
                if (!p.id.isEmpty()) {
                    db.savePreset(p);
                    result.presetsCount++;
                }
            }
        }
    }

    // 3. Personas
    if (rootObj.contains(QStringLiteral("personas"))) {
        QJsonValue pVal = rootObj.value(QStringLiteral("personas"));
        if (pVal.isArray()) {
            for (const auto& item : pVal.toArray()) {
                Persona p = Persona::fromJson(item.toObject());
                if (!p.id.isEmpty()) {
                    db.savePersona(p);
                    result.personasCount++;
                }
            }
        } else if (pVal.isObject()) {
            QJsonObject obj = pVal.toObject();
            for (auto it = obj.begin(); it != obj.end(); ++it) {
                Persona p = Persona::fromJson(it.value().toObject());
                if (!p.id.isEmpty()) {
                    db.savePersona(p);
                    result.personasCount++;
                }
            }
        }
    }

    // 4. Global Lorebook
    if (rootObj.contains(QStringLiteral("loreBook")) || rootObj.contains(QStringLiteral("globalLore"))) {
        QJsonValue lVal = rootObj.contains(QStringLiteral("loreBook")) ? rootObj.value(QStringLiteral("loreBook")) : rootObj.value(QStringLiteral("globalLore"));
        if (lVal.isArray()) {
            for (const auto& item : lVal.toArray()) {
                LorebookEntry l = LorebookEntry::fromJson(item.toObject());
                if (!l.id.isEmpty()) {
                    db.saveGlobalLorebook(l);
                    result.lorebooksCount++;
                }
            }
        } else if (lVal.isObject()) {
            QJsonObject obj = lVal.toObject();
            for (auto it = obj.begin(); it != obj.end(); ++it) {
                LorebookEntry l = LorebookEntry::fromJson(it.value().toObject());
                if (!l.id.isEmpty()) {
                    db.saveGlobalLorebook(l);
                    result.lorebooksCount++;
                }
            }
        }
    }

    // 5. Settings / Preferences
    if (rootObj.contains(QStringLiteral("settings")) && rootObj.value(QStringLiteral("settings")).isObject()) {
        QJsonObject st = rootObj.value(QStringLiteral("settings")).toObject();
        if (st.contains(QStringLiteral("theme"))) {
            AppConfig::instance().setTheme(st.value(QStringLiteral("theme")).toString());
        }
        if (st.contains(QStringLiteral("fontSize"))) {
            AppConfig::instance().setFontSize(st.value(QStringLiteral("fontSize")).toInt(15));
        }
        if (st.contains(QStringLiteral("selectedPersona"))) {
            AppConfig::instance().setSelectedPersonaId(st.value(QStringLiteral("selectedPersona")).toString());
        }
    }

    result.success = true;
    if (progressCb) progressCb(100, 100, QStringLiteral("Import completed successfully!"));
    
    QString summary = QStringLiteral("Imported %1 characters, %2 presets, %3 personas, %4 lorebooks, %5 assets")
                          .arg(result.charactersCount)
                          .arg(result.presetsCount)
                          .arg(result.personasCount)
                          .arg(result.lorebooksCount)
                          .arg(result.assetsCount);
    
    emit finished(true, summary);
    qInfo() << "Backup import summary:" << summary;
    return result;
}

BackupImportResult BackupLoader::importJsonBackup(const QString& filePath, std::function<void(int, int, const QString&)> progressCb) {
    BackupImportResult result;
    QFile f(filePath);
    if (!f.open(QIODevice::ReadOnly)) {
        result.success = false;
        result.errorMessage = QStringLiteral("Failed to open JSON backup file");
        emit finished(false, result.errorMessage);
        return result;
    }

    if (progressCb) progressCb(20, 100, QStringLiteral("Reading JSON file..."));
    emit progress(20, 100, QStringLiteral("Reading JSON file..."));

    QByteArray data = f.readAll();
    f.close();

    QJsonParseError err;
    QJsonDocument doc = QJsonDocument::fromJson(data, &err);
    if (doc.isNull() || !doc.isObject()) {
        result.success = false;
        result.errorMessage = QStringLiteral("Invalid JSON backup file: ") + err.errorString();
        emit finished(false, result.errorMessage);
        return result;
    }

    QJsonObject rootObj = doc.object();
    DatabaseManager& db = DatabaseManager::instance();

    if (progressCb) progressCb(50, 100, QStringLiteral("Writing database to SQLite..."));
    emit progress(50, 100, QStringLiteral("Writing database to SQLite..."));

    // 1. Characters
    if (rootObj.contains(QStringLiteral("characters")) && rootObj.value(QStringLiteral("characters")).isArray()) {
        for (const auto& item : rootObj.value(QStringLiteral("characters")).toArray()) {
            Character c = Character::fromJson(item.toObject());
            if (!c.id.isEmpty()) {
                db.saveCharacter(c);
                result.charactersCount++;
            }
        }
    }

    // 2. Presets
    if (rootObj.contains(QStringLiteral("presets")) && rootObj.value(QStringLiteral("presets")).isArray()) {
        for (const auto& item : rootObj.value(QStringLiteral("presets")).toArray()) {
            Preset p = Preset::fromJson(item.toObject());
            if (!p.id.isEmpty()) {
                db.savePreset(p);
                result.presetsCount++;
            }
        }
    }

    // 3. Personas
    if (rootObj.contains(QStringLiteral("personas")) && rootObj.value(QStringLiteral("personas")).isArray()) {
        for (const auto& item : rootObj.value(QStringLiteral("personas")).toArray()) {
            Persona p = Persona::fromJson(item.toObject());
            if (!p.id.isEmpty()) {
                db.savePersona(p);
                result.personasCount++;
            }
        }
    }

    // 4. Global Lore
    if (rootObj.contains(QStringLiteral("globalLore")) && rootObj.value(QStringLiteral("globalLore")).isArray()) {
        for (const auto& item : rootObj.value(QStringLiteral("globalLore")).toArray()) {
            LorebookEntry l = LorebookEntry::fromJson(item.toObject());
            if (!l.id.isEmpty()) {
                db.saveGlobalLorebook(l);
                result.lorebooksCount++;
            }
        }
    }

    result.success = true;
    if (progressCb) progressCb(100, 100, QStringLiteral("JSON import completed successfully!"));

    QString summary = QStringLiteral("Imported %1 characters, %2 presets, %3 personas, %4 lorebooks")
                          .arg(result.charactersCount)
                          .arg(result.presetsCount)
                          .arg(result.personasCount)
                          .arg(result.lorebooksCount);

    emit finished(true, summary);
    return result;
}

} // namespace Risu
