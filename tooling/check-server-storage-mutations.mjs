import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const DIRECT_READ_METHODS = new Set([
  "exportDatabaseSnapshot",
  "getAssetCatalogStats",
  "getBotChatStats",
  "getDbExplorerTableRows",
  "getRevisionDetails",
  "getRevisionDiff",
  "getState",
  "getTokenUsage",
  "isAssetCatalogInitialized",
  "listAssetCatalog",
  "listAssetCatalogEntries",
  "listBotPresets",
  "listChatBranches",
  "listColdStorage",
  "listDbExplorerTables",
  "listPluginCustomStorageKeys",
  "listRecentChats",
  "listRevisions",
  "listSettingKeys",
]);
for (const method of [
  "loadBotPreset",
  "loadBranchMessages",
  "loadCharacter",
  "loadCharacterAssetFields",
  "loadChat",
  "loadChatBranchGraph",
  "loadChatBranchGraphPage",
  "loadChatMessagePage",
  "loadChatMessages",
  "loadColdStorage",
  "loadLorebooks",
  "loadModules",
  "loadPersonas",
  "loadPluginCustomStorage",
  "loadPluginCustomStorageKey",
  "loadPlugins",
  "loadPluginsData",
  "loadPrompts",
  "loadScripts",
  "loadSettingKey",
  "loadStartupData",
  "previewRestore",
  "searchCharactersByName",
  "searchCharactersByTag",
  "searchMessages",
])
  DIRECT_READ_METHODS.add(method);
const INTERNAL_WRITE_METHODS = new Set([
  "close",
  "deleteColdStorage",
  "migrateLegacyColdStorage",
  "pruneColdStorage",
  "removeAssetCatalog",
  "replaceAssetCatalog",
  "upsertAssetCatalog",
  "upsertColdStorage",
]);

const CLIENT_VISIBLE_WRITE_METHODS = new Set([
  "activateChatBranch",
  "createChatBranch",
  "deleteMessage",
  "deleteModule",
  "deleteSetting",
  "restoreRevision",
  "saveBotPreset",
  "saveMessage",
  "saveModule",
  "sync",
  "updateSetting",
]);

function isPrimaryStorageReference(node) {
  return ts.isIdentifier(node) && node.text === "postgresStorage";
}

function isSafePreviousStorageAlias(node) {
  return ts.isIdentifier(node) && node.text === "previousStorage";
}

function locationOf(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return `${sourceFile.fileName}:${line + 1}:${character + 1}`;
}
export function checkServerStorageMutations(
  filePath = resolve("server/node/server.cts"),
) {
  const source = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations = [];

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isPrimaryStorageReference(node.initializer)
    ) {
      if (!isSafePreviousStorageAlias(node.name)) {
        violations.push(
          `${locationOf(sourceFile, node)} aliasing postgresStorage is forbidden; ` +
            "use databaseMutations for client-visible writes",
        );
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isPropertyAccessExpression(node.initializer) &&
      isPrimaryStorageReference(node.initializer.expression)
    ) {
      const method = node.initializer.name.text;
      if (CLIENT_VISIBLE_WRITE_METHODS.has(method)) {
        violations.push(
          `${locationOf(sourceFile, node)} extracting postgresStorage.${method} is forbidden; ` +
            "use databaseMutations",
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "postgresStorage" ||
        node.expression.expression.text === "previousStorage")
    ) {
      const receiver = node.expression.expression.text;
      const method = node.expression.name.text;
      if (receiver === "previousStorage") {
        if (method !== "close") {
          violations.push(
            `${locationOf(sourceFile, node)} previousStorage.${method}() is forbidden; ` +
              "the previous primary storage alias may only be closed",
          );
        }
        ts.forEachChild(node, visit);
        return;
      }
      if (CLIENT_VISIBLE_WRITE_METHODS.has(method)) {
        violations.push(
          `${locationOf(sourceFile, node)} direct write postgresStorage.${method}() ` +
            "must go through databaseMutations",
        );
      } else if (
        !DIRECT_READ_METHODS.has(method) &&
        !INTERNAL_WRITE_METHODS.has(method)
      ) {
        violations.push(
          `${locationOf(sourceFile, node)} unclassified postgresStorage.${method}(); ` +
            "classify it as read/internal or route it through databaseMutations",
        );
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (violations.length > 0) {
    const error = new Error(
      `Server storage mutation policy failed:\n${violations
        .map((entry) => `  - ${entry}`)
        .join("\n")}`,
    );
    error.violations = violations;
    throw error;
  }
  return true;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    checkServerStorageMutations();
    console.log("Server storage mutation policy: OK");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
