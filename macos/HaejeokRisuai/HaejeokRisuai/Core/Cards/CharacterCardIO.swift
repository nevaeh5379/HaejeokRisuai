import AppKit
import Foundation

/// Imports and exports character cards: JSON (V2/V3 spec), PNG with embedded
/// `chara`/`ccv3` chunks, `.charx` archives, and legacy TavernAI cards.
enum CharacterCardIO {
    // MARK: - Public import

    static func importCard(from url: URL) throws -> CharacterCard {
        let data = try Data(contentsOf: url)
        let ext = url.pathExtension.lowercased()
        let name = url.deletingPathExtension().lastPathComponent

        switch ext {
        case "json":
            return try importJSON(data, fallbackName: name)
        case "png":
            return try importPNG(data, fallbackName: name)
        case "charx":
            return try importCharX(data, fallbackName: name)
        case "jpg", "jpeg":
            if let card = try? importCharX(data, fallbackName: name) {
                return card
            }
            throw CardError.unsupported("JPEG card contains no readable charx archive.")
        default:
            throw CardError.unsupported("Unsupported file type .\(ext)")
        }
    }

    enum CardError: LocalizedError {
        case noData
        case unsupported(String)

        var errorDescription: String? {
            switch self {
            case .noData: return "No character card data found in file."
            case .unsupported(let why): return why
            }
        }
    }

    // MARK: - JSON import

    static func importJSON(_ data: Data, fallbackName: String) throws -> CharacterCard {
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CardError.noData
        }
        return try parseCardObject(obj, fallbackName: fallbackName, imageData: nil)
    }

    private static func parseCardObject(
        _ obj: [String: Any], fallbackName: String, imageData: Data?
    ) throws -> CharacterCard {
        let spec = obj["spec"] as? String ?? ""
        var card = CharacterCard(name: fallbackName)
        card.imageAssetId = imageData.map { AssetStore.shared.saveAsset($0) }

        if spec == "chara_card_v2" || spec == "chara_card_v3" {
            guard let d = obj["data"] as? [String: Any] else { throw CardError.noData }
            let dict = ValueTreeBridge.toStringKeyed(d)
            card.name = dict.stringField(["name"]).isEmpty ? fallbackName : dict.stringField(["name"])
            card.desc = dict.stringField(["description"])
            card.personality = dict.stringField(["personality"])
            card.scenario = dict.stringField(["scenario"])
            card.firstMessage = dict.stringField(["first_mes"])
            card.exampleMessage = dict.stringField(["mes_example"])
            card.creatorNotes = dict.stringField(["creator_notes"])
            card.systemPrompt = dict.stringField(["system_prompt"])
            card.postHistoryInstructions = dict.stringField(["post_history_instructions"])
            card.alternateGreetings = dict.stringArrayField("alternate_greetings")
            card.tags = dict.stringArrayField("tags")
            card.creator = dict.stringField(["creator"])
            var version = dict.stringField(["character_version"])
            if version.isEmpty, let num = dict["character_version"] as? Int {
                version = String(num)
            }
            card.characterVersion = version

            // Risu extensions
            if let extRaw = dict["extensions"] as? [String: Any?] {
                let ext = ValueTreeBridge.toStringKeyed(extRaw)
                if let risuaiRaw = ext["risuai"] as? [String: Any?] {
                    let r = ValueTreeBridge.toStringKeyed(risuaiRaw)
                    card.utilityBot = r.boolField(["utilityBot"], fallback: false)
                    card.replaceGlobalNote = r.stringField(["replaceGlobalNote"])
                    card.additionalText = r.stringField(["additionalText"])
                    card.largePortrait = r.boolField(["largePortrait"], fallback: true)
                    if let sourceArr = r["source"] as? [Any?] {
                        card.sources = sourceArr.map { ValueTree.asString($0) }
                    }
                    card.customScripts = parseRisuScripts(r["customScripts"] as? [Any?] ?? [])
                    if let lorebookArr = r["lorebook"] as? [Any?] {
                        card.globalLore = parseRisuLorebook(lorebookArr)
                    }
                }
                if let depthPrompt = ext["depth_prompt"] as? [String: Any?] {
                    let dp = ValueTreeBridge.toStringKeyed(depthPrompt)
                    let prompt = dp.stringField(["prompt"])
                    if !prompt.isEmpty {
                        card.desc += "\n\n[{{char}} thinks: \(prompt)]"
                    }
                }
            }

            // Standard V2 character_book
            if let bookRaw = dict["character_book"] as? [String: Any?] {
                let book = ValueTreeBridge.toStringKeyed(bookRaw)
                let entries = parseCharacterBook(book)
                card.globalLore.append(contentsOf: entries)
            }
        } else {
            // Off-spec / OldTavern format
            let dict = ValueTreeBridge.toStringKeyed(obj)
            let nameV = dict.stringField(["name", "char_name"])
            let descV = dict.stringField(["description", "char_persona"])
            let firstMsg = dict.stringField(["first_mes", "char_greeting"])
            guard !nameV.isEmpty || !descV.isEmpty else { throw CardError.noData }
            card.name = nameV.isEmpty ? fallbackName : nameV
            card.desc = descV
            card.firstMessage = firstMsg
            card.personality = dict.stringField(["personality"])
            card.scenario = dict.stringField(["scenario"])
            card.exampleMessage = dict.stringField(["mes_example"])
            card.largePortrait = true
        }

        if card.imageAssetId == nil, let img = imageData {
            card.imageAssetId = AssetStore.shared.saveAsset(img)
        }

        card.ensureChatExists()
        return card
    }

    private static func parseRisuLorebook(_ arr: [Any?]) -> [LoreBookEntry] {
        arr.compactMap { raw in
            guard let dRaw = raw as? [String: Any?] else { return nil }
            let d = ValueTreeBridge.toStringKeyed(dRaw)
            let modeStr = d.stringField(["mode"])
            let mode = LoreBookMode(rawValue: modeStr) ?? .normal
            return LoreBookEntry(
                key: d.stringField(["key"]),
                secondKeys: d.stringField(["secondkey"])
                    .split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty },
                comment: d.stringField(["comment"]),
                content: d.stringField(["content"]),
                mode: mode,
                alwaysActive: d.boolField(["alwaysActive"], fallback: false),
                selective: d.boolField(["selective"], fallback: false),
                insertOrder: Int(d.numberField(["insertorder"], fallback: 100)),
                activationPercent: d["activationPercent"].flatMap { ValueTree.asNumber($0).map(Int.init) },
                useRegex: d.boolField(["useRegex"], fallback: false),
                caseSensitive: false
            )
        }
    }

    private static func parseRisuScripts(_ arr: [Any?]) -> [CustomScriptEntry] {
        arr.compactMap { raw in
            guard let dRaw = raw as? [String: Any?] else { return nil }
            let d = ValueTreeBridge.toStringKeyed(dRaw)
            let typeStr = d.stringField(["type"])
            let placement: ScriptPlacement
            switch typeStr {
            case "input": placement = .input
            case "slashcommand": placement = .slashCommand
            case "editprocess": placement = .editProcess
            default: placement = .output
            }
            return CustomScriptEntry(
                comment: d.stringField(["comment"]),
                findRegex: d.stringField(["in"]),
                replaceWith: d.stringField(["out"]),
                placement: placement,
                enabled: d.boolField(["flag"], fallback: true) || !d.boolField(["ableFlag"], fallback: false)
            )
        }
    }

    private static func parseCharacterBook(_ book: [String: Any?]) -> [LoreBookEntry] {
        let entries = book.arrayField("entries")
        return entries.map { eRaw in
            let e = ValueTreeBridge.toStringKeyed(eRaw)
            let keys = e.stringArrayField("keys")
            let secondKeys = e.stringArrayField("secondary_keys")
            return LoreBookEntry(
                key: keys.joined(separator: ","),
                secondKeys: secondKeys,
                comment: e.optionalStringField("comment") ?? e.optionalStringField("name") ?? "",
                content: e.stringField(["content"]),
                mode: .normal,
                alwaysActive: e.boolField(["constant"], fallback: false),
                selective: e.boolField(["selective"], fallback: false),
                insertOrder: Int(e.numberField(["insertion_order"], fallback: 100)),
                activationPercent: nil,
                useRegex: e.boolField(["use_regex"], fallback: false),
                caseSensitive: e.boolField(["case_sensitive"], fallback: false),
                enabled: e.boolField(["enabled"], fallback: true)
            )
        }
    }

    // MARK: - PNG import

    static func importPNG(_ data: Data, fallbackName: String) throws -> CharacterCard {
        let chunks = try PNGChunks.readTextChunks(data)
        var charaChunk: String?
        var ccv3Chunk: String?
        for chunk in chunks {
            if chunk.key == "chara" && charaChunk?.count ?? 0 < 5_000_000 { charaChunk = chunk.value }
            if chunk.key == "ccv3" && ccv3Chunk?.count ?? 0 < 5_000_000 { ccv3Chunk = chunk.value }
        }
        let payload = ccv3Chunk ?? charaChunk
        guard let payload else { throw CardError.noData }

        guard let decoded = Data(base64Encoded: payload),
              let obj = try? JSONSerialization.jsonObject(with: decoded) as? [String: Any] else {
            throw CardError.noData
        }

        // Handle encrypted rcc cards by rejecting them gracefully.
        if let str = obj as? [String: Any], str["spec"] == nil, ccv3Chunk == nil,
           payload.hasPrefix("rcc||") {
            throw CardError.unsupported("Encrypted (.rcc) cards are not supported.")
        }

        return try parseCardObject(obj, fallbackName: fallbackName, imageData: data)
    }

    // MARK: - charx import

    static func importCharX(_ data: Data, fallbackName: String) throws -> CharacterCard {
        let entries = try ZipArchive.read(data)
        guard let cardEntry = entries.first(where: { $0.path == "card.json" || $0.path.hasSuffix("/card.json") }) else {
            throw CardError.noData
        }
        guard let obj = try? JSONSerialization.jsonObject(with: cardEntry.data) as? [String: Any],
              (obj["spec"] as? String)?.hasPrefix("chara_card_v") == true else {
            throw CardError.noData
        }

        var card = try parseCardObject(obj, fallbackName: fallbackName, imageData: nil)

        // Embedded assets: map them into the asset store and keep the largest image as portrait.
        var bestImageId: String?
        var bestSize: CGFloat = 0
        for entry in entries where entry.path.hasPrefix("assets/") {
            let assetId = AssetStore.shared.saveAsset(entry.data)
            if let img = NSImage(data: entry.data) {
                let area = img.size.width * img.size.height
                if bestImageId == nil || area > bestSize {
                    bestImageId = assetId
                    bestSize = area
                }
            }
        }
        if card.imageAssetId == nil, let best = bestImageId {
            card.imageAssetId = best
        }

        // Embedded module (risu module.json with lorebook/scripts)
        if let moduleEntry = entries.first(where: { $0.path == "module.json" }) {
            if let mod = try? JSONSerialization.jsonObject(with: moduleEntry.data) as? [String: Any] {
                let modDict = ValueTreeBridge.toStringKeyed(mod)
                if let lb = mod["lorebook"] as? [Any?] {
                    card.globalLore.append(contentsOf: parseRisuLorebook(lb))
                }
                if let regex = mod["regex"] as? [Any?] {
                    card.customScripts.append(contentsOf: parseRisuScripts(regex))
                }
                _ = modDict
            }
        }

        card.ensureChatExists()
        return card
    }

    // MARK: - Export

    /// Exports a card as a V2-spec JSON payload dictionary (used for both json and png export).
    static func exportSpecDictionary(from card: CharacterCard) -> [String: Any] {
        var extensions: [String: Any] = [:]
        var risuExt: [String: Any] = [
            "utilityBot": card.utilityBot,
            "replaceGlobalNote": card.replaceGlobalNote,
            "additionalText": card.additionalText,
            "largePortrait": card.largePortrait,
            "customScripts": card.customScripts.map { script in
                [
                    "comment": script.comment,
                    "in": script.findRegex,
                    "out": script.replaceWith,
                    "type": script.placement.rawValue,
                    "flag": script.enabled ? "true" : "false",
                    "ableFlag": true,
                ] as [String: Any]
            },
            "emotionImages": [] as [[String]],
        ]
        if !card.globalLore.isEmpty {
            risuExt["lorebook"] = card.globalLore.map { e in
                [
                    "key": e.key,
                    "secondkey": e.secondKeys.joined(separator: ","),
                    "comment": e.comment,
                    "content": e.content,
                    "mode": e.mode.rawValue,
                    "alwaysActive": e.alwaysActive,
                    "selective": e.selective,
                    "insertorder": e.insertOrder,
                ] as [String: Any]
            }
        }
        extensions["risuai"] = risuExt

        let data: [String: Any] = [
            "name": card.name,
            "description": card.desc,
            "personality": card.personality,
            "scenario": card.scenario,
            "first_mes": card.firstMessage,
            "mes_example": card.exampleMessage,
            "creator_notes": card.creatorNotes,
            "system_prompt": card.systemPrompt,
            "post_history_instructions": card.postHistoryInstructions,
            "alternate_greetings": card.alternateGreetings,
            "tags": card.tags,
            "creator": card.creator,
            "character_version": card.characterVersion,
            "extensions": extensions,
        ]

        return [
            "spec": "chara_card_v2",
            "spec_version": "2.0",
            "data": data,
        ]
    }

    /// Exports as a PNG with the card embedded in a `chara` chunk.
    static func exportPNG(from card: CharacterCard, portrait: NSImage?) throws -> Data {
        let spec = exportSpecDictionary(from: card)
        let jsonData = try JSONSerialization.data(withJSONObject: spec, options: [])
        let b64 = jsonData.base64EncodedString()

        let image: NSImage
        if let portrait {
            image = portrait
        } else {
            image = NSImage(size: NSSize(width: 512, height: 512))
            image.lockFocus()
            NSColor.windowBackgroundColor.setFill()
            NSBezierPath(rect: NSRect(origin: .zero, size: image.size)).fill()
            image.unlockFocus()
        }
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            throw CardError.unsupported("Failed to encode PNG.")
        }

        return PNGChunks.writeTextChunks(to: png, chunks: [.init(key: "chara", value: b64)])
    }

    /// Exports as a `.charx` archive.
    static func exportCharX(from card: CharacterCard, portrait: NSImage?) throws -> Data {
        let spec = exportSpecDictionary(from: card)
        let jsonData = try JSONSerialization.data(withJSONObject: spec, options: [.prettyPrinted])

        var entries: [ZipArchive.Entry] = [
            ZipArchive.Entry(path: "card.json", data: jsonData),
        ]
        if let portrait, let tiff = portrait.tiffRepresentation,
           let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            entries.append(ZipArchive.Entry(path: "assets/portrait.png", data: png))
        }
        return ZipArchive.write(entries: entries)
    }
}

// MARK: - Value tree bridging

/// Bridges untyped JSON dictionaries from JSONSerialization ([String: Any]) into the
/// `[String: Any?]` trees used by the save importers.
enum ValueTreeBridge {
    static func toStringKeyed(_ d: [String: Any]) -> [String: Any?] {
        var out: [String: Any?] = [:]
        for (k, v) in d { out[k] = normalizeValue(v) }
        return out
    }

    static func normalizeValue(_ v: Any) -> Any? {
        switch v {
        case is NSNull: return nil
        case let s as String: return s
        case let n as NSNumber:
            // Distinguish bools encoded as NSNumber.
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue }
            return n.doubleValue == n.doubleValue.rounded() && abs(n.doubleValue) < 1e15
                ? n.intValue : n.doubleValue
        case let d as [String: Any]: return toStringKeyed(d)
        case let a as [Any]: return a.map { normalizeValue($0) }
        default: return "\(v)"
        }
    }
}
