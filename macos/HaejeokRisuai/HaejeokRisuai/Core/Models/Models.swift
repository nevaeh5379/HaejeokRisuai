import Foundation

// MARK: - Message

enum MessageRole: String, Codable, Hashable {
    case user
    case char
}

struct GenerationInfo: Codable, Hashable {
    var model: String?
    var inputTokens: Int?
    var outputTokens: Int?

    init(model: String? = nil, inputTokens: Int? = nil, outputTokens: Int? = nil) {
        self.model = model
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
    }
}

struct ChatMessage: Codable, Identifiable, Hashable {
    var id: UUID
    var role: MessageRole
    var data: String
    var saying: String?
    var name: String?
    var time: Double?
    var disabled: Bool
    var isComment: Bool
    var generationInfo: GenerationInfo?
    /// Alternate generated variants. `swipes[swipeIndex]` is the displayed text when present.
    var swipes: [String]?
    var swipeIndex: Int?

    init(
        id: UUID = UUID(),
        role: MessageRole,
        data: String,
        saying: String? = nil,
        name: String? = nil,
        time: Double? = nil,
        disabled: Bool = false,
        isComment: Bool = false,
        generationInfo: GenerationInfo? = nil,
        swipes: [String]? = nil,
        swipeIndex: Int? = nil
    ) {
        self.id = id
        self.role = role
        self.data = data
        self.saying = saying
        self.name = name
        self.time = time ?? Date().timeIntervalSince1970 * 1000
        self.disabled = disabled
        self.isComment = isComment
        self.generationInfo = generationInfo
        self.swipes = swipes
        self.swipeIndex = swipeIndex
    }
}

// MARK: - Chat

struct ChatSession: Codable, Identifiable, Hashable {
    var id: UUID
    var name: String
    var note: String
    var messages: [ChatMessage]
    var localLore: [LoreBookEntry]
    /// -1 means the character's default first message, otherwise an index into alternateGreetings.
    var fmIndex: Int
    var lastDate: Double
    var bindedPersonaId: String?
    var supaMemoryText: String?
    /// Number of leading messages already folded into supaMemoryText.
    var supaMemoryMessageCount: Int?
    var suggestMessages: [String]?

    init(
        id: UUID = UUID(),
        name: String = "New Chat",
        note: String = "",
        messages: [ChatMessage] = [],
        localLore: [LoreBookEntry] = [],
        fmIndex: Int = -1,
        lastDate: Double = Date().timeIntervalSince1970 * 1000,
        bindedPersonaId: String? = nil,
        supaMemoryText: String? = nil,
        supaMemoryMessageCount: Int? = nil,
        suggestMessages: [String]? = nil
    ) {
        self.id = id
        self.name = name
        self.note = note
        self.messages = messages
        self.localLore = localLore
        self.fmIndex = fmIndex
        self.lastDate = lastDate
        self.bindedPersonaId = bindedPersonaId
        self.supaMemoryText = supaMemoryText
        self.supaMemoryMessageCount = supaMemoryMessageCount
        self.suggestMessages = suggestMessages
    }
}

// MARK: - Lorebook

enum LoreBookMode: String, Codable, Hashable {
    case normal
    case constant
    case multiple
    case child
    case folder
}

struct LoreBookEntry: Codable, Identifiable, Hashable {
    var id: UUID
    var key: String
    var secondKeys: [String]
    var comment: String
    var content: String
    var mode: LoreBookMode
    var alwaysActive: Bool
    var selective: Bool
    var insertOrder: Int
    var activationPercent: Int?
    var useRegex: Bool
    var caseSensitive: Bool
    var enabled: Bool

    init(
        id: UUID = UUID(),
        key: String = "",
        secondKeys: [String] = [],
        comment: String = "",
        content: String = "",
        mode: LoreBookMode = .normal,
        alwaysActive: Bool = false,
        selective: Bool = false,
        insertOrder: Int = 100,
        activationPercent: Int? = nil,
        useRegex: Bool = false,
        caseSensitive: Bool = false,
        enabled: Bool = true
    ) {
        self.id = id
        self.key = key
        self.secondKeys = secondKeys
        self.comment = comment
        self.content = content
        self.mode = mode
        self.alwaysActive = alwaysActive
        self.selective = selective
        self.insertOrder = insertOrder
        self.activationPercent = activationPercent
        self.useRegex = useRegex
        self.caseSensitive = caseSensitive
        self.enabled = enabled
    }
}

/// A named collection of lorebook entries (like Risu's global lorebook pages).
struct LoreBookPage: Codable, Identifiable, Hashable {
    var id: UUID
    var name: String
    var entries: [LoreBookEntry]

    init(id: UUID = UUID(), name: String = "New Book", entries: [LoreBookEntry] = []) {
        self.id = id
        self.name = name
        self.entries = entries
    }
}

// MARK: - Regex script

enum ScriptPlacement: String, Codable, CaseIterable, Hashable {
    case input = "input"
    case output = "output"
    case slashCommand = "slashcommand"
    case editProcess = "editprocess"

    var label: String {
        switch self {
        case .input: return "Input"
        case .output: return "Output"
        case .slashCommand: return "Slash Command"
        case .editProcess: return "Edit Process"
        }
    }
}

struct CustomScriptEntry: Codable, Identifiable, Hashable {
    var id: UUID
    var comment: String
    var findRegex: String
    var replaceWith: String
    var placement: ScriptPlacement
    var enabled: Bool
    var minDepth: Int?
    var maxDepth: Int?

    init(
        id: UUID = UUID(),
        comment: String = "",
        findRegex: String = "",
        replaceWith: String = "",
        placement: ScriptPlacement = .output,
        enabled: Bool = true,
        minDepth: Int? = nil,
        maxDepth: Int? = nil
    ) {
        self.id = id
        self.comment = comment
        self.findRegex = findRegex
        self.replaceWith = replaceWith
        self.placement = placement
        self.enabled = enabled
        self.minDepth = minDepth
        self.maxDepth = maxDepth
    }
}

// MARK: - Persona

struct PersonaPreset: Codable, Identifiable, Hashable {
    var id: UUID
    var name: String
    var personaPrompt: String
    var iconAssetId: String?
    var largePortrait: Bool
    var note: String

    init(
        id: UUID = UUID(),
        name: String = "",
        personaPrompt: String = "",
        iconAssetId: String? = nil,
        largePortrait: Bool = false,
        note: String = ""
    ) {
        self.id = id
        self.name = name
        self.personaPrompt = personaPrompt
        self.iconAssetId = iconAssetId
        self.largePortrait = largePortrait
        self.note = note
    }
}

// MARK: - Bot preset

struct BotPreset: Codable, Identifiable, Hashable {
    var id: UUID
    var name: String
    var mainPrompt: String
    var jailbreak: String
    var globalNote: String
    var temperature: Double
    var maxContext: Int
    var maxResponse: Int
    var frequencyPenalty: Double
    var presencePenalty: Double
    var topP: Double
    var topK: Int

    init(
        id: UUID = UUID(),
        name: String = "Default",
        mainPrompt: String = AppSettings.standard.mainPrompt,
        jailbreak: String = AppSettings.standard.jailbreak,
        globalNote: String = "",
        temperature: Double = 0.75,
        maxContext: Int = 4022,
        maxResponse: Int = 500,
        frequencyPenalty: Double = 0.7,
        presencePenalty: Double = 0.7,
        topP: Double = 1.0,
        topK: Int = 0
    ) {
        self.id = id
        self.name = name
        self.mainPrompt = mainPrompt
        self.jailbreak = jailbreak
        self.globalNote = globalNote
        self.temperature = temperature
        self.maxContext = maxContext
        self.maxResponse = maxResponse
        self.frequencyPenalty = frequencyPenalty
        self.presencePenalty = presencePenalty
        self.topP = topP
        self.topK = topK
    }
}

// MARK: - Character

struct CharacterCard: Codable, Identifiable, Hashable {
    var id: UUID
    var name: String
    var nickname: String?
    var imageAssetId: String?
    var largePortrait: Bool
    var desc: String
    var personality: String
    var scenario: String
    var firstMessage: String
    var alternateGreetings: [String]
    var exampleMessage: String
    var systemPrompt: String
    var postHistoryInstructions: String
    var creatorNotes: String
    var creator: String
    var characterVersion: String
    var tags: [String]
    var chats: [ChatSession]
    var chatPage: Int
    var chatFolders: [ChatFolder]
    var globalLore: [LoreBookEntry]
    var customScripts: [CustomScriptEntry]
    var utilityBot: Bool
    var replaceGlobalNote: String
    var additionalText: String
    var favorite: Bool
    var trashTime: Double?
    var lastInteraction: Double?
    var creationDate: Double?
    var modificationDate: Double?
    var sources: [String]?

    init(
        id: UUID = UUID(),
        name: String,
        nickname: String? = nil,
        imageAssetId: String? = nil,
        largePortrait: Bool = false,
        desc: String = "",
        personality: String = "",
        scenario: String = "",
        firstMessage: String = "",
        alternateGreetings: [String] = [],
        exampleMessage: String = "",
        systemPrompt: String = "",
        postHistoryInstructions: String = "",
        creatorNotes: String = "",
        creator: String = "",
        characterVersion: String = "",
        tags: [String] = [],
        chats: [ChatSession] = [],
        chatPage: Int = 0,
        chatFolders: [ChatFolder] = [],
        globalLore: [LoreBookEntry] = [],
        customScripts: [CustomScriptEntry] = [],
        utilityBot: Bool = false,
        replaceGlobalNote: String = "",
        additionalText: String = "",
        favorite: Bool = false,
        trashTime: Double? = nil,
        lastInteraction: Double? = nil,
        creationDate: Double? = Date().timeIntervalSince1970 * 1000,
        modificationDate: Double? = Date().timeIntervalSince1970 * 1000,
        sources: [String]? = nil
    ) {
        self.id = id
        self.name = name
        self.nickname = nickname
        self.imageAssetId = imageAssetId
        self.largePortrait = largePortrait
        self.desc = desc
        self.personality = personality
        self.scenario = scenario
        self.firstMessage = firstMessage
        self.alternateGreetings = alternateGreetings
        self.exampleMessage = exampleMessage
        self.systemPrompt = systemPrompt
        self.postHistoryInstructions = postHistoryInstructions
        self.creatorNotes = creatorNotes
        self.creator = creator
        self.characterVersion = characterVersion
        self.tags = tags
        self.chats = chats
        self.chatPage = chatPage
        self.chatFolders = chatFolders
        self.globalLore = globalLore
        self.customScripts = customScripts
        self.utilityBot = utilityBot
        self.replaceGlobalNote = replaceGlobalNote
        self.additionalText = additionalText
        self.favorite = favorite
        self.trashTime = trashTime
        self.lastInteraction = lastInteraction
        self.creationDate = creationDate
        self.modificationDate = modificationDate
        self.sources = sources
    }

    /// The active chat session, creating a fresh one if none exists.
    func currentChat() -> ChatSession {
        if chats.isEmpty { return ChatSession(name: name) }
        return chats[max(0, min(chatPage, chats.count - 1))]
    }

    mutating func ensureChatExists() {
        if chats.isEmpty {
            let chat = ChatSession(
                name: "New Chat",
                messages: [ChatMessage(role: .char, data: firstMessage)]
            )
            chats = [chat]
            chatPage = 0
        }
    }

    func firstMessageText(fmIndex: Int) -> String? {
        if fmIndex == -1 { return firstMessage.isEmpty ? nil : firstMessage }
        let idx = fmIndex
        if idx >= 0 && idx < alternateGreetings.count {
            return alternateGreetings[idx]
        }
        return firstMessage.isEmpty ? nil : firstMessage
    }
}

struct ChatFolder: Codable, Identifiable, Hashable {
    var id: UUID
    var name: String
    var colorHex: String?
    var folded: Bool

    init(id: UUID = UUID(), name: String = "", colorHex: String? = nil, folded: Bool = false) {
        self.id = id
        self.name = name
        self.colorHex = colorHex
        self.folded = folded
    }
}

// MARK: - Providers

enum ProviderKind: String, Codable, CaseIterable, Identifiable, Hashable {
    case openAI
    case claude
    case google
    case openRouter
    case mistral
    case deepInfra
    case ollama
    case customProxy

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .openAI: return "OpenAI"
        case .claude: return "Anthropic Claude"
        case .google: return "Google Gemini"
        case .openRouter: return "OpenRouter"
        case .mistral: return "Mistral"
        case .deepInfra: return "DeepInfra"
        case .ollama: return "Ollama"
        case .customProxy: return "Custom (OpenAI Compatible)"
        }
    }

    var usesOpenAIProtocol: Bool {
        switch self {
        case .claude, .google: return false
        default: return true
        }
    }
}

// MARK: - Formatting order

enum FormattingOrderItem: String, Codable, CaseIterable, Hashable {
    case main
    case description
    case personaPrompt
    case chats
    case lastChat
    case jailbreak
    case lorebook
    case globalNote
    case authorNote
    case postEverything

    var label: String {
        switch self {
        case .main: return "Main Prompt"
        case .description: return "Character Description"
        case .personaPrompt: return "Persona"
        case .chats: return "Chat History"
        case .lastChat: return "Last Chat Pointer"
        case .jailbreak: return "Jailbreak (Post-History)"
        case .lorebook: return "Lorebook"
        case .globalNote: return "Global Note"
        case .authorNote: return "Author's Note"
        case .postEverything: return "Post-Everything Instructions"
        }
    }
}

// MARK: - Theme

enum ColorThemeKind: String, Codable, CaseIterable, Identifiable {
    case dark
    case light
    case midnight
    case sakura
    case ocean
    case forest

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .dark: return "Dark"
        case .light: return "Light"
        case .midnight: return "Midnight Blue"
        case .sakura: return "Sakura"
        case .ocean: return "Deep Ocean"
        case .forest: return "Forest"
        }
    }
}

// MARK: - Memory algorithm

enum MemoryAlgorithmType: String, Codable, CaseIterable, Identifiable {
    case none
    case supaMemory

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .none: return "None"
        case .supaMemory: return "SupaMemory (Summarization)"
        }
    }
}
