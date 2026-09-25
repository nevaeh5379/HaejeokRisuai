import Foundation

/// Imports legacy `.risu` / `.risup` save files from the web/Tauri versions.
///
/// Two formats exist:
/// - **Modern block format** (`RISUSAVE\0` header): length-prefixed blocks of JSON,
///   each optionally gzip-compressed.
/// - **Legacy msgpack format** (magic `[0x00,'R','I','S','U','S','A','V','E',0x00,0x07|0x08]`):
///   MessagePack payload of the whole database, optionally raw-deflate compressed.
enum RisuSaveImporter {
    struct ImportResult {
        var characters: [CharacterCard]
        var settingsPatch: [String: Any?]
        var loreBooks: [LoreBookPage]
        var personas: [PersonaPreset]
    }

    static func canImport(_ data: Data) -> Bool {
        if data.count > 9 && Data(data.prefix(9)) == Data("RISUSAVE\0".utf8) { return true }
        let magic: [UInt8] = [0x00, 0x52, 0x49, 0x53, 0x55, 0x53, 0x41, 0x56, 0x45, 0x00]
        if data.count > 11 && Array(data.prefix(10)) == magic {
            let version = data[10]
            return version == 7 || version == 8
        }
        return false
    }

    static func importSave(_ data: Data) throws -> ImportResult {
        if data.count > 9 && Data(data.prefix(9)) == Data("RISUSAVE\0".utf8) {
            return try decodeBlockFormat(data)
        }
        return try decodeMsgPackFormat(data)
    }

    // MARK: - Modern block format

    private enum BlockType {
        static let config = 0
        static let root = 1
        static let characterWithChat = 2
        static let chat = 3
        static let botPreset = 4
        static let characterWithoutChat = 7
        static let rootComponent = 8
    }

    private static func decodeBlockFormat(_ data: Data) throws -> ImportResult {
        var offset = 9 // "RISUSAVE\0"
        let bytes = [UInt8](data)
        var blocks: [(name: String, type: Int, content: String)] = []

        while offset < bytes.count {
            guard offset + 2 <= bytes.count else { break }
            let type = Int(bytes[offset])
            let compression = bytes[offset + 1] == 1
            offset += 2

            guard offset < bytes.count else { break }
            let nameLength = Int(bytes[offset])
            offset += 1
            guard offset + nameLength + 4 <= bytes.count else { break }
            let name = String(decoding: bytes[offset..<(offset + nameLength)], as: UTF8.self)
            offset += nameLength
            let length = Int(
                UInt32(bytes[offset]) | UInt32(bytes[offset+1]) << 8
                    | UInt32(bytes[offset+2]) << 16 | UInt32(bytes[offset+3]) << 24
            )
            offset += 4
            guard offset + length <= bytes.count else { break }
            var blockData = Array(bytes[offset..<(offset + length)])
            offset += length

            if compression {
                guard let inflated = inflateGzip(Data(blockData)) else { continue }
                blockData = [UInt8](inflated)
            }

            blocks.append((name, type, String(decoding: blockData, as: UTF8.self)))
        }

        return try assemble(fromBlocks: blocks)
    }

    private static func assemble(
        fromBlocks blocks: [(name: String, type: Int, content: String)]
    ) throws -> ImportResult {
        var rootDict: [String: Any?] = [:]
        var characterDicts: [[String: Any?]] = []
        var extraComponents: [String: Any?] = [:]

        for block in blocks {
            guard let obj = try? JSONSerialization.jsonObject(with: Data(block.content.utf8)) else {
                continue
            }
            switch block.type {
            case BlockType.root:
                if let d = obj as? [String: Any] {
                    let dd = ValueTreeBridge.toStringKeyed(d)
                    for (k, v) in dd where k != "__directory" {
                        if rootDict[k] == nil { rootDict[k] = v }
                    }
                }
            case BlockType.characterWithChat, BlockType.characterWithoutChat:
                if let d = obj as? [String: Any] {
                    characterDicts.append(ValueTreeBridge.toStringKeyed(d))
                }
            case BlockType.rootComponent:
                if let d = obj as? [String: Any],
                   let key = d["key"] as? String {
                    extraComponents[key] = ValueTreeBridge.normalizeValue(d["data"])
                }
            default:
                break
            }
        }

        // Merge root components into root dict when absent.
        for (k, v) in extraComponents where rootDict[k] == nil {
            rootDict[k] = v
        }

        return try buildResult(root: rootDict, characterDicts: characterDicts)
    }

    // MARK: - Legacy msgpack format

    private static func decodeMsgPackFormat(_ data: Data) throws -> ImportResult {
        var payload = data.subdata(in: 11..<data.count)
        let version = data[data.index(data.startIndex, offsetBy: 10)]
        if version == 8 {
            guard let inflated = inflateAuto(payload) else {
                throw CharacterCardIO.CardError.noData
            }
            payload = inflated
        }
        guard let decoded = try MsgPack.decode(payload) as? [String: Any?] else {
            throw CharacterCardIO.CardError.noData
        }

        let root = ValueTreeBridge.toStringKeyed(decoded)

        var characterDicts: [[String: Any?]] = []
        if let charsArr = root["characters"] as? [Any?] {
            for c in charsArr {
                if let cd = c as? [String: Any?] {
                    characterDicts.append(cd)
                } else if let cid = c as? String, let cache = root["chatCache"] as? [String: Any?] {
                    // Old format: characters array holds ids; chats live in chatCache.
                    if let charObj = findCharacterInRoot(cid, root) {
                        characterDicts.append(charObj)
                    } else if let chatMap = cache[cid] as? [String: Any?] {
                        // orphaned chats — skip
                        _ = chatMap
                    }
                }
            }
        }

        return try buildResult(root: root, characterDicts: characterDicts)
    }

    private static func findCharacterInRoot(_ id: String, _ root: [String: Any?]) -> [String: Any?]? {
        guard let allChars = root["__allCharacters"] as? [Any?] else { return nil }
        for c in allChars {
            if let cd = c as? [String: Any?], ValueTree.asString(cd["chaId"]) == id {
                return cd
            }
        }
        return nil
    }

    // MARK: - Assembly into native models

    private static func buildResult(
        root: [String: Any?], characterDicts: [[String: Any?]]
    ) throws -> ImportResult {
        var result = ImportResult(characters: [], settingsPatch: root, loreBooks: [], personas: [])

        for charDict in characterDicts {
            if let card = parseNativeCharacter(charDict, chatCache: root["chatCache"] as? [String: Any?]) {
                result.characters.append(card)
            }
        }

        // Global lorebook pages
        if let loreBookArr = root["loreBook"] as? [Any?] {
            for page in loreBookArr {
                if let pd = page as? [String: Any?] {
                    let p = ValueTreeBridge.toStringKeyed(pd)
                    let entriesRaw = p.arrayField("data")
                    let entries = parseLoreEntries(entriesRaw)
                    let name = p.stringField(["name"]).isEmpty ? "Imported Book" : p.stringField(["name"])
                    result.loreBooks.append(LoreBookPage(name: name, entries: entries))
                }
            }
        }

        // Personas
        if let personasArr = root["personas"] as? [Any?] {
            for persona in personasArr {
                if let pr = persona as? [String: Any?] {
                    let p = ValueTreeBridge.toStringKeyed(pr)
                    result.personas.append(
                        PersonaPreset(
                            name: p.stringField(["name"]),
                            personaPrompt: p.stringField(["personaPrompt"]),
                            iconAssetId: nil,
                            largePortrait: p.boolField(["largePortrait"], fallback: false),
                            note: p.optionalStringField("note") ?? ""
                        )
                    )
                }
            }
        }

        return result
    }

    private static func parseNativeCharacter(
        _ dRaw: [String: Any?], chatCache: [String: Any?]?
    ) -> CharacterCard? {
        let d = ValueTreeBridge.toStringKeyed(dRaw)
        let name = d.stringField(["name"])
        guard !name.isEmpty else { return nil }

        let chaId = d.optionalStringField("chaId")
        var card = CharacterCard(name: name)
        card.nickname = d.optionalStringField("nickname")
        card.desc = d.stringField(["desc", "description"])
        card.personality = d.stringField(["personality"])
        card.scenario = d.stringField(["scenario"])
        card.firstMessage = d.stringField(["firstMessage", "firstMes"])
        card.alternateGreetings = d.stringArrayField("alternateGreetings")
        card.exampleMessage = d.stringField(["exampleMessage"])
        card.systemPrompt = d.stringField(["systemPrompt"])
        card.postHistoryInstructions = d.stringField(["postHistoryInstructions"])
        card.creatorNotes = d.stringField(["creatorNotes"])
        card.creator = d.stringField(["creator"])
        card.characterVersion = d.stringField(["characterVersion"])
        card.tags = d.stringArrayField("tags")
        card.utilityBot = d.boolField(["utilityBot"], fallback: false)
        card.replaceGlobalNote = d.stringField(["replaceGlobalNote"])
        card.additionalText = d.stringField(["additionalText"])
        card.largePortrait = d.boolField(["largePortrait"], fallback: true)

        card.globalLore = parseLoreEntries(d.arrayField("globalLore"))
        card.customScripts = parseScripts(d.arrayField("customscript"))

        // Chats: modern format has full Chat objects; older ones reference chatCache by id.
        var chats: [ChatSession] = []
        if let chatsArr = d["chats"] as? [Any?] {
            for c in chatsArr {
                if let chatDict = c as? [String: Any?] {
                    chats.append(parseChat(ValueTreeBridge.toStringKeyed(chatDict), name: name))
                } else if let chatId = c as? String, let cache = chatCache, let chaId {
                    if let chaCache = cache[chaId] as? [String: Any?],
                       let chatObj = chaCache[chatId] as? [String: Any?] {
                        chats.append(parseChat(ValueTreeBridge.toStringKeyed(chatObj), name: name))
                    }
                }
            }
        }

        if chats.isEmpty, let firstMsg = card.firstMessageText(fmIndex: -1), !firstMsg.isEmpty {
            chats.append(ChatSession(name: "New Chat", messages: [ChatMessage(role: .char, data: firstMsg)]))
        } else if !chats.isEmpty {
            for i in chats.indices where chats[i].messages.isEmpty {
                if let fm = card.firstMessageText(fmIndex: chats[i].fmIndex) {
                    chats[i].messages.append(ChatMessage(role: .char, data: fm))
                }
            }
        }
        card.chats = chats

        // Portrait asset may be stored inline as base64 or referenced by id we cannot resolve.
        if let imgB64 = d.optionalStringField("image"), imgB64.hasPrefix("data:image") {
            if let commaIdx = imgB64.firstIndex(of: ","),
               let imgData = Data(base64Encoded: String(imgB64[imgB64.index(after: commaIdx)...])) {
                card.imageAssetId = AssetStore.shared.saveAsset(imgData)
            }
        } else if let imgId = d.optionalStringField("image"), imgId.hasPrefix("xa") || imgId.hasPrefix("#") {
            // Asset bytes live outside the save file; keep the id so the user sees *something*.
            card.imageAssetId = nil
        }

        return card
    }

    private static func parseChat(_ c: [String: Any?], name: String) -> ChatSession {
        var messages: [ChatMessage] = []
        for m in c.arrayField("message") {
            let md = m
            let roleStr = md.stringField(["role"])
            messages.append(
                ChatMessage(
                    role: roleStr == "user" ? .user : .char,
                    data: md.stringField(["data"]),
                    saying: md.optionalStringField("saying"),
                    name: md.optionalStringField("name"),
                    time: md.numberField(["time"], fallback: Date().timeIntervalSince1970 * 1000),
                    disabled: md.boolField(["disabled"], fallback: false),
                    isComment: md.boolField(["isComment"], fallback: false)
                )
            )
        }
        return ChatSession(
            name: c.stringField(["name"]).isEmpty ? name : c.stringField(["name"]),
            note: c.stringField(["note"]),
            messages: messages,
            localLore: parseLoreEntries(c.arrayField("localLore")),
            fmIndex: Int(c.numberField(["fmIndex"], fallback: -1)),
            lastDate: c.numberField(["lastDate"], fallback: Date().timeIntervalSince1970 * 1000),
            supaMemoryText: c.optionalStringField("supaMemoryData")
        )
    }

    private static func parseLoreEntries(_ arr: [[String: Any?]]) -> [LoreBookEntry] {
        arr.compactMap { eRaw in
            let e = ValueTreeBridge.toStringKeyed(eRaw)
            let content = e.stringField(["content"])
            let key = e.stringField(["key"])
            guard !content.isEmpty else { return nil }
            return LoreBookEntry(
                key: key,
                secondKeys: e.stringField(["secondkey"])
                    .split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty },
                comment: e.stringField(["comment"]),
                content: content,
                mode: LoreBookMode(rawValue: e.stringField(["mode"])) ?? .normal,
                alwaysActive: e.boolField(["alwaysActive"], fallback: false),
                selective: e.boolField(["selective"], fallback: false),
                insertOrder: Int(e.numberField(["insertorder"], fallback: 100)),
                activationPercent: e["activationPercent"].flatMap { ValueTree.asNumber($0).map(Int.init) },
                useRegex: e.boolField(["useRegex"], fallback: false)
            )
        }
    }

    private static func parseScripts(_ arr: [[String: Any?]]) -> [CustomScriptEntry] {
        arr.compactMap { sRaw in
            let s = ValueTreeBridge.toStringKeyed(sRaw)
            let placement: ScriptPlacement
            switch s.stringField(["type"]) {
            case "input": placement = .input
            case "slashcommand": placement = .slashCommand
            case "editprocess": placement = .editProcess
            default: placement = .output
            }
            return CustomScriptEntry(
                comment: s.stringField(["comment"]),
                findRegex: s.stringField(["in"]),
                replaceWith: s.stringField(["out"]),
                placement: placement,
                enabled: true
            )
        }
    }

    // MARK: - gzip inflate (for block format)

    /// Auto-detects the deflate container format: gzip (1f 8b), zlib (78),
    /// or raw deflate, and inflates accordingly. Risu backups may use any of
    /// these depending on the version that produced them.
    static func inflateAuto(_ data: Data) -> Data? {
        guard data.count > 2 else { return nil }
        let bytes = [UInt8](data)
        if bytes[0] == 0x1F, bytes[1] == 0x8B {
            return inflateGzip(data)
        }
        if bytes[0] == 0x78, (bytes[1] == 0x9C || bytes[1] == 0xDA || bytes[1] == 0x01 || bytes[1] == 0x5E) {
            // zlib-wrapped deflate: skip the 2-byte header.
            return PNGChunks.inflateRaw(data.subdata(in: 2..<data.count))
        }
        return PNGChunks.inflateRaw(data)
    }

    /// Inflates a gzip stream. Apple's Compression only handles raw deflate,
    /// so strip the gzip header and trailer manually.
    private static func inflateGzip(_ data: Data) -> Data? {
        let bytes = [UInt8](data)
        guard bytes.count > 18, bytes[0] == 0x1F, bytes[1] == 0x8B, bytes[2] == 8 else { return nil }

        let flags = bytes[3]
        var offset = 10
        if flags & 0x04 != 0 { // FEXTRA
            guard offset + 2 <= bytes.count else { return nil }
            let xlen = Int(bytes[offset]) | Int(bytes[offset + 1]) << 8
            offset += 2 + xlen
        }
        if flags & 0x08 != 0 { // FNAME
            while offset < bytes.count, bytes[offset] != 0 { offset += 1 }
            offset += 1
        }
        if flags & 0x10 != 0 { // FCOMMENT
            while offset < bytes.count, bytes[offset] != 0 { offset += 1 }
            offset += 1
        }
        if flags & 0x02 != 0 { offset += 2 } // FHCRC
        guard offset < bytes.count - 8 else { return nil }

        let body = Array(bytes[offset..<(bytes.count - 8)])
        return PNGChunks.inflateRaw(Data(body))
    }
}
