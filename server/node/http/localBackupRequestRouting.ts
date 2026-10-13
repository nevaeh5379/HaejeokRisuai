function isLocalBackupImportUploadPath(path?: any): any {
  return /^\/api\/local-backup\/import\/jobs\/[^/]+\/(?:file|chunks)$/.test(
    String(path || ""),
  );
}

function isLocalBackupImportFinalizePath(path?: any): any {
  return /^\/api\/local-backup\/import\/jobs\/[^/]+\/finalize-upload$/.test(
    String(path || ""),
  );
}

function isLocalBackupImportControlPath(path?: any): any {
  const normalized: any = String(path || "");
  return (
    /^\/api\/local-backup\/import\/jobs\/[^/]+\/file$/.test(normalized) ||
    isLocalBackupImportFinalizePath(normalized)
  );
}

function isReadOnlyRequestMethod(method?: any): any {
  const normalized: any = String(method || "").toUpperCase();
  return (
    normalized === "GET" || normalized === "HEAD" || normalized === "OPTIONS"
  );
}

export {
  isLocalBackupImportControlPath,
  isLocalBackupImportFinalizePath,
  isLocalBackupImportUploadPath,
  isReadOnlyRequestMethod,
};
