import SwiftUI

/// Sidebar listing characters with search, favorites and trash management.
struct CharacterListView: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme

    var onEditCharacter: (CharacterCard) -> Void

    @State private var searchText = ""
    @State private var showTrash = false
    @State private var confirmDelete: CharacterCard?
    @State private var isDropTargeted = false

    private var filteredCharacters: [CharacterCard] {
        let base = showTrash ? db.trashedCharacters : db.activeCharacters
        let query = searchText.trimmingCharacters(in: .whitespaces)
        let list = query.isEmpty
            ? base
            : base.filter {
                $0.name.localizedCaseInsensitiveContains(query)
                    || $0.nickname?.localizedCaseInsensitiveContains(query) == true
                    || $0.tags.contains(where: { $0.localizedCaseInsensitiveContains(query) })
            }
        return list.sorted { a, b in
            if a.favorite != b.favorite { return a.favorite }
            return (a.lastInteraction ?? 0) > (b.lastInteraction ?? 0)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            searchField
            if !db.trashedCharacters.isEmpty {
                trashToggle
            }
            characterList
            footerBar
        }
        .background(theme.backgroundPanel)
        .overlay(dropHighlight)
        .dropDestination(for: URL.self) { urls, _ in
            importDroppedURLs(urls)
            return true
        } isTargeted: { targeted in
            isDropTargeted = targeted
        }
        .confirmationDialog(
            "Delete \(confirmDelete?.name ?? "") permanently?",
            isPresented: Binding(
                get: { confirmDelete != nil },
                set: { if !$0 { confirmDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let c = confirmDelete {
                    DatabaseStore.shared.deleteCharacter(c.id)
                }
                confirmDelete = nil
            }
            Button("Cancel", role: .cancel) { confirmDelete = nil }
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var dropHighlight: some View {
        if isDropTargeted {
            RoundedRectangle(cornerRadius: 12)
                .fill(theme.accent.opacity(0.08))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [6]))
                        .foregroundStyle(theme.accent)
                )
                .padding(4)
                .allowsHitTesting(false)
        }
    }

    private func importDroppedURLs(_ urls: [URL]) {
        let supportedExtensions = ["png", "json", "charx", "jpg", "jpeg"]
        for url in urls where supportedExtensions.contains(url.pathExtension.lowercased()) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let card = try CharacterCardIO.importCard(from: url)
                DatabaseStore.shared.addCharacter(card)
                AlertCenter.shared.success("Imported \(card.name)")
            } catch {
                AlertCenter.shared.error(error)
            }
        }
    }

    private var headerBar: some View {
        HStack(spacing: 8) {
            Text("Characters")
                .font(.headline)
                .foregroundStyle(theme.text)
            Spacer()
            Menu {
                Button("Import Card File...") { ImportExportCoordinator.shared.importCards() }
                Button("Import Legacy Save (.risu)...") { ImportExportCoordinator.shared.importLegacySave() }
            } label: {
                Image(systemName: "square.and.arrow.down")
                    .frame(width: 26, height: 24)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Import")

            Button {
                ImportExportCoordinator.shared.newCharacterRequested()
            } label: {
                Image(systemName: "plus.circle.fill")
                    .foregroundStyle(theme.accent)
                    .frame(width: 26, height: 24)
            }
            .buttonStyle(.plain)
            .help("New Character (⌘⇧N)")
        }
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .padding(.bottom, 4)
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.caption)
                .foregroundStyle(theme.textDim)
            TextField("Search", text: $searchText)
                .textFieldStyle(.plain)
                .font(.callout)
                .foregroundStyle(theme.text)
            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(theme.textDim)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
    }

    private var trashToggle: some View {
        Toggle(isOn: $showTrash) {
            Label(
                showTrash ? "Showing Trash" : "Trash (\(db.trashedCharacters.count))",
                systemImage: "trash"
            )
            .font(.caption)
            .foregroundStyle(showTrash ? theme.danger : theme.textDim)
        }
        .toggleStyle(.checkbox)
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
    }

    private var characterList: some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                ForEach(filteredCharacters) { char in
                    CharacterRowView(character: char, onEdit: { onEditCharacter(char) })
                        .contextMenu {
                            Button("Edit...") { onEditCharacter(char) }
                            Button("New Chat") {
                                DatabaseStore.shared.newChat(characterId: char.id)
                                db.selectedCharId = char.id
                            }
                            Divider()
                            Button(char.favorite ? "Unfavorite" : "Favorite") {
                                DatabaseStore.shared.updateCharacter(char.id) { $0.favorite.toggle() }
                            }
                            if char.trashTime == nil {
                                Divider()
                                Button("Move to Trash", role: .destructive) {
                                    DatabaseStore.shared.trashCharacter(char.id)
                                    if db.selectedCharId == char.id {
                                        db.selectedCharId = nil
                                    }
                                }
                            } else {
                                Button("Restore from Trash") { DatabaseStore.shared.restoreCharacter(char.id) }
                                Button("Delete Permanently...", role: .destructive) { confirmDelete = char }
                            }
                        }
                        .onTapGesture {
                            if char.trashTime == nil {
                                db.selectedCharId = char.id
                                GenerationManager.shared.stop()
                            }
                        }
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
    }

    private var footerBar: some View {
        HStack {
            Text("\(db.activeCharacters.count) characters · \(db.settings.statisticsMessages) messages")
                .font(.caption2)
                .foregroundStyle(theme.textDim)
            Spacer()
            SettingsLink {
                Image(systemName: "gearshape")
                    .frame(width: 24, height: 22)
            }
            .buttonStyle(.plain)
            .help("Settings (⌘,)")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(theme.background.opacity(0.5))
    }
}

// MARK: - Row

private struct CharacterRowView: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme

    let character: CharacterCard
    var onEdit: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            CharacterAvatar(character: character, size: 40)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(displayName)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(theme.text)
                        .lineLimit(1)
                    if character.favorite {
                        Image(systemName: "star.fill")
                            .font(.system(size: 9))
                            .foregroundStyle(Color(hex: 0xF5C043))
                    }
                }
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(theme.textDim)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            if character.trashTime != nil {
                Image(systemName: "trash")
                    .font(.caption)
                    .foregroundStyle(theme.danger)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(db.selectedCharId == character.id ? theme.surfaceHover : Color.clear)
        )
        .contentShape(RoundedRectangle(cornerRadius: 8))
    }

    private var displayName: String {
        character.nickname?.isEmpty == false ? character.nickname! : character.name
    }

    private var subtitle: String {
        let chatCount = character.chats.count
        let msgCount = character.chats.reduce(0) { $0 + $1.messages.count }
        return "\(chatCount) chat\(chatCount == 1 ? "" : "s") · \(msgCount) messages"
    }
}

// MARK: - Avatar

struct CharacterAvatar: View {
    @Environment(\.risuTheme) private var theme

    let character: CharacterCard
    var size: CGFloat

    var body: some View {
        Group {
            if let image = AssetStore.shared.loadImage(character.imageAssetId) {
                avatarClip(Image(nsImage: image).resizable().scaledToFill())
            } else {
                let initial = character.name.first.map(String.init) ?? "?"
                ZStack {
                    Circle().fill(theme.accent.gradient)
                    Text(initial.uppercased())
                        .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
                        .foregroundStyle(theme.accentText)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(roundIcon ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: size * 0.22)))
    }

    private var roundIcon: Bool {
        DatabaseStore.shared.settings.roundIcons
    }

    @ViewBuilder
    private func avatarClip<Content: View>(_ content: Content) -> some View {
        content
    }
}
