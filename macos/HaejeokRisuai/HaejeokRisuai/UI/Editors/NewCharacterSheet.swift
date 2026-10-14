import SwiftUI
import UniformTypeIdentifiers

/// Creates a new character with an optional portrait.
struct NewCharacterSheet: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var description_ = ""
    @State private var firstMessage = ""
    @State private var personality = ""
    @State private var scenario = ""
    @State private var exampleMessage = ""
    @State private var systemPrompt = ""
    @State private var imageAssetId: String?
    @State private var importCard = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(theme.border)
            Form {
                Section("Identity") {
                    HStack(spacing: 14) {
                        portraitPicker
                        VStack(alignment: .leading, spacing: 6) {
                            LabeledField("Name") {
                                TextField("Character name", text: $name)
                            }
                            Toggle("Import from card file instead", isOn: $importCard)
                        }
                    }
                }

                if !importCard {
                    Section("Definition") {
                        LabeledField("Description") {
                            TextEditor(text: $description_)
                                .frame(minHeight: 80)
                        }
                        LabeledField("Personality") {
                            TextEditor(text: $personality)
                                .frame(minHeight: 50)
                        }
                        LabeledField("Scenario") {
                            TextEditor(text: $scenario)
                                .frame(minHeight: 50)
                        }
                        LabeledField("First Message") {
                            TextEditor(text: $firstMessage)
                                .frame(minHeight: 70)
                        }
                        LabeledField("Example Dialogue") {
                            TextEditor(text: $exampleMessage)
                                .frame(minHeight: 60)
                        }
                        LabeledField("System Prompt") {
                            TextEditor(text: $systemPrompt)
                                .frame(minHeight: 40)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)

            Divider().overlay(theme.border)
            footer
        }
        .background(theme.backgroundPanel)
        .frame(width: 560, height: 620)
    }

    private var header: some View {
        Text("New Character")
            .font(.headline)
            .foregroundStyle(theme.text)
            .frame(maxWidth: .infinity)
            .padding(12)
    }

    private var footer: some View {
        HStack {
            Spacer()
            Button("Cancel", role: .cancel) { dismiss() }
                .keyboardShortcut(.cancelAction)
            Button("Create") { create() }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty && !importCard)
        }
        .padding(12)
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
                        Image(systemName: "person.crop.circle.badge.plus")
                            .font(.system(size: 26))
                            .foregroundStyle(theme.textDim)
                    }
                }
            }
            .frame(width: 84, height: 84)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(theme.border, lineWidth: 1)
            )
            .onTapGesture { pickPortrait() }

            if imageAssetId != nil {
                Button("Remove") { imageAssetId = nil }
                    .font(.caption2)
                    .buttonStyle(.plain)
                    .foregroundStyle(theme.danger)
            }
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

    // MARK: - Create

    private func create() {
        if importCard {
            dismiss()
            ImportExportCoordinator.shared.importCards()
            return
        }

        var card = CharacterCard(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            imageAssetId: imageAssetId,
            desc: description_,
            personality: personality,
            scenario: scenario,
            firstMessage: firstMessage,
            exampleMessage: exampleMessage,
            systemPrompt: systemPrompt
        )
        card.ensureChatExists()
        DatabaseStore.shared.addCharacter(card)
        db.selectedCharId = card.id
        dismiss()
        AlertCenter.shared.success("Created \(card.name)")
    }
}

// MARK: - Shared form helpers

struct LabeledField<Content: View>: View {
    @Environment(\.risuTheme) private var theme

    let title: String
    @ViewBuilder var content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(theme.textDim)
            content
        }
    }
}
