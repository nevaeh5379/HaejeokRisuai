import SwiftUI

/// Editable list of lorebook entries.
struct LorebookEntryListEditor: View {
    @Environment(\.risuTheme) private var theme
    @Binding var entries: [LoreBookEntry]

    @State private var expandedIds: Set<UUID> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("\(entries.count) entries")
                    .font(.caption)
                    .foregroundStyle(theme.textDim)
                Spacer()
                Button {
                    entries.append(LoreBookEntry())
                    if let last = entries.last { expandedIds.insert(last.id) }
                } label: {
                    Label("Add Entry", systemImage: "plus")
                }
            }

            ForEach($entries) { $entry in
                entryRow($entry)
            }
        }
    }

    private func entryRow(_ binding: Binding<LoreBookEntry>) -> some View {
        let entry = binding.wrappedValue
        let expanded = expandedIds.contains(entry.id)

        return VStack(spacing: 0) {
            Button {
                if expanded { expandedIds.remove(entry.id) } else { expandedIds.insert(entry.id) }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .foregroundStyle(theme.textDim)
                        .frame(width: 12)

                    Circle()
                        .fill(entry.alwaysActive ? theme.accent : theme.textDim.opacity(0.4))
                        .frame(width: 7, height: 7)
                        .help(entry.alwaysActive ? "Always active" : "Keyword-triggered")

                    VStack(alignment: .leading, spacing: 1) {
                        Text(entry.comment.isEmpty ? (entry.key.isEmpty ? "Untitled" : entry.key) : entry.comment)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(theme.text)
                            .lineLimit(1)
                        if !entry.comment.isEmpty && !entry.key.isEmpty {
                            Text("🔑 \(entry.key)")
                                .font(.caption2)
                                .foregroundStyle(theme.textDim)
                                .lineLimit(1)
                        }
                    }
                    Spacer()

                    Toggle("", isOn: binding.enabled)
                        .labelsHidden()
                        .controlSize(.mini)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                        LabeledField("Keys (comma separated)") {
                            TextField("dragon, wyvern...", text: binding.key)
                                .textFieldStyle(.roundedBorder)
                        }
                        LabeledField("Comment / Title") {
                            TextField("Lore title", text: binding.comment)
                                .textFieldStyle(.roundedBorder)
                        }
                    }

                    HStack(spacing: 10) {
                        Picker("Mode", selection: binding.mode) {
                            Text("Normal").tag(LoreBookMode.normal)
                            Text("Constant").tag(LoreBookMode.constant)
                        }
                        .pickerStyle(.segmented)
                        .frame(width: 200)

                        Toggle("Selective (requires secondary key)", isOn: binding.selective)
                            .font(.caption)

                        Spacer()

                        Stepper("Order \(binding.wrappedValue.insertOrder)", value: binding.insertOrder, in: 0...999)
                            .font(.caption)
                    }

                    if binding.wrappedValue.selective {
                        LabeledField("Secondary keys (comma separated)") {
                            TextField("optional second condition", text: binding.secondKeysText)
                                .textFieldStyle(.roundedBorder)
                        }
                    }

                    LabeledField("Content") {
                        TextEditor(text: binding.content)
                            .frame(minHeight: 70)
                    }

                    HStack(spacing: 14) {
                        Toggle("Regex keys", isOn: binding.useRegex).font(.caption)
                        Toggle("Case sensitive", isOn: binding.caseSensitive).font(.caption)
                        Toggle("Always active", isOn: binding.alwaysActive).font(.caption)
                        Spacer()
                        Button("Delete", role: .destructive) {
                            entries.removeAll(where: { $0.id == entry.id })
                        }
                        .font(.caption)
                        .foregroundStyle(theme.danger)
                    }
                }
                .padding(12)
                .background(theme.background.opacity(0.4))
            }
            Divider().overlay(theme.border.opacity(0.5))
        }
        .background(theme.surface.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

extension LoreBookEntry {
    /// Bridge for comma-separated secondary keys editing.
    var secondKeysText: String {
        get { secondKeys.joined(separator: ", ") }
        set {
            secondKeys = newValue
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
        }
    }
}

/// Editable list of regex scripts.
struct ScriptListEditor: View {
    @Environment(\.risuTheme) private var theme
    @Binding var scripts: [CustomScriptEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("\(scripts.count) regex scripts")
                    .font(.caption)
                    .foregroundStyle(theme.textDim)
                Spacer()
                Button {
                    scripts.append(CustomScriptEntry())
                } label: {
                    Label("Add Script", systemImage: "plus")
                }
            }

            ForEach($scripts) { $script in
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                        TextField("Script name", text: $script.comment)
                            .textFieldStyle(.roundedBorder)
                        Picker("Placement", selection: $script.placement) {
                            ForEach(ScriptPlacement.allCases, id: \.self) { p in
                                Text(p.label).tag(p)
                            }
                        }
                        .frame(width: 160)

                        Toggle("", isOn: $script.enabled)
                            .labelsHidden()
                            .help("Enabled")

                        Button {
                            scripts.removeAll(where: { $0.id == script.id })
                        } label: {
                            Image(systemName: "trash")
                                .foregroundStyle(theme.danger)
                        }
                        .buttonStyle(.plain)
                    }

                    HStack(spacing: 10) {
                        LabeledField("Find (regex)") {
                            TextField("pattern", text: $script.findRegex)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.body, design: .monospaced))
                        }
                        LabeledField("Replace with") {
                            TextField("replacement", text: $script.replaceWith)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.body, design: .monospaced))
                        }
                    }
                }
                .padding(12)
                .background(theme.surface.opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}
