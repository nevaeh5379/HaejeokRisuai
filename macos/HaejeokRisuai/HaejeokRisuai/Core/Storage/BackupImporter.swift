import Foundation

/// Imports RisuAI `.bin` / `.risubackup` backup files.
///
/// The backup format (from `LocalWriter.startBackup` in the web version) is a
/// flat sequence of entries, each laid out as:
///   [nameLength: UInt32 LE][name: UTF-8][dataLength: UInt32 LE][data: bytes]
/// The `database.risudat` entry holds a RisuSave payload (decoded by
/// `RisuSaveImporter`); other entries are asset files written as
/// `assets/<name>` and optional `encryption.risudat` / cold-storage entries.
enum BackupImporter {
    struct Entry {
        var name: String
        var data: Data
    }

    enum BackupError: LocalizedError {
        case invalidNameLength
        case invalidDataLength
        case incompleteEntry
        case noDatabase
        case decryptNotSupported

        var errorDescription: String? {
            switch self {
            case .invalidNameLength: return "Invalid backup entry name length."
            case .invalidDataLength: return "Invalid backup entry data length."
            case .incompleteEntry: return "Backup file ended with an incomplete entry."
            case .noDatabase: return "Backup does not contain a database entry."
            case .decryptNotSupported: return "Encrypted (account) backups are not supported yet."
            }
        }
    }

    struct ImportedBackup {
        var database: JsDatabase
        var assetCount: Int
        var characterCount: Int
    }

    /// Parses and imports a `.bin` / `.risubackup` file.
    /// Returns the decoded JsDatabase and stores assets into `AssetStore`.
    @MainActor
    static func importBackup(_ data: Data) throws -> ImportedBackup {
        var databaseEntry: Data?
        var assetCount = 0
        var encryptionMetaData: Data?

        for entry in try parseEntries(data) {
            if entry.name == "database.risudat" {
                databaseEntry = entry.data
            } else if entry.name == "encryption.risudat" {
                encryptionMetaData = entry.data
            } else if entry.name.hasPrefix("coldstorage") || entry.name.hasPrefix("cold_") {
                // Cold storage entries — not modeled yet; skip gracefully.
                continue
            } else {
                // Asset file: name is like "<id>.<ext>"; store under assets/<name>.
                let assetId = entry.name
                _ = AssetStore.shared.saveAsset(entry.data, customId: assetId)
                assetCount += 1
            }
        }

        guard let dbData = databaseEntry else {
            // Fallback: the whole file may be a raw RisuSave (no container).
            if RisuSaveImporter.canImport(data) {
                let result = try RisuSaveImporter.importSave(data)
                let jsDB = buildJsDatabase(from: result)
                return ImportedBackup(database: jsDB, assetCount: 0, characterCount: result.characters.count)
            }
            throw BackupError.noDatabase
        }

        // Encrypted backups (account-type) carry an encryption.risudat entry.
        if let meta = encryptionMetaData,
           let metaObj = try? JSONSerialization.jsonObject(with: meta) as? [String: Any],
           let type = metaObj["type"] as? String, type == "account" {
            throw BackupError.decryptNotSupported
        }

        // Decode the RisuSave payload (block format or legacy msgpack).
        guard RisuSaveImporter.canImport(dbData) else {
            throw CharacterCardIO.CardError.unsupported("database.risudat is not a recognized Risu save payload.")
        }
        let result = try RisuSaveImporter.importSave(dbData)
        let jsDB = buildJsDatabase(from: result)
        return ImportedBackup(database: jsDB, assetCount: assetCount, characterCount: result.characters.count)
    }

    /// Builds a JsDatabase from the Risu save importer result, preserving
    /// legacy settings fields as root entries.
    static func buildJsDatabase(from result: RisuSaveImporter.ImportResult) -> JsDatabase {
        var db = JsDatabase()
        // Port known settings fields from the legacy save root.
        let root = result.settingsPatch
        for (key, value) in root {
            if key == "characters" || key == "botPresets" || key == "botPresetsId" { continue }
            if key == "__directory" || key == "__allCharacters" || key == "chatCache" { continue }
            db.set(key, jsValue(from: value))
        }
        // Characters: the importer already parsed them into CharacterCard models;
        // convert back through the bridge so they land in the JS tree shape that
        // replaceDatabase expects, merging any extra fields from the raw dict.
        var characters: [JsValue] = []
        for (index, charDict) in result.characters.enumerated() {
            _ = index
            characters.append(JsDatabaseBridge.characterToJs(charDict))
        }
        db.set("characters", .array(characters))

        // Personas and lorebooks.
        if !result.personas.isEmpty {
            db.set("personas", .array(result.personas.map(JsDatabaseBridge.personaToJs)))
        }
        if !result.loreBooks.isEmpty {
            db.set("loreBook", .array(result.loreBooks.map(JsDatabaseBridge.pageToJs)))
        }
        return db
    }

    /// Converts a `RisuSaveImporter` value-tree `Any?` into a `JsValue`.
    static func jsValue(from any: Any?) -> JsValue {
        JsValue(any)
    }

    // MARK: - Entry parsing

    /// Parses the flat `[nameLen][name][dataLen][data]` entry stream.
    static func parseEntries(_ data: Data) throws -> [Entry] {
        var entries: [Entry] = []
        let bytes = [UInt8](data)
        var offset = 0
        let total = bytes.count

        while offset < total {
            // name length
            guard offset + 4 <= total else { throw BackupError.incompleteEntry }
            let nameLen = readU32(bytes, offset)
            offset += 4
            if nameLen == 0 || nameLen > 1_048_576 { throw BackupError.invalidNameLength }

            // name
            guard offset + nameLen <= total else { throw BackupError.incompleteEntry }
            let name = String(decoding: bytes[offset..<(offset + nameLen)], as: UTF8.self)
            offset += nameLen

            // data length
            guard offset + 4 <= total else { throw BackupError.incompleteEntry }
            let dataLen = readU32(bytes, offset)
            offset += 4
            if dataLen > total { throw BackupError.invalidDataLength }

            // data
            guard offset + dataLen <= total else { throw BackupError.incompleteEntry }
            let entryData = Data(bytes[offset..<(offset + dataLen)])
            offset += dataLen

            entries.append(Entry(name: name, data: entryData))
        }

        return entries
    }

    private static func readU32(_ bytes: [UInt8], _ offset: Int) -> Int {
        Int(UInt32(bytes[offset]) | UInt32(bytes[offset + 1]) << 8
            | UInt32(bytes[offset + 2]) << 16 | UInt32(bytes[offset + 3]) << 24)
    }
}