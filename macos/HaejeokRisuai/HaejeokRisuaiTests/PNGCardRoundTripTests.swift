import AppKit
import Foundation
import Testing
@testable import HaejeokRisuai

/// End-to-end PNG character card round trip: export → import → verify fields.
@MainActor
struct PNGCardRoundTripTests {

    @Test func exportThenImportPNG() throws {
        var card = CharacterCard(name: "Pirate Queen")
        card.desc = "Captain of the Haejeok."
        card.firstMessage = "Welcome aboard, sailor."
        card.personality = "fearless"
        card.scenario = "the high seas"
        card.tags = ["pirate", "adventure"]
        card.alternateGreetings = ["Ahoy!"]
        card.globalLore = [
            LoreBookEntry(key: "ship", comment: "ship lore", content: "The Red Pearl is her ship.")
        ]

        // Render a simple portrait.
        let image = NSImage(size: NSSize(width: 64, height: 64))
        image.lockFocus()
        NSColor.systemBlue.setFill()
        NSBezierPath(rect: NSRect(x: 0, y: 0, width: 64, height: 64)).fill()
        image.unlockFocus()

        let pngData = try CharacterCardIO.exportPNG(from: card, portrait: image)

        // Sanity: the PNG must still be a valid image and carry the chunk.
        #expect(NSImage(data: pngData) != nil)
        let chunks = try PNGChunks.readTextChunks(pngData)
        #expect(chunks.contains { $0.key == "chara" })

        let imported = try CharacterCardIO.importPNG(pngData, fallbackName: "fallback")

        #expect(imported.name == "Pirate Queen")
        #expect(imported.desc == "Captain of the Haejeok.")
        #expect(imported.firstMessage == "Welcome aboard, sailor.")
        #expect(imported.personality == "fearless")
        #expect(imported.scenario == "the high seas")
        #expect(imported.tags == ["pirate", "adventure"])
        #expect(imported.alternateGreetings == ["Ahoy!"])
        #expect(imported.globalLore.count == 1)
        #expect(imported.globalLore.first?.content == "The Red Pearl is her ship.")
        #expect(imported.imageAssetId != nil)
        #expect(!imported.chats.isEmpty)
    }

    @Test func charxRoundTrip() throws {
        var card = CharacterCard(name: "CharX Test")
        card.desc = "Archive based card."
        card.firstMessage = "Hi from charx!"

        let charxData = try CharacterCardIO.exportCharX(from: card, portrait: nil)
        let imported = try CharacterCardIO.importCharX(charxData, fallbackName: "any")

        #expect(imported.name == "CharX Test")
        #expect(imported.desc == "Archive based card.")
        #expect(imported.firstMessage == "Hi from charx!")
    }
}
