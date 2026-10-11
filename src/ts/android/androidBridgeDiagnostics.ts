type NativePromise = (
  plugin: string,
  method: string,
  options?: unknown,
) => Promise<unknown>;

export interface DiagnosticBridge {
  nativePromise?: NativePromise;
}

const REQUEST_STRING_THRESHOLD = 128 * 1024;
const SCAN_LIMIT = 100_000;
const calls = new Set([
  "NativeSqlite.executeBatch",
  "NativeSqlite.queryStreamOpen",
  "NativeSqlite.queryBatch",
  "NativeSqlite.query",
  "NativeSqlite.restoreAppend",
  "StreamedFetch.streamedFetch",
  "CapacitorHttp.request",
  "CapacitorHttp.get",
  "CapacitorHttp.post",
  "CapacitorHttp.put",
  "CapacitorHttp.patch",
  "CapacitorHttp.delete",
  "Filesystem.writeFile",
  "Filesystem.appendFile",
  "StreamFileWriter.write",
  "StreamFileWriter.writeText",
  "StreamFileWriter.writeAssets",
  "NativeIntegration.updateRecentChatWidget",
  "NativeIntegration.updateShortcuts",
  "NativeImage.prepareThumbnails",
  "NativeChat.complete",
  "NativeChat.showNotification",
]);

/** Counts lengths only: no serialization, content, object keys or SQL in reports. */
function requestSize(options: unknown) {
  let chars = 0;
  let max = 0;
  let array = 0;
  let visited = 0;
  let limited = false;
  const ancestors = new WeakSet<object>();
  const visit = (value: unknown, depth: number) => {
    if (++visited > SCAN_LIMIT || depth > 32) {
      limited = true;
      return;
    }
    if (typeof value === "string") {
      chars += value.length;
      max = Math.max(max, value.length);
    } else if (value && typeof value === "object") {
      if (ancestors.has(value)) return;
      ancestors.add(value);
      if (Array.isArray(value)) {
        array = Math.max(array, value.length);
        for (let index = 0; index < value.length && !limited; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );
          if (!descriptor) visit(undefined, depth + 1);
          else if ("value" in descriptor) visit(descriptor.value, depth + 1);
          else limited = true;
        }
      } else {
        for (const key in value) {
          if (limited) break;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor?.enumerable) {
            if ("value" in descriptor) visit(descriptor.value, depth + 1);
            else limited = true; // Don't execute a getter a second time for diagnostics.
          }
        }
      }
      ancestors.delete(value);
    }
  };
  visit(options, 0);
  return { chars, max, array, limited };
}

const installed = new WeakSet<DiagnosticBridge>();

/** Identify the largest generated SQL statement using fixed domain labels only. */
function writeDomain(options: unknown): string {
  if (!options || typeof options !== "object") return "other";
  const statements = Object.getOwnPropertyDescriptor(
    options,
    "statements",
  )?.value;
  if (!Array.isArray(statements)) return "other";
  let largest = 0;
  let domain = "other";
  for (const statement of statements.slice(0, 48)) {
    if (!statement || typeof statement !== "object") continue;
    const sql = Object.getOwnPropertyDescriptor(statement, "sql")?.value;
    const bind = Object.getOwnPropertyDescriptor(statement, "bind")?.value;
    if (typeof sql !== "string" || !Array.isArray(bind)) continue;
    let chars = sql.length;
    for (let index = 0; index < Math.min(bind.length, SCAN_LIMIT); index++) {
      const value = Object.getOwnPropertyDescriptor(bind, String(index))?.value;
      if (typeof value === "string") chars += value.length;
    }
    if (chars <= largest) continue;
    largest = chars;
    const table = /(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/i.exec(
      sql,
    )?.[1];
    domain = "other";
    if (!table) continue;
    for (const prefix of [
      "module_",
      "character_",
      "chat_",
      "message_",
      "setting_",
      "cold_",
    ]) {
      if (table.startsWith(prefix)) domain = prefix.slice(0, -1);
    }
    if (table === "system_settings") domain = "setting";
    if (table === "bot_presets") domain = "preset";
    if (table === "plugin_custom_storage") domain = "plugin-storage";
    if (table === "plugin_records" || table === "plugin_scripts")
      domain = "plugin";
  }
  return domain;
}

/**
 * Capacitor's registered Promise methods dispatch through this shared function.
 * Persist a tiny checkpoint BEFORE a large request reaches MessageHandler's
 * JSON parser, where an OOM occurs before any plugin method can record it.
 */
export function installAndroidBridgeDiagnostics(bridge: DiagnosticBridge) {
  if (!bridge.nativePromise || installed.has(bridge)) return;
  installed.add(bridge);
  const original = bridge.nativePromise;
  let request = 0;
  bridge.nativePromise = (plugin, method, options) => {
    if (plugin === "CrashGuard") {
      return original.call(bridge, plugin, method, options);
    }
    let stage: string | undefined;
    try {
      const size = requestSize(options);
      // Restore's existing bounded chunks are expected; don't fill the journal
      // with thousands of checkpoints during a backup import.
      const restoreChunk =
        plugin === "NativeSqlite" && method === "restoreAppend";
      if (
        size.limited ||
        size.chars >=
          (restoreChunk ? 256 * 1024 + 128 : REQUEST_STRING_THRESHOLD)
      ) {
        const call = `${plugin}.${method}`;
        const name = calls.has(call) ? call : "other";
        stage = `bridge:req=${++request} ${name} strChars=${size.chars} maxStr=${size.max} maxArray=${size.array} limited=${Number(size.limited)}`;
        if (call === "NativeSqlite.executeBatch")
          stage += ` domain=${writeDomain(options)}`;
      }
    } catch {
      // Diagnostics must not change how the original bridge handles options.
    }
    if (!stage) return original.call(bridge, plugin, method, options);
    return (async () => {
      try {
        await original.call(bridge, "CrashGuard", "checkpoint", { stage });
      } catch {
        // Older shells without diagnostics still execute the request.
      }
      return original.call(bridge, plugin, method, options);
    })();
  };
}
