package co.aiclient.risu;

import java.util.regex.Pattern;

final class BackupEntryPolicy {
    enum Kind { DATABASE, ENCRYPTION, COLD_STORAGE, ASSET, EXTENSION, INVALID }

    private static final Pattern COLD_STORAGE = Pattern.compile(
        "^(?:coldstorage[/_])?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\.json$"
    );

    private BackupEntryPolicy() {}

    static Kind classify(String name) {
        if (name == null) return Kind.INVALID;
        String normalized = name.replace('\\', '/');
        String[] parts = normalized.split("/", -1);
        if (parts.length == 0) return Kind.INVALID;
        for (String part : parts) {
            if (part.isEmpty() || ".".equals(part) || "..".equals(part)) return Kind.INVALID;
        }
        if ("database.risudat".equals(normalized)) return Kind.DATABASE;
        if ("encryption.risudat".equals(normalized)) return Kind.ENCRYPTION;
        if (COLD_STORAGE.matcher(normalized).matches()) return Kind.COLD_STORAGE;
        if (normalized.startsWith("assets/") || normalized.indexOf('/') < 0) return Kind.ASSET;
        return Kind.EXTENSION;
    }
}
