import Foundation
import Testing
@testable import HaejeokRisuai

struct PNGChunksTests {
    @Test func roundTripTextChunks() throws {
        // Build a minimal valid PNG (1x1 black).
        var png = Data(PNGChunks.signature)
        let ihdr: [UInt8] = [0, 0, 0, 13] + Array("IHDR".utf8)
            + [0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]
        png.append(contentsOf: ihdr + [0x1F, 0x15, 0xC4, 0x89]) // dummy CRC (parser ignores)
        let iend = Array("IEND".utf8)
        png.append(contentsOf: [0, 0, 0, 0] + iend + [0xAE, 0x42, 0x60, 0x82])

        let withChunk = PNGChunks.writeTextChunks(
            to: png,
            chunks: [.init(key: "chara", value: "aGVsbG8=")]
        )

        let chunks = try PNGChunks.readTextChunks(withChunk)
        #expect(chunks.contains { $0.key == "chara" && $0.value == "aGVsbG8=" })
    }

    @Test func rejectsNonPNG() {
        #expect(throws: PNGChunks.PNGError.notPNG.self) {
            _ = try PNGChunks.readTextChunks(Data("not a png".utf8))
        }
    }
}

struct ZipArchiveTests {
    @Test func roundTrip() throws {
        let entries = [
            ZipArchive.Entry(path: "card.json", data: Data(#"{"spec":"chara_card_v2"}"#.utf8)),
            ZipArchive.Entry(path: "assets/portrait.png", data: Data([0x89, 0x50, 0x4E, 0x47])),
        ]
        let zipData = ZipArchive.write(entries: entries)

        let readBack = try ZipArchive.read(zipData)
        #expect(readBack.count == 2)
        #expect(readBack[0].path == "card.json")
        #expect(readBack[0].data == entries[0].data)
        #expect(readBack[1].path == "assets/portrait.png")
        #expect(readBack[1].data == entries[1].data)
    }

    @Test func rejectsNonZip() async throws {
        do {
            _ = try ZipArchive.read(Data("garbage data here".utf8))
            Issue.record("Expected error")
        } catch {
            // expected
        }
    }
}

struct MsgPackTests {
    @Test func decodesFixIntsAndStrings() throws {
        let s = try MsgPack.decode(Data([0xA2, 0x68, 0x69])) as? String
        let i = try MsgPack.decode(Data([0x05])) as? Int
        let neg = try MsgPack.decode(Data([0xFF])) as? Int
        let n = try MsgPack.decode(Data([0xC0]))
        let b = try MsgPack.decode(Data([0xC3])) as? Bool
        let f = try MsgPack.decode(Data([0xCB, 0x3F, 0xF0, 0, 0, 0, 0, 0, 0])) as? Double
        #expect(s == "hi")
        #expect(i == 5)
        #expect(neg == -1)
        #expect(n == nil)
        #expect(b == true)
        #expect(f == 1.0)
    }

    @Test func decodesMapAndArray() throws {
        // {"a": 1, "b": [2]} -> fixmap 0x82, fixstr a, int 1, fixstr b, fixarray(1) int 2
        let bytes: [UInt8] = [0x82, 0xA1, 0x61, 0x01, 0xA1, 0x62, 0x91, 0x02]
        let map = try MsgPack.decode(Data(bytes)) as? [String: Any?]
        #expect(map?["a"] as? Int == 1)
        let arr = map?["b"] as? [Any?]
        #expect(arr?.first as? Int == 2)
    }
}

struct TokenEstimatorTests {
    @Test func englishEstimate() {
        let tokens = TokenEstimator.estimate("Hello world, this is a test sentence.")
        #expect(tokens > 5 && tokens < 20)
    }

    @Test func koreanEstimate() {
        let tokens = TokenEstimator.estimate("안녕하세요 세계입니다")
        #expect(tokens > 4)
    }

    @Test func empty() {
        #expect(TokenEstimator.estimate("") == 0)
    }
}

struct LorebookEngineTests {
    @Test func activatesOnKeyword() {
        let settings = AppSettings()
        var entry = LoreBookEntry(key: "dragon", content: "Dragons are ancient reptiles.")
        entry.enabled = true

        let history = [ChatMessage(role: .user, data: "I see a dragon flying overhead!")]

        let activated = LorebookEngine.activate(
            characterLore: [entry],
            chatLore: [],
            globalBooks: [],
            history: history,
            settings: settings
        )
        #expect(activated.count == 1)
    }

    @Test func constantAlwaysActivates() {
        let settings = AppSettings()
        var entry = LoreBookEntry(content: "The world is medieval.")
        entry.mode = .constant
        entry.alwaysActive = false

        let activated = LorebookEngine.activate(
            characterLore: [entry],
            chatLore: [],
            globalBooks: [],
            history: [],
            settings: settings
        )
        #expect(activated.count == 1)
    }

    @Test func noMatchNoActivate() {
        let settings = AppSettings()
        let entry = LoreBookEntry(key: "dragon", content: "Dragons.")
        let history = [ChatMessage(role: .user, data: "Nothing relevant here.")]
        let activated = LorebookEngine.activate(
            characterLore: [entry],
            chatLore: [],
            globalBooks: [],
            history: history,
            settings: settings
        )
        #expect(activated.isEmpty)
    }
}

struct PromptBuilderTests {
    @Test func buildsSystemAndHistory() {
        let settings = AppSettings.standard
        var char = CharacterCard(name: "Aria")
        char.desc = "An elven archer."
        let chat = ChatSession(messages: [
            ChatMessage(role: .char, data: "Hello traveler."),
            ChatMessage(role: .user, data: "Hi Aria!"),
        ])

        let builder = PromptBuilder(settings: settings, character: char, chat: chat, personaPrompt: "", username: "Hero")
        let built = builder.build()

        #expect(built.messages.count >= 2)
        #expect(built.messages.first?.role == "system")
        #expect(built.messages.first?.content.contains("elven archer") == true)
        #expect(built.messages.contains { $0.role == "assistant" && $0.content.contains("Hello traveler") })
        #expect(built.messages.contains { $0.role == "user" && $0.content.contains("Hi Aria") })
    }

    @Test func placeholderSubstitution() {
        let settings = AppSettings.standard
        let char = CharacterCard(name: "Kael")
        let chat = ChatSession()
        let builder = PromptBuilder(settings: settings, character: char, chat: chat, personaPrompt: "", username: "Rin")
        #expect(builder.replacePlaceholders("{{char}} loves {{user}}") == "Kael loves Rin")
    }

    @Test func jailbreakAppendedLast() {
        let settings = AppSettings.standard
        var char = CharacterCard(name: "Bot")
        let chat = ChatSession(messages: [ChatMessage(role: .user, data: "hey")])
        _ = char

        let builder = PromptBuilder(settings: settings, character: char, chat: chat, personaPrompt: "", username: "U")
        let built = builder.build()
        #expect(built.messages.last?.content.contains("System note") == true || built.messages.last?.role == "system")
    }
}

struct CharacterCardIOTests {
    @Test func parsesV2JSON() throws {
        let json = """
        {
          "spec": "chara_card_v2",
          "spec_version": "2.0",
          "data": {
            "name": "Test Char",
            "description": "A test character.",
            "first_mes": "Greetings!",
            "personality": "curious",
            "scenario": "a lab",
            "alternate_greetings": ["Alt hello"],
            "tags": ["test"],
            "extensions": {}
          }
        }
        """
        let card = try CharacterCardIO.importJSON(Data(json.utf8), fallbackName: "fallback")

        #expect(card.name == "Test Char")
        #expect(card.desc == "A test character.")
        #expect(card.firstMessage == "Greetings!")
        #expect(card.alternateGreetings == ["Alt hello"])
        #expect(card.tags == ["test"])
        #expect(!card.chats.isEmpty)
    }

    @Test func parsesOldTavernFormat() throws {
        let json = """
        {
          "name": "Tavern Guy",
          "description": "Old format.",
          "first_mes": "Yo!",
          "personality": "chill",
          "scenario": "tavern"
        }
        """
        let card = try CharacterCardIO.importJSON(Data(json.utf8), fallbackName: "x")
        #expect(card.name == "Tavern Guy")
        #expect(card.firstMessage == "Yo!")
    }

    @Test func exportsAndReimportsRoundTrip() throws {
        var card = CharacterCard(name: "Round Trip")
        card.desc = "Testing round trip."
        card.firstMessage = "First!"
        card.personality = "brave"
        let spec = CharacterCardIO.exportSpecDictionary(from: card)
        let data = try JSONSerialization.data(withJSONObject: spec, options: [])
        let reimported = try CharacterCardIO.importJSON(data, fallbackName: "any")
        #expect(reimported.name == "Round Trip")
        #expect(reimported.desc == "Testing round trip.")
        #expect(reimported.firstMessage == "First!")
    }
}

struct RisuSaveImporterTests {
    @Test func detectsBlockFormatHeader() {
        var data = Data("RISUSAVE\0".utf8)
        data.append(contentsOf: [0xFF])
        #expect(RisuSaveImporter.canImport(data))
        #expect(!RisuSaveImporter.canImport(Data([0x00, 0x01])))
    }
}
