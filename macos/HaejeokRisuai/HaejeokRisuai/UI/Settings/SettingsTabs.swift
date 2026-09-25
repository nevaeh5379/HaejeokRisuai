import SwiftUI
import UniformTypeIdentifiers

// MARK: - Generation tab

struct GenerationTab: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader("Sampling")
            SettingsSliderRow("Temperature", value: db.settings.temperature, in: 0...3, step: 0.01, format: "%.2f") {
                set(\.temperature, $0)
            }
            SettingsSliderRow("Max Response (tokens)", value: Double(db.settings.maxResponse), in: 64...8192, step: 32, format: "%.0f") {
                set(\.maxResponse, Int($0))
            }
            SettingsSliderRow("Max Context (tokens)", value: Double(db.settings.maxContext), in: 512...131072, step: 256, format: "%.0f") {
                set(\.maxContext, Int($0))
            }
            SettingsSliderRow("Frequency Penalty", value: db.settings.frequencyPenalty, in: -200...200, step: 1, format: "%.0f") {
                set(\.frequencyPenalty, $0)
            }
            SettingsSliderRow("Presence Penalty", value: db.settings.presencePenalty, in: -200...200, step: 1, format: "%.0f") {
                set(\.presencePenalty, $0)
            }
            SettingsSliderRow("Top P", value: db.settings.topP, in: 0...1, step: 0.01, format: "%.2f") {
                set(\.topP, $0)
            }

            HStack(spacing: 16) {
                LabeledField("Top K (0 = off)") {
                    Stepper("\(db.settings.topK)", value: topKBinding, in: 0...200)
                        .font(.system(size: 13))
                }
                LabeledField("Seed (-1 = random)") {
                    TextField("-1", text: seedText)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 90)
                }
            }

            Divider().overlay(theme.border.opacity(0.5))

            SectionHeader("Auxiliary Model & Memory")
            SettingsToggleRow(
                "Auto-suggest follow-up messages",
                subtitle: "Generates message suggestions after each reply",
                isOn: db.settings.autoSuggestMessages
            ) {
                DatabaseStore.shared.settings.autoSuggestMessages = $0
            }

            SettingsToggleRow(
                "SupaMemory (summarize old messages)",
                subtitle: "Keeps long chats within context by summarizing older turns",
                isOn: db.settings.supaMemory.enabled && db.settings.memoryAlgorithm == .supaMemory
            ) { on in
                var s = DatabaseStore.shared.settings
                s.memoryAlgorithm = on ? .supaMemory : .none
                s.supaMemory.enabled = on
                DatabaseStore.shared.settings = s
            }

            Divider().overlay(theme.border.opacity(0.5))

            SectionHeader("Presets")
            presetSection
        }
    }

    @ViewBuilder
    private var presetSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(db.settings.botPresets) { preset in
                HStack {
                    Button(preset.name) {
                        DatabaseStore.shared.settings.apply(preset: preset)
                        DatabaseStore.shared.settings.activeBotPresetId = preset.id
                        AlertCenter.shared.success("Applied preset \(preset.name)")
                    }
                    .buttonStyle(.bordered)
                    Spacer()
                    if db.settings.activeBotPresetId == preset.id {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(theme.accent)
                    }
                    Button {
                        DatabaseStore.shared.settings.botPresets.removeAll { $0.id == preset.id }
                    } label: {
                        Image(systemName: "trash")
                            .foregroundStyle(theme.danger)
                    }
                    .buttonStyle(.plain)
                }
            }

            HStack {
                Button("Save current as preset...") { savePreset() }
                if !db.settings.botPresets.isEmpty && db.settings.activeBotPresetId != nil {
                    Button("Update active preset", role: .destructive) {
                        guard let id = db.settings.activeBotPresetId,
                              let idx = db.settings.botPresets.firstIndex(where: { $0.id == id }) else { return }
                        let snapshot = db.settings.snapshotAsPreset(name: db.settings.botPresets[idx].name)
                        DatabaseStore.shared.settings.botPresets[idx] = snapshot
                    }
                }
            }
        }
    }

    private func savePreset() {
        let alert = NSAlert()
        alert.messageText = "Save Preset"
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        input.placeholderString = "Preset name"
        alert.accessoryView = input
        if alert.runModal() == .alertFirstButtonReturn {
            let name = input.stringValue.trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty else { return }
            let preset = DatabaseStore.shared.settings.snapshotAsPreset(name: name)
            DatabaseStore.shared.settings.botPresets.append(preset)
            DatabaseStore.shared.settings.activeBotPresetId = preset.id
        }
    }

    private var topKBinding: Binding<Int> {
        Binding(
            get: { db.settings.topK },
            set: { v in set(\.topK, v) }
        )
    }

    private var seedText: Binding<String> {
        Binding(
            get: { String(db.settings.generationSeed) },
            set: { v in
                if let n = Int(v) { set(\.generationSeed, n) }
            }
        )
    }

    private func set<T>(_ keyPath: WritableKeyPath<AppSettings, T>, _ value: T) {
        var s = db.settings
        s[keyPath: keyPath] = value
        db.settings = s
    }
}

// MARK: - Prompt tab

struct PromptTab: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme

    @State private var mainPrompt = ""
    @State private var jailbreak = ""
    @State private var globalNote = ""
    @State private var additionalPrompt = ""
    @State private var descriptionPrefix = ""
    @State private var loadedOnce = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader("Prompt Order")
            formattingOrderEditor

            Divider().overlay(theme.border.opacity(0.5))

            SectionHeader("Prompts")
            LabeledField("Main Prompt") {
                TextEditor(text: $mainPrompt).frame(minHeight: 110)
            }
            LabeledField("Jailbreak / Post-History Instructions") {
                TextEditor(text: $jailbreak).frame(minHeight: 80)
            }
            LabeledField("Global Note") {
                TextEditor(text: $globalNote).frame(minHeight: 50)
            }
            LabeledField("Additional Prompt") {
                TextEditor(text: $additionalPrompt).frame(minHeight: 40)
            }
            LabeledField("Description Prefix") {
                TextField("description of {{char}}:", text: $descriptionPrefix)
                    .textFieldStyle(.roundedBorder)
            }
        }
        .onAppear(perform: load)
        .onDisappear(perform: save)
    }

    private func load() {
        mainPrompt = db.settings.mainPrompt
        jailbreak = db.settings.jailbreak
        globalNote = db.settings.globalNote
        additionalPrompt = db.settings.additionalPrompt
        descriptionPrefix = db.settings.descriptionPrefix
        loadedOnce = true
    }

    private func save() {
        guard loadedOnce else { return }
        var s = db.settings
        s.mainPrompt = mainPrompt
        s.jailbreak = jailbreak
        s.globalNote = globalNote
        s.additionalPrompt = additionalPrompt
        s.descriptionPrefix = descriptionPrefix
        db.settings = s
    }

    /// Drag-free reorderable list using up/down buttons.
    private var formattingOrderEditor: some View {
        VStack(spacing: 4) {
            ForEach(Array(db.settings.formattingOrder.enumerated()), id: \.offset) { idx, item in
                HStack {
                    Text(item.label)
                        .font(.system(size: 12))
                        .foregroundStyle(theme.text)
                    Spacer()
                    Button {
                        moveItem(idx, -1)
                    } label: {
                        Image(systemName: "arrow.up")
                    }
                    .buttonStyle(.plain)
                    .disabled(idx == 0)
                    Button {
                        moveItem(idx, 1)
                    } label: {
                        Image(systemName: "arrow.down")
                    }
                    .buttonStyle(.plain)
                    .disabled(idx == db.settings.formattingOrder.count - 1)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(theme.surface.opacity(0.6))
                .clipShape(RoundedRectangle(cornerRadius: 5))
            }
        }
    }

    private func moveItem(_ from: Int, _ direction: Int) {
        let to = from + direction
        guard db.settings.formattingOrder.indices.contains(from),
              db.settings.formattingOrder.indices.contains(to) else { return }
        var s = db.settings
        s.formattingOrder.swapAt(from, to)
        db.settings = s
    }
}

// MARK: - Persona tab

struct PersonaTab: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader("Active Persona")
            Picker("Persona", selection: personaSelection) {
                Text("None").tag(UUID?.none)
                ForEach(db.settings.personas) { p in
                    Text(p.name).tag(UUID?.some(p.id))
                }
            }

            SectionHeader("Personas")
            ForEach(db.settings.personas) { persona in
                PersonaRow(personaId: persona.id)
            }

            Button {
                DatabaseStore.shared.settings.personas.append(
                    PersonaPreset(name: "New Persona \(db.settings.personas.count + 1)")
                )
            } label: {
                Label("Add Persona", systemImage: "plus")
            }
        }
    }

    private var personaSelection: Binding<UUID?> {
        Binding(
            get: { db.settings.selectedPersonaId },
            set: { v in
                var s = db.settings
                s.selectedPersonaId = v
                db.settings = s
            }
        )
    }
}

struct PersonaRow: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme

    let personaId: UUID

    @State private var expanded = false

    private var persona: PersonaPreset? {
        db.settings.personas.first(where: { $0.id == personaId })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button {
                    expanded.toggle()
                } label: {
                    Image(systemName: "chevron.right")
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .font(.caption.bold())
                        .foregroundStyle(theme.textDim)
                }
                .buttonStyle(.plain)

                Text(persona?.name ?? "")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(theme.text)

                Spacer()

                Button {
                    DatabaseStore.shared.settings.personas.removeAll { $0.id == personaId }
                } label: {
                    Image(systemName: "trash")
                        .foregroundStyle(theme.danger)
                }
                .buttonStyle(.plain)
            }

            if expanded, let persona {
                LabeledField("Name") {
                    TextField("Your name", text: nameBinding)
                        .textFieldStyle(.roundedBorder)
                }
                LabeledField("Persona Prompt") {
                    TextEditor(text: promptBinding).frame(minHeight: 70)
                }
                if persona.iconAssetId == nil {
                    Button("Set Icon...") { pickIcon() }
                        .font(.caption)
                }
            }
        }
        .padding(10)
        .background(theme.surface.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var nameBinding: Binding<String> {
        Binding(
            get: { persona?.name ?? "" },
            set: { v in updatePersona { $0.name = v } }
        )
    }

    private var promptBinding: Binding<String> {
        Binding(
            get: { persona?.personaPrompt ?? "" },
            set: { v in updatePersona { $0.personaPrompt = v } }
        )
    }

    private func updatePersona(_ mutate: (inout PersonaPreset) -> Void) {
        var s = db.settings
        if let idx = s.personas.firstIndex(where: { $0.id == personaId }) {
            mutate(&s.personas[idx])
            db.settings = s
        }
    }

    private func pickIcon() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg]
        panel.begin { response in
            guard response == .OK, let url = panel.url,
                  let data = try? Data(contentsOf: url) else { return }
            let assetId = AssetStore.shared.saveAsset(data)
            updatePersona { $0.iconAssetId = assetId }
        }
    }
}

// MARK: - Lorebook tab

struct LorebookTab: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme

    @State private var selectedBookId: UUID?
    @State private var newBookName = ""

    private var selectedBookIndex: Int? {
        db.settings.loreBooks.firstIndex(where: { $0.id == selectedBookId })
    }

    var body: some View {
        HSplitView {
            // Book list
            VStack(alignment: .leading, spacing: 6) {
                Text("Global Lorebooks")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.text)
                ForEach(db.settings.loreBooks) { book in
                    HStack {
                        Image(systemName: "book.closed")
                            .font(.caption)
                            .foregroundStyle(selectedBookId == book.id ? theme.accent : theme.textDim)
                        Text(book.name)
                            .font(.system(size: 12))
                            .foregroundStyle(theme.text)
                            .lineLimit(1)
                        Spacer()
                        Text("\(book.entries.count)")
                            .font(.caption2)
                            .foregroundStyle(theme.textDim)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(
                        RoundedRectangle(cornerRadius: 6)
                            .fill(selectedBookId == book.id ? theme.surfaceHover : .clear)
                    )
                    .contentShape(Rectangle())
                    .onTapGesture { selectedBookId = book.id }
                    .contextMenu {
                        Button("Delete Book", role: .destructive) {
                            DatabaseStore.shared.settings.loreBooks.removeAll { $0.id == book.id }
                            if selectedBookId == book.id { selectedBookId = nil }
                        }
                    }
                }
                HStack(spacing: 4) {
                    TextField("New book name", text: $newBookName)
                        .textFieldStyle(.roundedBorder)
                        .font(.caption)
                    Button {
                        addBook()
                    } label: {
                        Image(systemName: "plus")
                    }
                    .buttonStyle(.bordered)
                }
                Spacer()
            }
            .frame(minWidth: 180, maxWidth: 260)

            // Entries editor
            Group {
                if let idx = selectedBookIndex,
                   db.settings.loreBooks.indices.contains(idx) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            TextField("Book name", text: bookNameBinding(idx))
                                .textFieldStyle(.roundedBorder)
                            LorebookEntryListEditor(entries: entriesBinding(idx))
                        }
                        .padding(12)
                    }
                } else {
                    Text("Select or create a lorebook")
                        .foregroundStyle(theme.textDim)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(minWidth: 420)
        }
    }

    private func addBook() {
        let name = newBookName.trimmingCharacters(in: .whitespaces)
        let book = LoreBookPage(name: name.isEmpty ? "New Book" : name)
        DatabaseStore.shared.settings.loreBooks.append(book)
        selectedBookId = book.id
        newBookName = ""
    }

    private func bookNameBinding(_ idx: Int) -> Binding<String> {
        Binding(
            get: { db.settings.loreBooks[idx].name },
            set: { v in
                DatabaseStore.shared.settings.loreBooks[idx].name = v
            }
        )
    }

    private func entriesBinding(_ idx: Int) -> Binding<[LoreBookEntry]> {
        Binding(
            get: { db.settings.loreBooks[idx].entries },
            set: { v in
                DatabaseStore.shared.settings.loreBooks[idx].entries = v
            }
        )
    }
}

// MARK: - Appearance tab

struct AppearanceTab: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader("Color Theme")
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 130))], spacing: 8) {
                ForEach(ColorThemeKind.allCases) { kind in
                    let t = RisuTheme.theme(kind)
                    Button {
                        DatabaseStore.shared.settings.theme = kind
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 3) {
                                swatch(t.background)
                                swatch(t.backgroundPanel)
                                swatch(t.surface)
                                swatch(t.accent)
                            }
                            Text(kind.displayName)
                                .font(.system(size: 11, weight: db.settings.theme == kind ? .semibold : .regular))
                                .foregroundStyle(db.settings.theme == kind ? theme.accent : theme.textDim)
                        }
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 7)
                                .fill(theme.surface)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 7)
                                        .stroke(
                                            db.settings.theme == kind ? theme.accent : theme.border,
                                            lineWidth: db.settings.theme == kind ? 1.5 : 1
                                        )
                                )
                        )
                    }
                    .buttonStyle(.plain)
                }
            }

            Divider().overlay(theme.border.opacity(0.5))

            SectionHeader("Chat Display")
            SettingsSliderRow("Font Size", value: db.settings.fontSize, in: 11...24, step: 1, format: "%.0f") {
                v in DatabaseStore.shared.settings.fontSize = v
            }
            SettingsToggleRow("Round character icons", isOn: db.settings.roundIcons) {
                DatabaseStore.shared.settings.roundIcons = $0
            }
            SettingsToggleRow("Show token usage under messages", isOn: db.settings.showTokenUsage) {
                DatabaseStore.shared.settings.showTokenUsage = $0
            }
            SettingsToggleRow("Send message with Enter", subtitle: "Off: use ⌘⏎ to send", isOn: db.settings.sendWithEnter) {
                DatabaseStore.shared.settings.sendWithEnter = $0
            }
        }
    }

    private func swatch(_ color: Color) -> some View {
        RoundedRectangle(cornerRadius: 3)
            .fill(color)
            .frame(width: 22, height: 22)
            .overlay(RoundedRectangle(cornerRadius: 3).stroke(theme.border.opacity(0.5), lineWidth: 0.5))
    }
}

// MARK: - Data tab

struct DataTab: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme

    @State private var mergeOnImport = true
    @State private var confirmReset = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader("Backup")
            Toggle("Merge characters on import (keeps existing)", isOn: $mergeOnImport)
            HStack {
                Button("Export Backup (.json)...") { exportBackup() }
                Button("Import Backup (.json)...") { importBackup() }
            }

            Divider().overlay(theme.border.opacity(0.5))

            SectionHeader("Legacy Import")
            Button("Import Web Save (.risu / .risup)...") {
                ImportExportCoordinator.shared.importLegacySave()
            }
            Button("Import Backup (.bin / .risubackup)...") {
                ImportExportCoordinator.shared.importBinBackup()
            }
            Text("Imports characters, chats, lorebooks and assets from a RisuAI backup file (.bin).")
                .font(.caption)
                .foregroundStyle(theme.textDim)

            Divider().overlay(theme.border.opacity(0.5))

            SectionHeader("Statistics")
            HStack(spacing: 24) {
                statBlock("\(db.characters.count)", "characters")
                statBlock("\(db.settings.statisticsMessages)", "messages generated")
                statBlock("\(db.settings.statisticsImports)", "cards imported")
            }

            Divider().overlay(theme.border.opacity(0.5))

            SectionHeader("Danger Zone")
            Button("Reset All Data...", role: .destructive) {
                confirmReset = true
            }
            .confirmationDialog(
                "Delete ALL characters and reset settings?",
                isPresented: $confirmReset,
                titleVisibility: .visible
            ) {
                Button("Delete Everything", role: .destructive) {
                    DatabaseStore.shared.characters = []
                    DatabaseStore.shared.settings = AppSettings()
                    DatabaseStore.shared.selectedCharId = nil
                    AlertCenter.shared.info("All data cleared.")
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This permanently removes all local data.")
            }
        }
    }

    private func statBlock(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(theme.text)
            Text(label)
                .font(.caption)
                .foregroundStyle(theme.textDim)
        }
    }

    private func exportBackup() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "HaejeokRisuai-backup-\(DateFormatter.localizedString(from: Date(), dateStyle: .short, timeStyle: .none)).json"
        panel.allowedContentTypes = [.json]
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                let data = try DatabaseStore.shared.exportBackupData()
                try data.write(to: url)
                AlertCenter.shared.success("Backup saved")
            } catch {
                AlertCenter.shared.error(error)
            }
        }
    }

    private func importBackup() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                let data = try Data(contentsOf: url)
                try DatabaseStore.shared.importBackupData(data, mergeCharacters: mergeOnImport)
                AlertCenter.shared.success("Backup restored")
            } catch {
                AlertCenter.shared.error(error)
            }
        }
    }
}
