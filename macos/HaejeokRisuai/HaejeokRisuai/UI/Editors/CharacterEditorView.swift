import SwiftUI
import UniformTypeIdentifiers

/// Full character editor: identity fields, greetings, lorebook and regex scripts.
struct CharacterEditorView: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    let characterId: UUID

    enum Tab: String, CaseIterable, Identifiable {
        case basics = "Basics"
        case advanced = "Advanced"
        case lorebook = "Lorebook"
        case scripts = "Regex Scripts"

        var id: String { rawValue }
        var icon: String {
            switch self {
            case .basics: return "person.text.rectangle"
            case .advanced: return "slider.horizontal.3"
            case .lorebook: return "book.closed"
            case .scripts: return "chevron.left.forwardslash.chevron.right"
            }
        }
    }

    @State private var tab: Tab = .basics

    // Working copies (committed on save).
    @State private var name = ""
    @State private var nickname = ""
    @State private var desc = ""
    @State private var personality = ""
    @State private var scenario = ""
    @State private var firstMessage = ""
    @State private var alternateGreetings: [String] = []
    @State private var exampleMessage = ""
    @State private var systemPrompt = ""
    @State private var postHistoryInstructions = ""
    @State private var creatorNotes = ""
    @State private var tagsText = ""
    @State private var utilityBot = false
    @State private var replaceGlobalNote = ""
    @State private var additionalText = ""
    @State private var imageAssetId: String?
    @State private var largePortrait = true
    @State private var globalLore: [LoreBookEntry] = []
    @State private var customScripts: [CustomScriptEntry] = []

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(theme.border)
            HStack(spacing: 0) {
                tabList
                Divider().overlay(theme.border)
                content
            }
            Divider().overlay(theme.border)
            footer
        }
        .background(theme.backgroundPanel)
        .frame(minWidth: 780, minHeight: 600)
        .onAppear(perform: loadFromCharacter)
    }

    // MARK: - Chrome

    private var header: some View {
        Text("Edit Character")
            .font(.headline)
            .foregroundStyle(theme.text)
            .frame(maxWidth: .infinity)
            .padding(12)
    }

    private var tabList: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Tab.allCases) { t in
                Button {
                    tab = t
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: t.icon)
                            .frame(width: 16)
                        Text(t.rawValue)
                        Spacer()
                    }
                    .font(.system(size: 13))
                    .foregroundStyle(tab == t ? theme.accent : theme.textDim)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 6)
                            .fill(tab == t ? theme.surfaceHover : Color.clear)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
        .padding(10)
        .frame(width: 160)
    }

    private var footer: some View {
        HStack {
            Button("Export PNG") { exportCard(as: .png) }
            Button("Export charx") { exportCard(as: .charx) }
            Spacer()
            Button("Cancel", role: .cancel) { dismiss() }
                .keyboardShortcut(.cancelAction)
            Button("Save") { save() }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
        }
        .padding(12)
    }

    // MARK: - Content tabs

    @ViewBuilder
    private var content: some View {
        ScrollView {
            Group {
                switch tab {
                case .basics: basicsTab
                case .advanced: advancedTab
                case .lorebook:
                    LorebookEntryListEditor(entries: $globalLore)
                        .padding(16)
                case .scripts:
                    ScriptListEditor(scripts: $customScripts)
                        .padding(16)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
        }
    }

    private var basicsTab: some View {
        VStack(alignment: .leading, spacing: 14) {
            LabeledField("Portrait & Name") {
                HStack(spacing: 14) {
                    portraitPicker
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("Name", text: $name)
                            .textFieldStyle(.roundedBorder)
                        TextField("Nickname (optional)", text: $nickname)
                            .textFieldStyle(.roundedBorder)
                        Toggle("Large portrait", isOn: $largePortrait)
                            .font(.caption)
                    }
                }
            }

            LabeledField("Tags (comma separated)") {
                TextField("fantasy, adventure...", text: $tagsText)
                    .textFieldStyle(.roundedBorder)
            }

            LabeledField("Description") {
                TextEditor(text: $desc).frame(minHeight: 100)
            }
            LabeledField("Personality") {
                TextEditor(text: $personality).frame(minHeight: 60)
            }
            LabeledField("Scenario") {
                TextEditor(text: $scenario).frame(minHeight: 50)
            }
            LabeledField("First Message") {
                TextEditor(text: $firstMessage).frame(minHeight: 80)
            }
            LabeledField("Example Dialogue (<START> separated)") {
                TextEditor(text: $exampleMessage).frame(minHeight: 70)
            }
        }
    }

    private var advancedTab: some View {
        VStack(alignment: .leading, spacing: 14) {
            LabeledField("Alternate Greetings") {
                VStack(spacing: 6) {
                    ForEach($alternateGreetings.indices, id: \.self) { idx in
                        HStack(alignment: .top, spacing: 6) {
                            TextEditor(text: $alternateGreetings[idx])
                                .frame(minHeight: 44)
                            Button {
                                _ = alternateGreetings.remove(at: idx)
                            } label: {
                                Image(systemName: "trash")
                                    .foregroundStyle(theme.danger)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    Button {
                        alternateGreetings.append("")
                    } label: {
                        Label("Add Greeting", systemImage: "plus")
                    }
                }
            }

            LabeledField("System Prompt (character-specific)") {
                TextEditor(text: $systemPrompt).frame(minHeight: 60)
            }
            LabeledField("Post-History Instructions (jailbreak override)") {
                TextEditor(text: $postHistoryInstructions).frame(minHeight: 50)
            }
            LabeledField("Creator Notes") {
                TextEditor(text: $creatorNotes).frame(minHeight: 40)
            }
            Toggle("Utility Bot (skips roleplay formatting)", isOn: $utilityBot)

            LabeledField("Replace Global Note") {
                TextEditor(text: $replaceGlobalNote).frame(minHeight: 40)
            }
            LabeledField("Additional Text") {
                TextEditor(text: $additionalText).frame(minHeight: 40)
            }
        }
    }

    // MARK: - Portrait

    private var portraitPicker: some View {
        VStack(spacing: 6) {
            Group {
                if let img = AssetStore.shared.loadImage(imageAssetId) {
                    Image(nsImage: img).resizable().scaledToFill()
                } else {
                    ZStack {
                        Rectangle().fill(theme.surface)
                        Image(systemName: "photo")
                            .foregroundStyle(theme.textDim)
                    }
                }
            }
            .frame(width: 84, height: 84)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(theme.border, lineWidth: 1))
            .onTapGesture { pickPortrait() }
        }
    }

    private func pickPortrait() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg]
        panel.begin { response in
            guard response == .OK, let url = panel.url,
                  let data = try? Data(contentsOf: url) else { return }
            imageAssetId = AssetStore.shared.saveAsset(data)
        }
    }

    // MARK: - Load / Save / Export

    private func loadFromCharacter() {
        guard let c = DatabaseStore.shared.character(id: characterId) else { return }
        name = c.name
        nickname = c.nickname ?? ""
        desc = c.desc
        personality = c.personality
        scenario = c.scenario
        firstMessage = c.firstMessage
        alternateGreetings = c.alternateGreetings
        exampleMessage = c.exampleMessage
        systemPrompt = c.systemPrompt
        postHistoryInstructions = c.postHistoryInstructions
        creatorNotes = c.creatorNotes
        tagsText = c.tags.joined(separator: ", ")
        utilityBot = c.utilityBot
        replaceGlobalNote = c.replaceGlobalNote
        additionalText = c.additionalText
        imageAssetId = c.imageAssetId
        largePortrait = c.largePortrait
        globalLore = c.globalLore
        customScripts = c.customScripts
    }

    private func save() {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let tags = tagsText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let newGreetings = alternateGreetings.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let oldGreetings = DatabaseStore.shared.character(id: characterId)?.alternateGreetings ?? []

        DatabaseStore.shared.updateCharacter(characterId) { c in
            c.name = trimmedName.isEmpty ? "Unnamed" : trimmedName
            c.nickname = nickname.isEmpty ? nil : nickname
            c.desc = desc
            c.personality = personality
            c.scenario = scenario
            c.firstMessage = firstMessage
            c.alternateGreetings = newGreetings
            c.exampleMessage = exampleMessage
            c.systemPrompt = systemPrompt
            c.postHistoryInstructions = postHistoryInstructions
            c.creatorNotes = creatorNotes
            c.tags = tags
            c.utilityBot = utilityBot
            c.replaceGlobalNote = replaceGlobalNote
            c.additionalText = additionalText
            c.imageAssetId = imageAssetId
            c.largePortrait = largePortrait
            c.globalLore = globalLore
            c.customScripts = customScripts

            // Keep fmIndex valid if greetings shrank.
            for ci in c.chats.indices where c.chats[ci].fmIndex > newGreetings.count {
                c.chats[ci].fmIndex = -1
            }
        }
        _ = oldGreetings
        dismiss()
    }

    private func exportCard(as format: CharacterExporterFormat) {
        save()
        guard let fresh = DatabaseStore.shared.character(id: characterId) else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = fresh.name
        panel.allowedContentTypes = [format == .png ? .png : UTType.charx]
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                let portrait = AssetStore.shared.loadImage(fresh.imageAssetId)
                let data = format == .png
                    ? try CharacterCardIO.exportPNG(from: fresh, portrait: portrait)
                    : try CharacterCardIO.exportCharX(from: fresh, portrait: portrait)
                try data.write(to: url)
                AlertCenter.shared.success("Exported \(fresh.name)")
            } catch {
                AlertCenter.shared.error(error)
            }
        }
    }
}
