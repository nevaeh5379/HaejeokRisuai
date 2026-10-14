import SwiftUI

/// Settings window with API / generation / prompt / persona / lorebook /
/// appearance / data tabs.
struct SettingsView: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme

    enum Tab: String, CaseIterable, Identifiable {
        case api = "API"
        case generation = "Generation"
        case prompt = "Prompt"
        case persona = "Persona"
        case lorebook = "Lorebook"
        case appearance = "Appearance"
        case data = "Data"

        var id: String { rawValue }
        var icon: String {
            switch self {
            case .api: return "key.horizontal"
            case .generation: return "dial.high"
            case .prompt: return "text.quote"
            case .persona: return "person.crop.circle.badge.questionmark"
            case .lorebook: return "books.vertical"
            case .appearance: return "paintbrush"
            case .data: return "externaldrive"
            }
        }
    }

    @State private var tab: Tab = .api

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Tab.allCases) { t in
                    Button {
                        tab = t
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: t.icon).frame(width: 16)
                            Text(t.rawValue)
                            Spacer()
                        }
                        .font(.system(size: 13))
                        .foregroundStyle(tab == t ? theme.accent : theme.textDim)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(RoundedRectangle(cornerRadius: 6).fill(tab == t ? theme.surfaceHover : .clear))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            .padding(10)
            .frame(width: 150)

            Divider().overlay(theme.border)

            ScrollView {
                Group {
                    switch tab {
                    case .api: APITab()
                    case .generation: GenerationTab()
                    case .prompt: PromptTab()
                    case .persona: PersonaTab()
                    case .lorebook: LorebookTab()
                    case .appearance: AppearanceTab()
                    case .data: DataTab()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(18)
            }
        }
        .background(theme.backgroundPanel)
        .environment(\.defaultMinListRowHeight, 10)
    }
}

// MARK: - Reusable controls

struct SettingsSliderRow: View {
    @Environment(\.risuTheme) private var theme

    let title: String
    let value: Double
    let range: ClosedRange<Double>
    let step: Double
    let format: String
    let onChange: (Double) -> Void

    init(
        _ title: String,
        value: Double,
        in range: ClosedRange<Double>,
        step: Double = 0.01,
        format: String = "%.2f",
        onChange: @escaping (Double) -> Void
    ) {
        self.title = title
        self.value = value
        self.range = range
        self.step = step
        self.format = format
        self.onChange = onChange
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title)
                    .font(.system(size: 13))
                    .foregroundStyle(theme.text)
                Spacer()
                Text(String(format: format, value))
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(theme.textDim)
            }
            Slider(
                value: Binding(
                    get: { value },
                    set: { v in onChange(min(range.upperBound, max(range.lowerBound, v))) }
                ),
                in: range,
                step: step
            )
        }
    }
}

struct SettingsToggleRow: View {
    @Environment(\.risuTheme) private var theme

    let title: String
    let subtitle: String?
    let isOn: Bool
    let onChange: (Bool) -> Void

    init(_ title: String, subtitle: String? = nil, isOn: Bool, onChange: @escaping (Bool) -> Void) {
        self.title = title
        self.subtitle = subtitle
        self.isOn = isOn
        self.onChange = onChange
    }

    var body: some View {
        Toggle(isOn: Binding(get: { isOn }, set: onChange)) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 13))
                    .foregroundStyle(theme.text)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(theme.textDim)
                }
            }
        }
    }
}

struct SectionHeader: View {
    @Environment(\.risuTheme) private var theme
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(theme.text)
            .padding(.top, 6)
    }
}

// MARK: - API tab

struct APITab: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme

    @State private var availableModels: [String] = []
    @State private var fetchingModels = false
    @State private var fetchError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader("Provider")
            Picker("API", selection: binding(\.apiType)) {
                ForEach(ProviderKind.allCases) { kind in
                    Text(kind.displayName).tag(kind)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()

            Divider().overlay(theme.border.opacity(0.5))

            providerSection
        }
    }

    @ViewBuilder
    private var providerSection: some View {
        let kind = db.settings.apiType

        VStack(alignment: .leading, spacing: 12) {
            if kind == .ollama {
                LabeledField("Ollama Server URL") {
                    TextField("http://localhost:11434", text: ollamaURLBinding)
                        .textFieldStyle(.roundedBorder)
                }
                LabeledField("Model") {
                    TextField("llama3.2", text: ollamaModelBinding)
                        .textFieldStyle(.roundedBorder)
                }
                modelFetchButtons(kind: kind)
            } else {
                LabeledField("API Key") {
                    SecureField(kind == .customProxy ? "optional" : "sk-...", text: keyBinding(kind))
                        .textFieldStyle(.roundedBorder)
                }

                if kind == .customProxy {
                    LabeledField("Base URL") {
                        TextField("https://your-proxy.example.com/v1", text: customURLBinding)
                            .textFieldStyle(.roundedBorder)
                    }
                }

                LabeledField("Model") {
                    TextField("model id", text: modelBinding(kind))
                        .textFieldStyle(.roundedBorder)
                }

                modelSuggestions(kind: kind)
                modelFetchButtons(kind: kind)

                if let fetchError {
                    Text(fetchError)
                        .font(.caption)
                        .foregroundStyle(theme.danger)
                }
            }

            LabeledField("Sub-model (auxiliary tasks)") {
                TextField("same as main model", text: subModelBinding)
                    .textFieldStyle(.roundedBorder)
            }
        }
    }

    @ViewBuilder
    private func modelSuggestions(kind: ProviderKind) -> some View {
        let models = !availableModels.isEmpty ? availableModels : ModelCatalog.suggestions(for: kind).map(\.modelId)
        if !models.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(availableModels.isEmpty ? "Suggestions:" : "\(models.count) models from server:")
                    .font(.caption)
                    .foregroundStyle(theme.textDim)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(models, id: \.self) { m in
                            Button(m) { setModel(m) }
                                .font(.system(size: 11))
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                        }
                    }
                }
            }
        }
    }

    private func modelFetchButtons(kind: ProviderKind) -> some View {
        Button {
            fetchModels(kind: kind)
        } label: {
            HStack(spacing: 5) {
                if fetchingModels {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.triangle.2.circlepath")
                }
                Text("Fetch model list")
            }
        }
        .disabled(fetchingModels)
    }

    private func fetchModels(kind: ProviderKind) {
        fetchingModels = true
        fetchError = nil
        Task {
            defer { fetchingModels = false }
            do {
                availableModels = try await ModelCatalog.fetchModels(kind: kind)
                if availableModels.isEmpty {
                    fetchError = "No models returned."
                }
            } catch {
                fetchError = error.localizedDescription
            }
        }
    }

    private func setModel(_ id: String) {
        let kind = db.settings.apiType
        var s = db.settings
        if kind == .ollama {
            s.ollama.model = id
        } else {
            s.providers[kind.rawValue]?.model = id
        }
        db.settings = s
    }

    // Bindings into nested settings

    private func binding<T>(_ keyPath: WritableKeyPath<AppSettings, T>) -> Binding<T> {
        Binding(
            get: { db.settings[keyPath: keyPath] },
            set: { newValue in
                var s = db.settings
                s[keyPath: keyPath] = newValue
                db.settings = s
            }
        )
    }

    private func keyBinding(_ kind: ProviderKind) -> Binding<String> {
        Binding(
            get: { db.settings.provider(for: kind).apiKey },
            set: { v in
                var s = db.settings
                s.providers[kind.rawValue, default: ProviderSettings()].apiKey = v
                db.settings = s
            }
        )
    }

    private var customURLBinding: Binding<String> {
        Binding(
            get: { db.settings.provider(for: .customProxy).customURL },
            set: { v in
                var s = db.settings
                s.providers[ProviderKind.customProxy.rawValue, default: ProviderSettings()].customURL = v
                db.settings = s
            }
        )
    }

    private func modelBinding(_ kind: ProviderKind) -> Binding<String> {
        Binding(
            get: { db.settings.provider(for: kind).model },
            set: { v in
                var s = db.settings
                s.providers[kind.rawValue, default: ProviderSettings()].model = v
                db.settings = s
            }
        )
    }

    private var ollamaURLBinding: Binding<String> {
        Binding(
            get: { db.settings.ollama.url },
            set: { v in
                var s = db.settings
                s.ollama.url = v
                db.settings = s
            }
        )
    }

    private var ollamaModelBinding: Binding<String> {
        Binding(
            get: { db.settings.ollama.model },
            set: { v in
                var s = db.settings
                s.ollama.model = v
                db.settings = s
            }
        )
    }

    private var subModelBinding: Binding<String> {
        Binding(
            get: { db.settings.subModel },
            set: { v in
                var s = db.settings
                s.subModel = v
                db.settings = s
            }
        )
    }
}
