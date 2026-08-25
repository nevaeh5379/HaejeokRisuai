import AppKit
import Combine
import Foundation
import os

/// Stores binary assets (character images, portraits, persona icons) on disk,
/// addressed by opaque ids — mirroring the web version's `saveAsset`/`getAsset`.
@MainActor
final class AssetStore: ObservableObject {
    static let shared = AssetStore()

    private let fileManager = FileManager.default
    private var imageCache: [String: NSImage] = [:]

    var assetsDirectory: URL {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("HaejeokRisuai/assets", isDirectory: true)
    }

    private func url(for id: String) -> URL {
        // Ids may come from imports with odd characters; sanitize.
        let safe = id.replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "..", with: "_")
        return assetsDirectory.appendingPathComponent(safe)
    }

    init() {
        try? fileManager.createDirectory(at: assetsDirectory, withIntermediateDirectories: true)
    }

    /// Saves data and returns its asset id (a UUID string unless customId is given).
    func saveAsset(_ data: Data, customId: String = "") -> String {
        let id = customId.isEmpty ? UUID().uuidString : customId
        do {
            try fileManager.createDirectory(at: assetsDirectory, withIntermediateDirectories: true)
            try data.write(to: url(for: id), options: .atomic)
        } catch {
            AppLog.persistence.error("Failed to save asset \(id): \(error.localizedDescription)")
        }
        return id
    }

    func getAsset(_ id: String) -> Data? {
        guard !id.isEmpty else { return nil }
        return try? Data(contentsOf: url(for: id))
    }

    func deleteAsset(_ id: String) {
        try? fileManager.removeItem(at: url(for: id))
        imageCache.removeValue(forKey: id)
    }

    func loadImage(_ id: String?) -> NSImage? {
        guard let id, !id.isEmpty else { return nil }
        if let cached = imageCache[id] { return cached }
        guard let data = getAsset(id), let image = NSImage(data: data) else { return nil }
        imageCache[id] = image
        return image
    }
}
