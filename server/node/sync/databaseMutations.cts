"use strict";

import type { RealtimeDatabaseChangeEvent } from "../../../packages/protocol/realtimeEvents.cjs";
import type { RealtimeEventBroadcaster } from "../../../packages/protocol/realtimeEvents.cjs";
import type { SqlCommitImpact } from "../../../packages/protocol/sqlCommit.cjs";
import { attachSqlCommitImpactSink } from "../../../packages/protocol/sqlCommit.cjs";

const { normalizeClientId } = require("../http/realtimeEvents.cjs");

type ServerMutationStorage = {
  sync: (payload: unknown, options?: unknown) => Promise<any>;
  getStorageSyncSummary: () => Promise<any>;
  runStorageSyncFinalizeTransaction: (
    expectedRevision: number,
    callback: (client: any, transactionContext: any) => Promise<any>,
  ) => Promise<any>;
  createChatBranch: (input: any) => Promise<any>;
  activateChatBranch: (chatId: string, branchId: string) => Promise<void>;
  restoreRevision: (revisionId: any) => Promise<any>;
  updateSetting: (key: string, value: any) => Promise<any>;
  deleteSetting: (key: string) => Promise<any>;
  saveBotPreset: (preset: any, position: any) => Promise<any>;
  saveModule: (moduleData: any) => Promise<any>;
  deleteModule: (moduleId: string) => Promise<any>;
  saveMessage: (chatId: string, message: any) => Promise<any>;
  deleteMessage: (chatId: string, messageId: string) => Promise<any>;
};

type MutationArgs = {
  commit: [payload: unknown, rawSourceClientId: unknown, options?: unknown];
  restoreBackup: [payload: any, options: any, rawSourceClientId: unknown];
  storageSyncFinalize: [
    options: Record<string, any>,
    rawSourceClientId: unknown,
  ];
  localBackupStreamFinalize: [
    input: {
      prepared: {
        sourceRevision: number;
        sqlStaging?: any;
        createSqlStaging?: (client: any) => any;
        beforeCommit?: (transactionContext: any) => Promise<void>;
        afterCommit?: (result: any) => Promise<void>;
        rollback?: () => Promise<void>;
        onProgress?: (progress: { applied: number; type: string }) => void;
      };
    },
    rawSourceClientId: unknown,
  ];
  togglePlugin: [input: any, rawSourceClientId: unknown];
  createChatBranch: [input: any, rawSourceClientId: unknown];
  activateChatBranch: [
    chatId: string,
    branchId: string,
    rawSourceClientId: unknown,
  ];
  restoreRevision: [revisionId: any, rawSourceClientId: unknown];
  updateSetting: [key: string, value: any, rawSourceClientId: unknown];
  deleteSetting: [key: string, rawSourceClientId: unknown];
  saveBotPreset: [preset: any, position: any, rawSourceClientId: unknown];
  saveModule: [moduleData: any, rawSourceClientId: unknown];
  deleteModule: [moduleId: string, rawSourceClientId: unknown];
  saveMessage: [chatId: string, message: any, rawSourceClientId: unknown];
  deleteMessage: [
    chatId: string,
    messageId: string,
    rawSourceClientId: unknown,
  ];
};
type MutationName = keyof MutationArgs;

type DatabaseChangeDescriptor = {
  action: string;
  details?: Record<string, unknown>;
  rawSourceClientId: unknown;
};

/**
 * Per-call realtime metadata. The commit impact is derived inside the storage
 * vendor right after payload validation and kept here in memory; it is
 * broadcast only after the mutation succeeded and never serialized into
 * public HTTP responses.
 * 호출별 실시간 메타데이터입니다. 커밋 영향은 페이로드 검증 직후 저장소 벤더
 * 내부에서 도출되어 메모리에만 보관되며, 뮤테이션이 성공한 뒤에만 전파되고
 * 공개 HTTP 응답으로는 직렬화되지 않습니다.
 */
type MutationImpactContext = {
  commitImpact: SqlCommitImpact | null;
};

type MutationDefinition<K extends MutationName> = {
  /**
   * Marks mutations whose options must carry the internal impact sink, so the
   * storage vendor reports the derived impact back to execute().
   * 저장소 벤더가 도출한 영향을 execute로 보고하도록 옵션에 내부 콜백을
   * 실어야 하는 뮤테이션임을 표시합니다.
   */
  readonly tracksCommitImpact?: boolean;
  mutate: (...args: MutationArgs[K]) => Promise<any>;
  describe: (result: any, ...args: MutationArgs[K]) => DatabaseChangeDescriptor;
};

type MutationDefinitionRegistry = {
  [K in MutationName]: MutationDefinition<K>;
};

type DatabaseMutationApi = {
  [K in MutationName]: (...args: MutationArgs[K]) => Promise<any>;
};

type DatabaseMutationDependencies = {
  getStorage: () => ServerMutationStorage;
  finalizeStorageSyncReplacement: (
    options: Record<string, any>,
  ) => Promise<any>;
  applyStorageSyncSqlRecords: (options: Record<string, any>) => Promise<any>;
  getVendor: () => "postgres" | "oracle" | "azure";
  realtimeEventHub: {
    broadcast: RealtimeEventBroadcaster;
  };
};

/**
 * Replaces the mutation options with a private copy that carries the internal
 * commit-impact channel. Legacy function-form options keep working because
 * they are wrapped as { onProgress }, exactly like vendor sync expects.
 * 뮤테이션 옵션을 내부 커밋 영향 채널을 싣은 사본으로 바꿉니다. 구식 함수
 * 형태 옵션은 벤더 sync가 기대하는 { onProgress } 형태로 감싸므로 동작이
 * 그대로 유지됩니다.
 *
 * @param options - Caller-provided options. 호출자가 넘긴 옵션입니다.
 * @param sink - Callback receiving the derived impact. 도출된 영향을 받는 콜백입니다.
 * @returns The options object to pass into storage.sync(). storage.sync()에 전달할 옵션입니다.
 */
function createImpactReportingOptions(
  options: unknown,
  sink: (impact: SqlCommitImpact) => void,
): Record<string, unknown> {
  const wrapper: Record<string, unknown> =
    typeof options === "function"
      ? { onProgress: options }
      : options !== null && typeof options === "object"
        ? { ...(options as Record<string, unknown>) }
        : {};
  attachSqlCommitImpactSink(wrapper, sink);
  return wrapper;
}

function createDatabaseMutations({
  getStorage,
  finalizeStorageSyncReplacement,
  applyStorageSyncSqlRecords,
  getVendor,
  realtimeEventHub,
}: DatabaseMutationDependencies): DatabaseMutationApi {
  const storage = () => getStorage();

  /**
   * Broadcasts one database-change event after a mutation has succeeded. The
   * captured commit impact, when present, wins over static descriptor details
   * and is the only carrier of affected IDs/keys; it never reaches clients
   * through any other channel.
   * 뮤테이션이 성공한 뒤 database-change 이벤트 하나를 전파합니다. 캡처된
   * 커밋 영향이 있으면 정적 descriptor details보다 우선하며, 영향받은
   * ID/키는 이 채널 외에는 클라이언트에 전달되지 않습니다.
   */
  function emit(
    result: any,
    descriptor: DatabaseChangeDescriptor,
    impactContext: MutationImpactContext,
  ): void {
    const impact: SqlCommitImpact | null = impactContext.commitImpact;
    const details: RealtimeDatabaseChangeEvent = impact ??
      (descriptor.details as RealtimeDatabaseChangeEvent | undefined) ??
        // A storage implementation that forgets the impact hook must trigger a
        // conservative full refresh instead of leaving other clients stale.
        // 저장소 구현이 영향 훅을 빠뜨렸다면 다른 클라이언트를 오래된 상태로
        // 남겨두지 않고 보수적인 전체 새로고침을 요청합니다.
        { replaceAll: true };
    realtimeEventHub.broadcast("database-change", {
      ...details,
      ...(result?.revision == null ? {} : { revision: result.revision }),
      action: impact?.action ?? descriptor.action,
      sourceClientId: normalizeClientId(descriptor.rawSourceClientId),
    });
  }

  const definitions = {
    commit: {
      tracksCommitImpact: true,
      mutate: async (payload, _source, options) =>
        await storage().sync(payload, options),
      describe: (_result, _payload, rawSourceClientId) => ({
        action: "sync",
        // The impact arrives through the internal options channel captured
        // during sync(); no static details are derived here.
        // 영향은 sync() 중 내부 옵션 채널로 도착하며, 여기서 정적 details를
        // 따로 만들지 않습니다.
        details: undefined,
        rawSourceClientId,
      }),
    },
    restoreBackup: {
      mutate: async (payload, options) =>
        await storage().sync(payload, options),
      describe: (_result, _payload, _options, rawSourceClientId) => ({
        action: "backup-restore",
        details: { replaceAll: true },
        rawSourceClientId,
      }),
    },
    storageSyncFinalize: {
      mutate: async (options) =>
        await finalizeStorageSyncReplacement({
          ...options,
          sqlStorage: storage(),
          applySqlRecords: async (applyOptions: Record<string, any>) =>
            await applyStorageSyncSqlRecords({
              ...applyOptions,
              vendor: getVendor(),
            }),
        }),
      describe: (_result, _options, rawSourceClientId) => ({
        action: "storage-sync-finalize",
        details: { replaceAll: true },
        rawSourceClientId,
      }),
    },
    localBackupStreamFinalize: {
      mutate: async ({ prepared }) => {
        const sqlStorage = storage();
        const summary = await sqlStorage.getStorageSyncSummary();
        if (!summary) {
          throw new Error("SQL storage is unavailable for backup restore");
        }
        const targetRevision = Number(summary.revision);
        const syncSession = {
          serverRevision: targetRevision,
          peerRevision: prepared.sourceRevision,
        };
        const result = await sqlStorage.runStorageSyncFinalizeTransaction(
          targetRevision,
          async (client, transactionContext) => {
            const sqlStaging =
              typeof prepared.createSqlStaging === "function"
                ? prepared.createSqlStaging(client)
                : prepared.sqlStaging;
            const sqlResult = await applyStorageSyncSqlRecords({
              session: syncSession,
              sqlStaging,
              sqlStorage,
              client,
              transactionContext,
              replaceColdStorage: false,
              vendor: getVendor(),
              onProgress: prepared.onProgress,
            });
            await prepared.beforeCommit?.(transactionContext);
            return { sqlResult };
          },
        );
        await prepared.afterCommit?.(result);
        return result;
      },
      describe: (_result, _input, rawSourceClientId) => ({
        action: "backup-restore",
        details: { replaceAll: true },
        rawSourceClientId,
      }),
    },
    togglePlugin: {
      mutate: async (input) =>
        await storage().sync({
          baseRevision: input.baseRevision,
          action: "plugin-toggle",
          root: {
            upserts: [{ key: "plugins", value: input.plugins }],
            deletes: [],
          },
        }),
      describe: (_result, input, rawSourceClientId) => ({
        action: "plugin-toggle",
        details: {
          pluginName: input.pluginName,
          pluginEnabled: input.enabled,
        },
        rawSourceClientId,
      }),
    },
    createChatBranch: {
      mutate: async (input) => await storage().createChatBranch(input),
      describe: (_result, input, rawSourceClientId) => ({
        action: "chat-branch-create",
        details: { chatIds: [input.chatId], charactersChanged: false },
        rawSourceClientId,
      }),
    },
    activateChatBranch: {
      mutate: async (chatId, branchId) =>
        await storage().activateChatBranch(chatId, branchId),
      describe: (_result, chatId, _branchId, rawSourceClientId) => ({
        action: "chat-branch-activate",
        details: { chatIds: [chatId], charactersChanged: false },
        rawSourceClientId,
      }),
    },
    restoreRevision: {
      mutate: async (revisionId) => await storage().restoreRevision(revisionId),
      describe: (_result, _revisionId, rawSourceClientId) => ({
        action: "revision-restore",
        details: { replaceAll: true },
        rawSourceClientId,
      }),
    },
    updateSetting: {
      mutate: async (key, value) => await storage().updateSetting(key, value),
      describe: (_result, key, _value, rawSourceClientId) => ({
        action: "setting-update",
        details: { rootChanged: true, rootUpsertKeys: [key] },
        rawSourceClientId,
      }),
    },
    deleteSetting: {
      mutate: async (key) => await storage().deleteSetting(key),
      describe: (_result, key, rawSourceClientId) => ({
        action: "setting-delete",
        details: { rootChanged: true, rootDeleteKeys: [key] },
        rawSourceClientId,
      }),
    },
    saveBotPreset: {
      mutate: async (preset, position) =>
        await storage().saveBotPreset(preset, position),
      describe: (_result, _preset, _position, rawSourceClientId) => ({
        action: "preset-save",
        details: { presetsChanged: true },
        rawSourceClientId,
      }),
    },
    saveModule: {
      mutate: async (moduleData) => await storage().saveModule(moduleData),
      describe: (_result, _moduleData, rawSourceClientId) => ({
        action: "module-save",
        details: { modulesChanged: true },
        rawSourceClientId,
      }),
    },
    deleteModule: {
      mutate: async (moduleId) => await storage().deleteModule(moduleId),
      describe: (_result, _moduleId, rawSourceClientId) => ({
        action: "module-delete",
        details: { modulesChanged: true },
        rawSourceClientId,
      }),
    },
    saveMessage: {
      mutate: async (chatId, message) =>
        await storage().saveMessage(chatId, message),
      describe: (_result, chatId, _message, rawSourceClientId) => ({
        action: "message-save",
        details: { chatIds: [chatId], charactersChanged: false },
        rawSourceClientId,
      }),
    },
    deleteMessage: {
      mutate: async (chatId, messageId) =>
        await storage().deleteMessage(chatId, messageId),
      describe: (_result, chatId, _messageId, rawSourceClientId) => ({
        action: "message-delete",
        details: { chatIds: [chatId], charactersChanged: false },
        rawSourceClientId,
      }),
    },
  } satisfies MutationDefinitionRegistry;
  async function execute<K extends MutationName>(
    name: K,
    ...args: MutationArgs[K]
  ): Promise<any> {
    const definition = definitions[name] as MutationDefinition<K>;
    const impactContext: MutationImpactContext = { commitImpact: null };
    if (definition.tracksCommitImpact === true) {
      // Only `commit` routes an untrusted payload through storage.sync(), so
      // only it installs the internal reporting channel. The vendor derives
      // the impact once, right after validating the payload.
      // `commit`만 신뢰할 수 없는 페이로드를 storage.sync로 보내므로, 이
      // 뮤테이션만 내부 보고 채널을 설치합니다. 벤더는 페이로드 검증 직후
      // 영향을 한 번만 도출합니다.
      const commitArgs = args as unknown as MutationArgs["commit"];
      const sink = (impact: SqlCommitImpact): void => {
        impactContext.commitImpact = impact;
      };
      commitArgs[2] = createImpactReportingOptions(commitArgs[2], sink);
    }
    const result = await definition.mutate(...args);
    // The broadcast happens only after the mutation resolved successfully.
    // 전파는 뮤테이션이 성공적으로 끝난 뒤에만 일어납니다.
    emit(result, definition.describe(result, ...args), impactContext);
    return result;
  }

  return {
    commit: (...args) => execute("commit", ...args),
    restoreBackup: (...args) => execute("restoreBackup", ...args),
    storageSyncFinalize: (...args) => execute("storageSyncFinalize", ...args),
    localBackupStreamFinalize: (...args) =>
      execute("localBackupStreamFinalize", ...args),
    togglePlugin: (...args) => execute("togglePlugin", ...args),
    createChatBranch: (...args) => execute("createChatBranch", ...args),
    activateChatBranch: (...args) => execute("activateChatBranch", ...args),
    restoreRevision: (...args) => execute("restoreRevision", ...args),
    updateSetting: (...args) => execute("updateSetting", ...args),
    deleteSetting: (...args) => execute("deleteSetting", ...args),
    saveBotPreset: (...args) => execute("saveBotPreset", ...args),
    saveModule: (...args) => execute("saveModule", ...args),
    deleteModule: (...args) => execute("deleteModule", ...args),
    saveMessage: (...args) => execute("saveMessage", ...args),
    deleteMessage: (...args) => execute("deleteMessage", ...args),
  } satisfies DatabaseMutationApi;
}

export { createDatabaseMutations };
