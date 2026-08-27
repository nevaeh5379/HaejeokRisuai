'use strict';

const COLD_STORAGE_RE = /^(?:coldstorage[\/_])?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.json$/;

function normalizeBackupEntryName(name) {
    if (typeof name !== 'string') return null;
    const normalized = name.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (
        segments.length === 0 ||
        segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) return null;
    return normalized;
}

function classifyBackupEntry(name) {
    const normalized = normalizeBackupEntryName(name);
    if (!normalized) return { kind: 'invalid', normalized: null };
    if (normalized === 'database.risudat') return { kind: 'database', normalized };
    if (normalized === 'encryption.risudat') return { kind: 'encryption', normalized };
    if (COLD_STORAGE_RE.test(normalized)) return { kind: 'coldStorage', normalized };
    if (normalized.startsWith('assets/')) return { kind: 'asset', normalized };
    if (!normalized.includes('/')) return { kind: 'asset', normalized };
    return { kind: 'extension', normalized };
}

module.exports = { COLD_STORAGE_RE, normalizeBackupEntryName, classifyBackupEntry };
