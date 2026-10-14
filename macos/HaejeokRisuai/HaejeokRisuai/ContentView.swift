import SwiftUI
import UniformTypeIdentifiers

/// Root layout: character sidebar + chat area, with alert overlay.
struct ContentView: View {
    @EnvironmentObject private var db: DatabaseStore
    @EnvironmentObject private var alerts: AlertCenter
    @Environment(\.risuTheme) private var theme

    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var editingCharacter: CharacterCard?
    @State private var creatingCharacter = false

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            CharacterListView(
                onEditCharacter: { char in editingCharacter = char }
            )
            .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 420)
        } detail: {
            if db.selectedCharId != nil && db.selectedCharacter != nil {
                ChatScreenView()
            } else {
                EmptyStateView()
            }
        }
        .background(theme.background)
        .sheet(item: $editingCharacter) { char in
            CharacterEditorView(characterId: char.id)
                .environment(\.risuTheme, theme)
        }
        .sheet(isPresented: $creatingCharacter) {
            NewCharacterSheet()
                .environment(\.risuTheme, theme)
        }
        .onAppear(perform: wireCoordinator)
        .overlay(alignment: .top) {
            AlertOverlay()
        }
    }

    private func wireCoordinator() {
        ImportExportCoordinator.shared.onRequest = { request in
            switch request {
            case .importCards:
                importCards()
            case .importLegacySave:
                importLegacySave()
            case .importBinBackup:
                importBinBackup()
            case .exportPNG:
                exportSelected(as: .png)
            case .exportCharX:
                exportSelected(as: .charx)
            case .newChat:
                if let id = db.selectedCharId {
                    DatabaseStore.shared.newChat(characterId: id)
                }
            case .newCharacter:
                creatingCharacter = true
            }
        }
    }

    // MARK: - Import

    private func importBinBackup() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.data] + ["bin", "risubackup"].compactMap { UTType(filenameExtension: $0) }
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                let data = try Data(contentsOf: url)
                let result = try BackupImporter.importBackup(data)
                // Replace the SQL database with the imported one.
                try RisuSqliteStorage.shared.replaceDatabase(result.database)
                // Reload the store from the freshly-written database.
                let loaded = try RisuSqliteStorage.shared.loadDatabase()
                let bridged = JsDatabaseBridge.load(from: loaded.database)
                let store = DatabaseStore.shared
                store.settings = bridged.settings
                store.characters = bridged.characters
                store.saveNow()
                AlertCenter.shared.success("Imported backup: \(result.characterCount) characters, \(result.assetCount) assets")
            } catch {
                AlertCenter.shared.error(error)
            }
        }
    }

    private func importCards() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.png, .json, UTType.charx, .jpeg]
        panel.begin { response in
            guard response == .OK else { return }
            for url in panel.urls {
                do {
                    let card = try CharacterCardIO.importCard(from: url)
                    DatabaseStore.shared.addCharacter(card)
                    AlertCenter.shared.success("Imported \(card.name)")
                } catch {
                    AlertCenter.shared.error(error)
                }
            }
        }
    }

    private func importLegacySave() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [UTType.risuSaveType, .data]
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                let data = try Data(contentsOf: url)
                guard RisuSaveImporter.canImport(data) else {
                    throw CharacterCardIO.CardError.unsupported("This file is not a Risu save.")
                }
                let result = try RisuSaveImporter.importSave(data)

                let store = DatabaseStore.shared
                for var card in result.characters {
                    if store.characters.contains(where: { $0.id == card.id }) {
                        card.id = UUID()
                    }
                    store.addCharacter(card)
                }

                // Merge lorebook pages and personas.
                if !result.loreBooks.isEmpty {
                    store.settings.loreBooks.append(contentsOf: result.loreBooks)
                }
                if !result.personas.isEmpty {
                    let existing = Set(store.settings.personas.map(\.id))
                    for p in result.personas where !existing.contains(p.id) {
                        store.settings.personas.append(p)
                    }
                }

                // Port legacy settings fields when present.
                applyLegacySettings(result.settingsPatch)

                store.saveNow()
                AlertCenter.shared.success("Imported \(result.characters.count) characters from save")
            } catch {
                AlertCenter.shared.error(error)
            }
        }
    }

    private func applyLegacySettings(_ root: [String: Any?]) {
        var s = DatabaseStore.shared.settings
        let usernameV = root.stringField(["username"])
        if !usernameV.isEmpty { s.username = usernameV }
        let mainPromptV = root.optionalStringField("mainPrompt")
        if let v = mainPromptV, !v.isEmpty { s.mainPrompt = v }
        let jailbreakV = root.optionalStringField("jailbreak")
        if let v = jailbreakV { s.jailbreak = v }
        let globalNoteV = root.optionalStringField("globalNote")
        if let v = globalNoteV { s.globalNote = v }
        let temp = root.numberField(["temperature"], fallback: -1)
        if temp >= 0 { s.temperature = temp }
        let maxCtx = Int(root.numberField(["maxContext"], fallback: -1))
        if maxCtx > 0 { s.maxContext = maxCtx }
        let maxRes = Int(root.numberField(["maxResponse"], fallback: -1))
        if maxRes > 0 { s.maxResponse = maxRes }
        let personaPromptV = root.optionalStringField("personaPrompt")
        if let v = personaPromptV, !v.isEmpty { s.personaPrompt = v }
        DatabaseStore.shared.settings = s
    }

    // MARK: - Export

    private func exportSelected(as format: CharacterExporterFormat) {
        guard let char = DatabaseStore.shared.selectedCharacter else {
            AlertCenter.shared.info("Select a character first.")
            return
        }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = char.name
        panel.allowedContentTypes = [format == .png ? .png : UTType.charx]
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                let portrait = AssetStore.shared.loadImage(char.imageAssetId)
                let data: Data
                switch format {
                case .png:
                    data = try CharacterCardIO.exportPNG(from: char, portrait: portrait)
                case .charx:
                    data = try CharacterCardIO.exportCharX(from: char, portrait: portrait)
                }
                try data.write(to: url)
                AlertCenter.shared.success("Exported \(char.name)")
            } catch {
                AlertCenter.shared.error(error)
            }
        }
    }
}

// MARK: - Empty state

private struct EmptyStateView: View {
    @Environment(\.risuTheme) private var theme

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 52, weight: .light))
                .foregroundStyle(theme.textDim)
            Text("Select a character to start chatting")
                .font(.title3)
                .foregroundStyle(theme.text)
            Text("Import a character card (PNG / charx / JSON)\nor create a new one with ⌘⇧N")
                .font(.callout)
                .foregroundStyle(theme.textDim)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.background)
    }
}
