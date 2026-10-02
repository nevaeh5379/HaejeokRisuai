import Foundation

/// Bridges the JS-style database tree (the exact shape the web/Tauri version
/// stores in SQLite) and the Swift domain models used by the UI.
///
/// Unknown/extra fields are preserved so the native app can round-trip a
/// database produced by the web version without data loss.
enum JsDatabaseBridge {

    // MARK: - Load: JsDatabase -> (AppSettings, [CharacterCard])

    struct Loaded {
        var settings: AppSettings
        var characters: [CharacterCard]
    }

    static func load(from db: JsDatabase) -> Loaded {
        var settings = AppSettings()

        // Settings: map known keys.
        if let v = db.get("apiType") { settings.apiType = (stringValue(v).flatMap(ProviderKind.init(rawValue:))) ?? settings.apiType }
        if let v = db.get("openAIKey") { settings.providers[ProviderKind.openAI.rawValue, default: ProviderSettings()].apiKey = stringValue(v) ?? "" }
        if let v = db.get("claudeAPIKey") { settings.providers[ProviderKind.claude.rawValue, default: ProviderSettings()].apiKey = stringValue(v) ?? "" }
        // Google key stored under google.accessToken in web; keep simple.
        if let v = db.get("openrouterKey") { settings.providers[ProviderKind.openRouter.rawValue, default: ProviderSettings()].apiKey = stringValue(v) ?? "" }
        if let v = db.get("mistralKey") { settings.providers[ProviderKind.mistral.rawValue, default: ProviderSettings()].apiKey = stringValue(v) ?? "" }
        if let v = db.get("aiModel") { settings.providers[settings.apiType.rawValue, default: ProviderSettings()].model = stringValue(v) ?? "" }
        if let v = db.get("subModel") { settings.subModel = stringValue(v) ?? "" }
        if let v = db.get("proxyRequestModel") { settings.providers[ProviderKind.customProxy.rawValue, default: ProviderSettings()].model = stringValue(v) ?? "" }
        if let v = db.get("customProxyRequestModel") { settings.providers[ProviderKind.customProxy.rawValue, default: ProviderSettings()].model = stringValue(v) ?? settings.providers[ProviderKind.customProxy.rawValue]?.model ?? "" }
        if let v = db.get("ollamaURL") { settings.ollama.url = stringValue(v) ?? settings.ollama.url }
        if let v = db.get("ollamaModel") { settings.ollama.model = stringValue(v) ?? settings.ollama.model }

        if let v = db.get("temperature") { settings.temperature = doubleValue(v) ?? settings.temperature }
        if let v = db.get("maxContext") { settings.maxContext = intValue(v) ?? settings.maxContext }
        if let v = db.get("maxResponse") { settings.maxResponse = intValue(v) ?? settings.maxResponse }
        if let v = db.get("frequencyPenalty") { settings.frequencyPenalty = doubleValue(v) ?? settings.frequencyPenalty }
        if let v = db.get("PresensePenalty") { settings.presencePenalty = doubleValue(v) ?? settings.presencePenalty }
        if let v = db.get("top_p") { settings.topP = doubleValue(v) ?? settings.topP }
        if let v = db.get("top_k") { settings.topK = intValue(v) ?? settings.topK }
        if let v = db.get("generationSeed") { settings.generationSeed = intValue(v) ?? settings.generationSeed }

        if let v = db.get("mainPrompt") { settings.mainPrompt = stringValue(v) ?? settings.mainPrompt }
        if let v = db.get("jailbreak") { settings.jailbreak = stringValue(v) ?? settings.jailbreak }
        if let v = db.get("globalNote") { settings.globalNote = stringValue(v) ?? settings.globalNote }
        if let v = db.get("additionalPrompt") { settings.additionalPrompt = stringValue(v) ?? settings.additionalPrompt }
        if let v = db.get("descriptionPrefix") { settings.descriptionPrefix = stringValue(v) ?? settings.descriptionPrefix }
        if let v = db.get("formatingOrder") {
            if case .array(let arr) = v {
                settings.formattingOrder = arr.compactMap { item in
                    guard case .string(let s) = item else { return nil }
                    return FormattingOrderItem(rawValue: s)
                }
            }
        }

        if let v = db.get("loreBookDepth") { settings.loreBookDepth = intValue(v) ?? settings.loreBookDepth }
        if let v = db.get("loreBookToken") { settings.loreBookToken = intValue(v) ?? settings.loreBookToken }

        if let v = db.get("username") { settings.username = stringValue(v) ?? settings.username }
        if let v = db.get("userNote") { settings.userNote = stringValue(v) ?? settings.userNote }
        if let v = db.get("personaPrompt") { settings.personaPrompt = stringValue(v) ?? settings.personaPrompt }
        if let v = db.get("personas") {
            if case .array(let arr) = v {
                settings.personas = arr.compactMap(personaFromJs)
            }
        }
        if let v = db.get("selectedPersona") {
            let idx = intValue(v) ?? -1
            if idx >= 0, idx < settings.personas.count {
                settings.selectedPersonaId = settings.personas[idx].id
            }
        }

        if let v = db.get("loreBook") {
            if case .array(let arr) = v {
                settings.loreBooks = arr.compactMap { page in
                    guard case .object(let entries) = page else { return nil }
                    let name = stringValue(entries.first(where: { $0.0 == "name" })?.1) ?? "Book"
                    let data = entries.first(where: { $0.0 == "data" })?.1
                    guard case .array(let dataArr) = data else { return LoreBookPage(name: name) }
                    return LoreBookPage(name: name, entries: dataArr.compactMap(loreFromJs))
                }
            }
        }
        if let v = db.get("globalscript") {
            if case .array(let arr) = v { settings.globalScripts = arr.compactMap(scriptFromJs) }
        }

        if let v = db.get("memoryAlgorithmType") { settings.memoryAlgorithm = MemoryAlgorithmType(rawValue: stringValue(v) ?? "none") ?? .none }
        if let v = db.get("supaMemoryPrompt") { settings.supaMemory.prompt = stringValue(v) ?? settings.supaMemory.prompt }
        if let v = db.get("supaMemoryKey") { settings.supaMemory.apiKey = stringValue(v) ?? settings.supaMemory.apiKey }

        if let v = db.get("theme") { settings.theme = ColorThemeKind(rawValue: stringValue(v) ?? "dark") ?? .dark }
        if let v = db.get("fontSize") ?? db.get("textAreaTextSize") { settings.fontSize = doubleValue(v) ?? settings.fontSize }
        if let v = db.get("roundIcons") { settings.roundIcons = boolValue(v) ?? settings.roundIcons }
        if let v = db.get("showTokenUsage") ?? db.get("requestInfoInsideChat") { settings.showTokenUsage = boolValue(v) ?? settings.showTokenUsage }
        if let v = db.get("sendWithEnter") { settings.sendWithEnter = boolValue(v) ?? settings.sendWithEnter }

        if let v = db.get("useStreaming") { settings.useStreaming = boolValue(v) ?? settings.useStreaming }
        if let v = db.get("autoTranslate") { settings.autoTranslate = boolValue(v) ?? settings.autoTranslate }
        if let v = db.get("requestRetrys") { settings.requestRetrys = intValue(v) ?? settings.requestRetrys }
        if let v = db.get("autoSuggestPrompt") { settings.autoSuggestMessages = !(stringValue(v) ?? "").isEmpty }

        // Characters.
        var characters: [CharacterCard] = []
        if let v = db.get("characters"), case .array(let arr) = v {
            characters = arr.compactMap(characterFromJs)
        }

        return Loaded(settings: settings, characters: characters)
    }

    // MARK: - Save: (AppSettings, [CharacterCard]) -> JsDatabase

    static func save(settings: AppSettings, characters: [CharacterCard], preserve unknownKeys: [(String, JsValue)] = []) -> JsDatabase {
        var db = JsDatabase()
        db.set("apiType", .string(settings.apiType.rawValue))
        db.set("openAIKey", .string(settings.providers[ProviderKind.openAI.rawValue]?.apiKey ?? ""))
        db.set("claudeAPIKey", .string(settings.providers[ProviderKind.claude.rawValue]?.apiKey ?? ""))
        db.set("openrouterKey", .string(settings.providers[ProviderKind.openRouter.rawValue]?.apiKey ?? ""))
        db.set("mistralKey", .string(settings.providers[ProviderKind.mistral.rawValue]?.apiKey ?? ""))
        db.set("aiModel", .string(settings.providers[settings.apiType.rawValue]?.model ?? ""))
        db.set("subModel", .string(settings.subModel))
        db.set("ollamaURL", .string(settings.ollama.url))
        db.set("ollamaModel", .string(settings.ollama.model))

        db.set("temperature", .number(settings.temperature))
        db.set("maxContext", .number(Double(settings.maxContext)))
        db.set("maxResponse", .number(Double(settings.maxResponse)))
        db.set("frequencyPenalty", .number(settings.frequencyPenalty))
        db.set("PresensePenalty", .number(settings.presencePenalty))
        db.set("top_p", .number(settings.topP))
        db.set("top_k", .number(Double(settings.topK)))
        db.set("generationSeed", .number(Double(settings.generationSeed)))

        db.set("mainPrompt", .string(settings.mainPrompt))
        db.set("jailbreak", .string(settings.jailbreak))
        db.set("globalNote", .string(settings.globalNote))
        db.set("additionalPrompt", .string(settings.additionalPrompt))
        db.set("descriptionPrefix", .string(settings.descriptionPrefix))
        db.set("formatingOrder", .array(settings.formattingOrder.map { .string($0.rawValue) }))

        db.set("loreBookDepth", .number(Double(settings.loreBookDepth)))
        db.set("loreBookToken", .number(Double(settings.loreBookToken)))

        db.set("username", .string(settings.username))
        db.set("userNote", .string(settings.userNote))
        db.set("personaPrompt", .string(settings.personaPrompt))
        db.set("personas", .array(settings.personas.map(personaToJs)))
        db.set("selectedPersona", .number(Double(max(0, settings.personas.firstIndex(where: { $0.id == settings.selectedPersonaId }) ?? -1))))

        db.set("loreBook", .array(settings.loreBooks.map { pageToJs($0) }))
        db.set("globalscript", .array(settings.globalScripts.map(scriptToJs)))

        db.set("memoryAlgorithmType", .string(settings.memoryAlgorithm.rawValue))
        db.set("supaMemoryPrompt", .string(settings.supaMemory.prompt))
        db.set("supaMemoryKey", .string(settings.supaMemory.apiKey))

        db.set("theme", .string(settings.theme.rawValue))
        db.set("fontSize", .number(settings.fontSize))
        db.set("roundIcons", .bool(settings.roundIcons))
        db.set("showTokenUsage", .bool(settings.showTokenUsage))
        db.set("sendWithEnter", .bool(settings.sendWithEnter))
        db.set("useStreaming", .bool(settings.useStreaming))
        db.set("autoTranslate", .bool(settings.autoTranslate))
        db.set("requestRetrys", .number(Double(settings.requestRetrys)))
        db.set("autoSuggestPrompt", .string(settings.autoSuggestMessages ? "enabled" : ""))

        // Preserve unknown keys (so round-trips through the web version don't lose data).
        for (key, value) in unknownKeys where db.get(key) == nil {
            db.set(key, value)
        }

        db.set("characters", .array(characters.map(characterToJs)))
        db.set("pluginCustomStorage", .object([]))
        return db
    }

    // MARK: - Character conversion

    static func characterFromJs(_ value: JsValue) -> CharacterCard? {
        guard case .object(let entries) = value else { return nil }
        func field(_ key: String) -> JsValue? { entries.first(where: { $0.0 == key })?.1 }

        let chaId = stringValue(field("chaId")) ?? UUID().uuidString
        let name = stringValue(field("name")) ?? ""
        guard !name.isEmpty || !entries.isEmpty else { return nil }
        var card = CharacterCard(name: name)
        card.id = UUID(uuidString: chaId) ?? UUID()
        card.nickname = stringValue(field("nickname"))
        card.imageAssetId = stringValue(field("image"))
        card.largePortrait = boolValue(field("largePortrait")) ?? true
        card.desc = stringValue(field("desc")) ?? ""
        card.personality = stringValue(field("personality")) ?? ""
        card.scenario = stringValue(field("scenario")) ?? ""
        card.firstMessage = stringValue(field("firstMessage")) ?? stringValue(field("firstMes")) ?? ""
        card.alternateGreetings = stringArray(field("alternateGreetings"))
        card.exampleMessage = stringValue(field("exampleMessage")) ?? ""
        card.systemPrompt = stringValue(field("systemPrompt")) ?? ""
        card.postHistoryInstructions = stringValue(field("postHistoryInstructions")) ?? ""
        card.creatorNotes = stringValue(field("creatorNotes")) ?? ""
        card.creator = stringValue(field("creator")) ?? ""
        card.characterVersion = stringValue(field("characterVersion")) ?? ""
        card.tags = stringArray(field("tags"))
        card.utilityBot = boolValue(field("utilityBot")) ?? false
        card.replaceGlobalNote = stringValue(field("replaceGlobalNote")) ?? ""
        card.additionalText = stringValue(field("additionalText")) ?? ""
        card.favorite = boolValue(field("favorite")) ?? false
        card.trashTime = doubleValue(field("trashTime"))
        card.lastInteraction = doubleValue(field("lastInteraction"))
        card.creationDate = doubleValue(field("creationDate")) ?? doubleValue(field("creation_date"))
        card.modificationDate = doubleValue(field("modificationDate")) ?? doubleValue(field("modification_date"))

        if let lore = field("globalLore"), case .array(let arr) = lore {
            card.globalLore = arr.compactMap(loreFromJs)
        }
        if let scripts = field("customscript"), case .array(let arr) = scripts {
            card.customScripts = arr.compactMap(scriptFromJs)
        }

        // Chats.
        if let chatsValue = field("chats"), case .array(let chatArr) = chatsValue {
            card.chats = chatArr.compactMap(chatFromJs)
        }
        card.chatPage = intValue(field("chatPage")) ?? max(0, card.chats.count - 1)
        card.chatFolders = (field("chatFolders").flatMap { if case .array(let arr) = $0 { return arr.compactMap(folderFromJs) } else { return [] } }) ?? []
        return card
    }

    static func characterToJs(_ card: CharacterCard) -> JsValue {
        var entries: [(String, JsValue)] = []
        entries.append(("type", .string("character")))
        entries.append(("name", .string(card.name)))
        if let nickname = card.nickname { entries.append(("nickname", .string(nickname))) }
        if let image = card.imageAssetId { entries.append(("image", .string(image))) }
        entries.append(("largePortrait", .bool(card.largePortrait)))
        entries.append(("desc", .string(card.desc)))
        entries.append(("personality", .string(card.personality)))
        entries.append(("scenario", .string(card.scenario)))
        entries.append(("firstMessage", .string(card.firstMessage)))
        entries.append(("alternateGreetings", .array(card.alternateGreetings.map { .string($0) })))
        entries.append(("exampleMessage", .string(card.exampleMessage)))
        entries.append(("systemPrompt", .string(card.systemPrompt)))
        entries.append(("postHistoryInstructions", .string(card.postHistoryInstructions)))
        entries.append(("creatorNotes", .string(card.creatorNotes)))
        entries.append(("creator", .string(card.creator)))
        entries.append(("characterVersion", .string(card.characterVersion)))
        entries.append(("tags", .array(card.tags.map { .string($0) })))
        entries.append(("chaId", .string(card.id.uuidString)))
        entries.append(("utilityBot", .bool(card.utilityBot)))
        entries.append(("replaceGlobalNote", .string(card.replaceGlobalNote)))
        entries.append(("additionalText", .string(card.additionalText)))
        entries.append(("favorite", .bool(card.favorite)))
        if let t = card.trashTime { entries.append(("trashTime", .number(t))) }
        if let c = card.creationDate { entries.append(("creationDate", .number(c))) }
        if let m = card.modificationDate { entries.append(("modificationDate", .number(m))) }
        if let l = card.lastInteraction { entries.append(("lastInteraction", .number(l))) }
        entries.append(("globalLore", .array(card.globalLore.map(loreToJs))))
        entries.append(("customscript", .array(card.customScripts.map(scriptToJs))))
        entries.append(("chats", .array(card.chats.map(chatToJs))))
        entries.append(("chatPage", .number(Double(card.chatPage))))
        entries.append(("chatFolders", .array(card.chatFolders.map(folderToJs))))
        entries.append(("detailsLoaded", .bool(true)))
        entries.append(("viewScreen", .string("none")))
        entries.append(("bias", .array([])))
        entries.append(("emotionImages", .array([])))
        entries.append(("sdData", .array([])))
        entries.append(("triggerscript", .array([])))
        return .object(entries)
    }

    // MARK: - Chat conversion

    static func chatFromJs(_ value: JsValue) -> ChatSession? {
        guard case .object(let entries) = value else { return nil }
        func field(_ key: String) -> JsValue? { entries.first(where: { $0.0 == key })?.1 }
        var chat = ChatSession(name: stringValue(field("name")) ?? "New Chat")
        if let idStr = stringValue(field("id")), let uuid = UUID(uuidString: idStr) { chat.id = uuid }
        chat.note = stringValue(field("note")) ?? ""
        if let lore = field("localLore"), case .array(let arr) = lore {
            chat.localLore = arr.compactMap(loreFromJs)
        }
        chat.fmIndex = intValue(field("fmIndex")) ?? -1
        chat.lastDate = doubleValue(field("lastDate")) ?? chat.lastDate
        chat.bindedPersonaId = stringValue(field("bindedPersona"))
        chat.supaMemoryText = stringValue(field("supaMemoryData"))
        chat.supaMemoryMessageCount = intValue(field("supaMemoryMessageCount"))
        if let suggest = field("suggestMessages"), case .array(let arr) = suggest {
            chat.suggestMessages = arr.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
        }
        if let messages = field("message"), case .array(let msgArr) = messages {
            chat.messages = msgArr.compactMap(messageFromJs)
        }
        return chat
    }

    static func chatToJs(_ chat: ChatSession) -> JsValue {
        var entries: [(String, JsValue)] = []
        entries.append(("id", .string(chat.id.uuidString)))
        entries.append(("name", .string(chat.name)))
        entries.append(("note", .string(chat.note)))
        entries.append(("localLore", .array(chat.localLore.map(loreToJs))))
        entries.append(("fmIndex", .number(Double(chat.fmIndex))))
        entries.append(("lastDate", .number(chat.lastDate)))
        if let persona = chat.bindedPersonaId { entries.append(("bindedPersona", .string(persona))) }
        if let supa = chat.supaMemoryText { entries.append(("supaMemoryData", .string(supa))) }
        if let count = chat.supaMemoryMessageCount { entries.append(("supaMemoryMessageCount", .number(Double(count)))) }
        if let suggest = chat.suggestMessages { entries.append(("suggestMessages", .array(suggest.map { .string($0) }))) }
        entries.append(("message", .array(chat.messages.map(messageToJs))))
        entries.append(("messagesLoaded", .bool(true)))
        entries.append(("detailsLoaded", .bool(true)))
        return .object(entries)
    }

    // MARK: - Message conversion

    static func messageFromJs(_ value: JsValue) -> ChatMessage? {
        guard case .object(let entries) = value else { return nil }
        func field(_ key: String) -> JsValue? { entries.first(where: { $0.0 == key })?.1 }
        let role = stringValue(field("role")) == "user" ? MessageRole.user : .char
        var msg = ChatMessage(role: role, data: stringValue(field("data")) ?? "")
        if let idStr = stringValue(field("chatId")), let uuid = UUID(uuidString: idStr) { msg.id = uuid }
        msg.saying = stringValue(field("saying"))
        msg.name = stringValue(field("name"))
        msg.time = doubleValue(field("time"))
        msg.disabled = boolValue(field("disabled")) ?? false
        msg.isComment = boolValue(field("isComment")) ?? false
        if let info = field("generationInfo"), case .object(let infoEntries) = info {
            var gen = GenerationInfo()
            gen.model = stringValue(infoEntries.first(where: { $0.0 == "model" })?.1)
            gen.inputTokens = intValue(infoEntries.first(where: { $0.0 == "inputTokens" })?.1)
            gen.outputTokens = intValue(infoEntries.first(where: { $0.0 == "outputTokens" })?.1)
            msg.generationInfo = gen
        }
        // Swipes: stored in message extension (web uses db.swipeData keyed by id, or in-message).
        // The native app stores swipes inline; web doesn't have this field, so it won't be present on import.
        return msg
    }

    static func messageToJs(_ msg: ChatMessage) -> JsValue {
        var entries: [(String, JsValue)] = []
        entries.append(("role", .string(msg.role.rawValue)))
        entries.append(("data", .string(msg.data)))
        entries.append(("chatId", .string(msg.id.uuidString))) // web uses chatId as message id
        if let saying = msg.saying { entries.append(("saying", .string(saying))) }
        if let name = msg.name { entries.append(("name", .string(name))) }
        if let time = msg.time { entries.append(("time", .number(time))) }
        entries.append(("disabled", .bool(msg.disabled)))
        entries.append(("isComment", .bool(msg.isComment)))
        if let info = msg.generationInfo {
            var infoEntries: [(String, JsValue)] = []
            if let m = info.model { infoEntries.append(("model", .string(m))) }
            if let i = info.inputTokens { infoEntries.append(("inputTokens", .number(Double(i)))) }
            if let o = info.outputTokens { infoEntries.append(("outputTokens", .number(Double(o)))) }
            if !infoEntries.isEmpty { entries.append(("generationInfo", .object(infoEntries))) }
        }
        // Native-only swipe storage: write into extension nodes too (harmless for web).
        if let swipes = msg.swipes {
            entries.append(("swipes", .array(swipes.map { .string($0) })))
            if let idx = msg.swipeIndex { entries.append(("swipeIndex", .number(Double(idx)))) }
        }
        return .object(entries)
    }

    // MARK: - Lorebook / script / persona / folder conversion

    static func loreFromJs(_ value: JsValue) -> LoreBookEntry? {
        guard case .object(let entries) = value else { return nil }
        func field(_ key: String) -> JsValue? { entries.first(where: { $0.0 == key })?.1 }
        var entry = LoreBookEntry()
        entry.key = stringValue(field("key")) ?? ""
        if let sk = field("secondkey"), case .string(let s) = sk {
            entry.secondKeys = s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        } else if let sk = field("secondKeys"), case .array(let arr) = sk {
            entry.secondKeys = arr.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
        }
        entry.comment = stringValue(field("comment")) ?? ""
        entry.content = stringValue(field("content")) ?? ""
        entry.mode = LoreBookMode(rawValue: stringValue(field("mode")) ?? "normal") ?? .normal
        entry.alwaysActive = boolValue(field("alwaysActive")) ?? false
        entry.selective = boolValue(field("selective")) ?? false
        entry.insertOrder = intValue(field("insertorder")) ?? 100
        entry.useRegex = boolValue(field("useRegex")) ?? false
        entry.enabled = boolValue(field("enabled")) ?? true
        return entry
    }

    static func loreToJs(_ entry: LoreBookEntry) -> JsValue {
        var entries: [(String, JsValue)] = []
        entries.append(("key", .string(entry.key)))
        entries.append(("secondkey", .string(entry.secondKeys.joined(separator: ","))))
        entries.append(("comment", .string(entry.comment)))
        entries.append(("content", .string(entry.content)))
        entries.append(("mode", .string(entry.mode.rawValue)))
        entries.append(("alwaysActive", .bool(entry.alwaysActive)))
        entries.append(("selective", .bool(entry.selective)))
        entries.append(("insertorder", .number(Double(entry.insertOrder))))
        entries.append(("useRegex", .bool(entry.useRegex)))
        entries.append(("enabled", .bool(entry.enabled)))
        return .object(entries)
    }

    static func scriptFromJs(_ value: JsValue) -> CustomScriptEntry? {
        guard case .object(let entries) = value else { return nil }
        func field(_ key: String) -> JsValue? { entries.first(where: { $0.0 == key })?.1 }
        var script = CustomScriptEntry()
        script.comment = stringValue(field("comment")) ?? ""
        script.findRegex = stringValue(field("in")) ?? ""
        script.replaceWith = stringValue(field("out")) ?? ""
        let typeStr = stringValue(field("type")) ?? "output"
        script.placement = ScriptPlacement(rawValue: typeStr) ?? .output
        script.enabled = boolValue(field("flag")) ?? true
        return script
    }

    static func scriptToJs(_ script: CustomScriptEntry) -> JsValue {
        var entries: [(String, JsValue)] = []
        entries.append(("comment", .string(script.comment)))
        entries.append(("in", .string(script.findRegex)))
        entries.append(("out", .string(script.replaceWith)))
        entries.append(("type", .string(script.placement.rawValue)))
        entries.append(("flag", .bool(script.enabled)))
        entries.append(("ableFlag", .bool(true)))
        return .object(entries)
    }

    static func personaFromJs(_ value: JsValue) -> PersonaPreset? {
        guard case .object(let entries) = value else { return nil }
        func field(_ key: String) -> JsValue? { entries.first(where: { $0.0 == key })?.1 }
        var persona = PersonaPreset(name: stringValue(field("name")) ?? "")
        if let idStr = stringValue(field("id")), let uuid = UUID(uuidString: idStr) { persona.id = uuid }
        persona.personaPrompt = stringValue(field("personaPrompt")) ?? ""
        persona.iconAssetId = stringValue(field("icon"))
        persona.largePortrait = boolValue(field("largePortrait")) ?? false
        persona.note = stringValue(field("note")) ?? ""
        return persona
    }

    static func personaToJs(_ persona: PersonaPreset) -> JsValue {
        var entries: [(String, JsValue)] = []
        entries.append(("id", .string(persona.id.uuidString)))
        entries.append(("name", .string(persona.name)))
        entries.append(("personaPrompt", .string(persona.personaPrompt)))
        if let icon = persona.iconAssetId { entries.append(("icon", .string(icon))) }
        entries.append(("largePortrait", .bool(persona.largePortrait)))
        entries.append(("note", .string(persona.note)))
        return .object(entries)
    }

    static func folderFromJs(_ value: JsValue) -> ChatFolder? {
        guard case .object(let entries) = value else { return nil }
        func field(_ key: String) -> JsValue? { entries.first(where: { $0.0 == key })?.1 }
        var folder = ChatFolder(name: stringValue(field("name")) ?? "")
        if let idStr = stringValue(field("id")), let uuid = UUID(uuidString: idStr) { folder.id = uuid }
        folder.colorHex = stringValue(field("color"))
        folder.folded = boolValue(field("folded")) ?? false
        return folder
    }

    static func folderToJs(_ folder: ChatFolder) -> JsValue {
        var entries: [(String, JsValue)] = []
        entries.append(("id", .string(folder.id.uuidString)))
        entries.append(("name", .string(folder.name)))
        if let color = folder.colorHex { entries.append(("color", .string(color))) }
        entries.append(("folded", .bool(folder.folded)))
        return .object(entries)
    }

    static func pageToJs(_ page: LoreBookPage) -> JsValue {
        var entries: [(String, JsValue)] = []
        entries.append(("name", .string(page.name)))
        entries.append(("data", .array(page.entries.map(loreToJs))))
        return .object(entries)
    }

    // MARK: - Primitive extractors

    static func stringValue(_ v: JsValue?, _ default_: String = "") -> String? {
        guard let v else { return nil }
        switch v {
        case .string(let s): return s.isEmpty ? default_ : s
        case .number(let n): return String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return nil
        case .undefined: return nil
        default: return nil
        }
    }

    static func doubleValue(_ v: JsValue?) -> Double? {
        guard let v else { return nil }
        if case .number(let n) = v { return n }
        if case .bool(let b) = v { return b ? 1 : 0 }
        if case .string(let s) = v { return Double(s) }
        return nil
    }

    static func intValue(_ v: JsValue?) -> Int? {
        guard let v else { return nil }
        if case .number(let n) = v { return Int(n) }
        if case .bool(let b) = v { return b ? 1 : 0 }
        if case .string(let s) = v { return Int(s) }
        return nil
    }

    static func boolValue(_ v: JsValue?) -> Bool? {
        guard let v else { return nil }
        if case .bool(let b) = v { return b }
        if case .number(let n) = v { return n != 0 }
        return nil
    }

    static func stringArray(_ v: JsValue?) -> [String] {
        guard let v, case .array(let arr) = v else { return [] }
        return arr.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}