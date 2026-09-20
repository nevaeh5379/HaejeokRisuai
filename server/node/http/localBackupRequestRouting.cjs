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

module.exports = {
  isLocalBackupImportFinalizePath,
  isLocalBackupImportUploadPath,
};
