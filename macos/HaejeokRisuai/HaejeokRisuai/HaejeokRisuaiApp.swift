import SwiftUI
import UniformTypeIdentifiers

@main
struct HaejeokRisuaiApp: App {
    @StateObject private var db = DatabaseStore.shared
    @StateObject private var alerts = AlertCenter.shared
    @StateObject private var gen = GenerationManager.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(\.risuTheme, RisuTheme.theme(db.settings.theme))
                .environmentObject(db)
                .environmentObject(alerts)
                .environmentObject(gen)
                .frame(minWidth: 980, minHeight: 620)
        }
        .windowStyle(.automatic)
        .defaultSize(width: 1280, height: 820)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Chat") { ImportExportCoordinator.shared.newChatRequested() }
                    .keyboardShortcut("n", modifiers: [.command])
                Divider()
                Button("New Character...") { ImportExportCoordinator.shared.newCharacterRequested() }
                    .keyboardShortcut("N", modifiers: [.command, .shift])
            }
            CommandGroup(after: .newItem) {
                Button("Import Character Card...") { ImportExportCoordinator.shared.importCards() }
                    .keyboardShortcut("i", modifiers: [.command])
                Button("Import Backup (.bin / .risubackup)...") { ImportExportCoordinator.shared.importBinBackup() }
                    .keyboardShortcut("b", modifiers: [.command])
                Button("Import Legacy Risu Save (.risu)...") { ImportExportCoordinator.shared.importLegacySave() }
                Divider()
                Button("Export Current Character as PNG") { ImportExportCoordinator.shared.exportSelected(as: .png) }
                Button("Export Current Character as charx") { ImportExportCoordinator.shared.exportSelected(as: .charx) }
            }
            CommandGroup(replacing: .help) {
                Button("HaejeokRisuai Help") {
                    NSWorkspace.shared.open(URL(string: "https://github.com/kwaroran/RisuAI")!)
                }
            }
        }

        Settings {
            SettingsView()
                .environment(\.risuTheme, RisuTheme.theme(DatabaseStore.shared.settings.theme))
                .environmentObject(DatabaseStore.shared)
                .environmentObject(AlertCenter.shared)
                .frame(width: 760, height: 580)
        }
    }
}

/// Bridges menu commands to the active UI through a callback.
@MainActor
final class ImportExportCoordinator {
    static let shared = ImportExportCoordinator()

    enum Request {
        case importCards
        case importLegacySave
        case importBinBackup
        case exportPNG
        case exportCharX
        case newChat
        case newCharacter
    }

    var onRequest: ((Request) -> Void)?

    func importCards() { onRequest?(.importCards) }
    func importLegacySave() { onRequest?(.importLegacySave) }
    func importBinBackup() { onRequest?(.importBinBackup) }
    func exportSelected(as format: CharacterExporterFormat) {
        onRequest?(format == .png ? .exportPNG : .exportCharX)
    }
    func newChatRequested() { onRequest?(.newChat) }
    func newCharacterRequested() { onRequest?(.newCharacter) }
}

enum CharacterExporterFormat {
    case png
    case charx
}

extension UTType {
    static let charx = UTType(filenameExtension: "charx") ?? UTType.data
    static let risuSaveType = UTType(filenameExtension: "risu") ?? UTType.data
}
