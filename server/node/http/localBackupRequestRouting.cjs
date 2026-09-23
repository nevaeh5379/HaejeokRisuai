function isLocalBackupImportUploadPath(path) {
  return /^\/api\/local-backup\/import\/jobs\/[^/]+\/(?:file|chunks)$/.test(
    String(path || ""),
  );
}

function isLocalBackupImportFinalizePath(path) {
  return /^\/api\/local-backup\/import\/jobs\/[^/]+\/finalize-upload$/.test(
    String(path || ""),
  );
}

function isLocalBackupImportControlPath(path) {
  const normalized = String(path || "");
  return (
    /^\/api\/local-backup\/import\/jobs\/[^/]+\/file$/.test(normalized) ||
    isLocalBackupImportFinalizePath(normalized)
  );
}

module.exports = {
  isLocalBackupImportControlPath,
  isLocalBackupImportFinalizePath,
  isLocalBackupImportUploadPath,
};
