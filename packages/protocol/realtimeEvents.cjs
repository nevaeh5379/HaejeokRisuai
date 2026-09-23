"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRealtimeEvent = parseRealtimeEvent;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Returns a non-empty string within the given length budget.
 * 주어진 길이 한도 안의 비어 있지 않은 문자열을 반환합니다.
 */
function readString(value, maxLength) {
    return typeof value === "string" &&
        value.length > 0 &&
        value.length <= maxLength
        ? value
        : undefined;
}
/**
 * Returns a strict boolean, leaving absent or invalid fields undefined.
 * 엄격한 불리언만 통과시키고, 없거나 잘못된 값은 버립니다.
 */
function readBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
/**
 * Returns a non-negative safe integer, the only numeric shape realtime
 * cursors and revisions use.
 * 실시간 커서와 리비전이 쓰는 유일한 숫자 형태인, 음수가 아닌 안전한
 * 정수를 반환합니다.
 */
function readNonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}
/**
 * Validates a string array in place so large change summaries are not copied
 * at the transport boundary.
 * 대형 변경 요약을 전송 경계에서 복사하지 않도록 문자열 배열을 제자리에서
 * 검증합니다.
 */
function readStringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const entries = value;
    for (const entry of entries) {
        if (typeof entry !== "string" ||
            entry.length === 0 ||
            entry.length > MAX_EVENT_DATABASE_ID_LENGTH) {
            return undefined;
        }
    }
    return entries;
}
/**
 * Reads a bounded realtime id-or-null field, preserving the difference
 * between an absent field and an explicit null.
 * 길이가 제한된 실시간 "ID 또는 null" 필드를 읽되, 필드 부재와 명시적
 * null의 차이를 유지합니다.
 */
function readIdOrNull(value, maxLength) {
    if (typeof value === "string")
        return readString(value, maxLength);
    if (value === null)
        return null;
    return undefined;
}
const GENERATION_LIFECYCLE_STATES = [
    "started",
    "finished",
    "failed",
    "aborted",
];
function isGenerationLifecycleState(value) {
    return GENERATION_LIFECYCLE_STATES.includes(value);
}
const MODEL_JOB_STATUS_VALUES = [
    "running",
    "done",
    "failed",
    "aborted",
];
const LOCAL_BACKUP_IMPORT_STATUSES = ["pending", "uploading", "restoring", "complete", "error"];
const LOCAL_BACKUP_IMPORT_STAGES = [
    "uploading",
    "reading",
    "database",
    "coldStorage",
    "assets",
    "inlays",
    "finalizing",
];
function isModelJobStatus(value) {
    return MODEL_JOB_STATUS_VALUES.includes(value);
}
// Length budgets mirror the server-side hub validation, so a malformed or
// hostile stream can never push unbounded strings into client state.
// 길이 한도는 서버 허브 검증과 동일하여, 잘못되거나 악의적인 스트림이
// 무한한 문자열을 클라이언트로 밀어 넣을 수 없습니다.
const MAX_EVENT_ACTION_LENGTH = 64;
const MAX_EVENT_DATABASE_ID_LENGTH = 4000;
const MAX_EVENT_CHAT_ID_LENGTH = 256;
const MAX_EVENT_LIFECYCLE_ID_LENGTH = 128;
const MAX_EVENT_CLIENT_ID_LENGTH = 128;
const MAX_EVENT_ERROR_LENGTH = 8000;
/**
 * Parses the compact database-change event summary. Valid ID arrays are reused
 * without copying so large commits do not create another memory-sized list.
 * 압축된 database-change 이벤트 요약을 해석합니다. 유효한 ID 배열은 복사
 * 없이 재사용하여 대형 커밋이 같은 크기의 목록을 하나 더 만들지 않습니다.
 */
function parseDatabaseChangeEvent(value) {
    if (!isRecord(value))
        return null;
    const event = {};
    const replaceAll = readBoolean(value.replaceAll);
    if (replaceAll !== undefined)
        event.replaceAll = replaceAll;
    const chatIds = readStringArray(value.chatIds);
    if (value.chatIds !== undefined && chatIds === undefined)
        return null;
    if (chatIds !== undefined)
        event.chatIds = chatIds;
    const characterIds = readStringArray(value.characterIds);
    if (value.characterIds !== undefined && characterIds === undefined) {
        return null;
    }
    if (characterIds !== undefined)
        event.characterIds = characterIds;
    const rootUpsertKeys = readStringArray(value.rootUpsertKeys);
    if (value.rootUpsertKeys !== undefined && rootUpsertKeys === undefined) {
        return null;
    }
    if (rootUpsertKeys !== undefined)
        event.rootUpsertKeys = rootUpsertKeys;
    const rootDeleteKeys = readStringArray(value.rootDeleteKeys);
    if (value.rootDeleteKeys !== undefined && rootDeleteKeys === undefined) {
        return null;
    }
    if (rootDeleteKeys !== undefined)
        event.rootDeleteKeys = rootDeleteKeys;
    const pluginStorageUpsertKeys = readStringArray(value.pluginStorageUpsertKeys);
    if (value.pluginStorageUpsertKeys !== undefined &&
        pluginStorageUpsertKeys === undefined) {
        return null;
    }
    if (pluginStorageUpsertKeys !== undefined) {
        event.pluginStorageUpsertKeys = pluginStorageUpsertKeys;
    }
    const pluginStorageDeleteKeys = readStringArray(value.pluginStorageDeleteKeys);
    if (value.pluginStorageDeleteKeys !== undefined &&
        pluginStorageDeleteKeys === undefined) {
        return null;
    }
    if (pluginStorageDeleteKeys !== undefined) {
        event.pluginStorageDeleteKeys = pluginStorageDeleteKeys;
    }
    for (const field of [
        "charactersChanged",
        "rootChanged",
        "pluginStorageCleared",
        "presetsChanged",
        "modulesChanged",
        "pluginsChanged",
    ]) {
        const flag = readBoolean(value[field]);
        if (flag !== undefined)
            event[field] = flag;
    }
    const revision = readNonNegativeInteger(value.revision);
    if (revision !== undefined)
        event.revision = revision;
    const action = readString(value.action, MAX_EVENT_ACTION_LENGTH);
    if (action !== undefined)
        event.action = action;
    const sourceClientId = readIdOrNull(value.sourceClientId, MAX_EVENT_CLIENT_ID_LENGTH);
    if (sourceClientId !== undefined)
        event.sourceClientId = sourceClientId;
    const pluginName = readString(value.pluginName, MAX_EVENT_CLIENT_ID_LENGTH);
    if (pluginName !== undefined)
        event.pluginName = pluginName;
    const pluginEnabled = readBoolean(value.pluginEnabled);
    if (pluginEnabled !== undefined)
        event.pluginEnabled = pluginEnabled;
    return event;
}
/**
 * Parses the compact model-job summary a client needs; the full durable job
 * record never has to be decoded on the realtime path.
 * 클라이언트가 필요로 하는 압축 모델 잡 요약을 해석합니다. 전체 영구 잡
 * 레코드를 실시간 경계에서 해석할 필요는 없습니다.
 */
function parseModelJobEvent(value) {
    if (!isRecord(value))
        return null;
    const phase = value.phase;
    if (phase !== "created" && phase !== "terminal")
        return null;
    const event = { phase };
    if (isRecord(value.job)) {
        const job = {};
        const id = readString(value.job.id, 256);
        if (id !== undefined)
            job.id = id;
        const chatId = readString(value.job.chatId, MAX_EVENT_CHAT_ID_LENGTH);
        if (chatId !== undefined)
            job.chatId = chatId;
        const generationId = readIdOrNull(value.job.generationId, MAX_EVENT_LIFECYCLE_ID_LENGTH);
        if (generationId !== undefined)
            job.generationId = generationId;
        if (isModelJobStatus(value.job.status))
            job.status = value.job.status;
        const recoverable = readBoolean(value.job.recoverable);
        if (recoverable !== undefined)
            job.recoverable = recoverable;
        event.job = job;
    }
    const sourceClientId = readIdOrNull(value.sourceClientId, MAX_EVENT_CLIENT_ID_LENGTH);
    if (sourceClientId !== undefined)
        event.sourceClientId = sourceClientId;
    return event;
}
/**
 * Parses a generation lifecycle state, applying the same length budgets the
 * hub enforces when the state was first accepted.
 * 생성 생명주기 상태를 해석합니다. 허브가 상태를 받을 때 적용한 것과 같은
 * 길이 한도를 적용합니다.
 */
function parseGenerationState(value) {
    if (!isRecord(value))
        return null;
    const chatId = readString(value.chatId, MAX_EVENT_CHAT_ID_LENGTH);
    const lifecycleId = readString(value.lifecycleId, MAX_EVENT_LIFECYCLE_ID_LENGTH);
    if (chatId === undefined || lifecycleId === undefined)
        return null;
    const state = value.state;
    if (!isGenerationLifecycleState(state))
        return null;
    const sourceClientId = readIdOrNull(value.sourceClientId, MAX_EVENT_CLIENT_ID_LENGTH);
    const event = {
        chatId,
        lifecycleId,
        state,
        sourceClientId: sourceClientId ?? null,
    };
    const error = readString(value.error, MAX_EVENT_ERROR_LENGTH);
    if (error !== undefined)
        event.error = error;
    const updatedAt = readNonNegativeInteger(value.updatedAt);
    if (updatedAt !== undefined)
        event.updatedAt = updatedAt;
    return event;
}
function parseLocalBackupImportProgress(value) {
    if (!isRecord(value))
        return null;
    const jobId = readString(value.jobId, 256);
    if (jobId === undefined ||
        !LOCAL_BACKUP_IMPORT_STATUSES.includes(value.status)) {
        return null;
    }
    const event = {
        jobId,
        status: value.status,
    };
    if (value.progress !== undefined) {
        if (!isRecord(value.progress))
            return null;
        if (!LOCAL_BACKUP_IMPORT_STAGES.includes(value.progress.stage)) {
            return null;
        }
        const current = readNonNegativeInteger(value.progress.current);
        const total = readNonNegativeInteger(value.progress.total);
        const detail = readString(value.progress.detail, 1024);
        if (value.progress.current !== undefined && current === undefined)
            return null;
        if (value.progress.total !== undefined && total === undefined)
            return null;
        if (value.progress.detail !== undefined && detail === undefined)
            return null;
        event.progress = {
            stage: value.progress.stage,
            ...(current === undefined ? {} : { current }),
            ...(total === undefined ? {} : { total }),
            ...(detail === undefined ? {} : { detail }),
        };
    }
    return event;
}
/**
 * Parses the ready snapshot sent right after a client is registered. Malformed
 * generation entries are dropped instead of failing the whole snapshot.
 * 클라이언트가 등록된 직후 전송되는 ready 이벤트를 해석합니다. 잘못된 생성
 * 항목은 스냅샷 전체를 실패시키지 않고 버려집니다.
 */
function parseReadyEvent(value) {
    if (!isRecord(value))
        return null;
    const latestEventId = readNonNegativeInteger(value.latestEventId);
    if (latestEventId === undefined)
        return null;
    const event = {
        latestEventId,
        activeGenerations: [],
    };
    const clientId = readString(value.clientId, MAX_EVENT_CLIENT_ID_LENGTH);
    if (clientId !== undefined)
        event.clientId = clientId;
    const connectedAt = readNonNegativeInteger(value.connectedAt);
    if (connectedAt !== undefined)
        event.connectedAt = connectedAt;
    if (Array.isArray(value.activeGenerations)) {
        for (const rawGeneration of value.activeGenerations) {
            const generation = parseGenerationState(rawGeneration);
            if (generation !== null)
                event.activeGenerations.push(generation);
        }
    }
    return event;
}
/**
 * Parses the resync-required event emitted when a client's replay cursor is
 * older than the retained history.
 * 클라이언트 커서가 보관된 기록보다 오래되어 전체 재동기화가 필요할 때
 * 전송되는 resync-required 이벤트를 해석합니다.
 */
function parseResyncRequiredEvent(value) {
    if (!isRecord(value))
        return null;
    const latestEventId = readNonNegativeInteger(value.latestEventId);
    if (latestEventId === undefined)
        return null;
    const event = { latestEventId };
    const oldestRetainedId = readNonNegativeInteger(value.oldestRetainedId);
    if (oldestRetainedId !== undefined)
        event.oldestRetainedId = oldestRetainedId;
    return event;
}
/**
 * Narrows an untrusted SSE/WebSocket JSON value into one of the canonical
 * realtime events. Unknown event names and malformed payloads yield null so
 * callers can skip them without casting JSON.parse results.
 * 신뢰할 수 없는 SSE/WebSocket JSON 값을 표준 실시간 이벤트 중 하나로 좁힙니다.
 * 모르는 이벤트 이름과 잘못된 페이로드는 null을 반환하므로, 호출부는
 * JSON.parse 결과를 그대로 캐스팅하지 않아도 됩니다.
 *
 * @param eventName - Raw event name from the transport. 전송 계층의 원시 이벤트 이름입니다.
 * @param data - Parsed JSON payload (unknown). 해석된 JSON 페이로드(unknown)입니다.
 * @returns The typed event frame, or null when unrecognizable. 형식화된 이벤트 프레임 또는 null입니다.
 */
function parseRealtimeEvent(eventName, data) {
    if (eventName === "database-change") {
        const payload = parseDatabaseChangeEvent(data);
        return payload === null
            ? null
            : { event: "database-change", data: payload };
    }
    if (eventName === "model-job") {
        const payload = parseModelJobEvent(data);
        return payload === null ? null : { event: "model-job", data: payload };
    }
    if (eventName === "generation-state") {
        const payload = parseGenerationState(data);
        return payload === null
            ? null
            : { event: "generation-state", data: payload };
    }
    if (eventName === "local-backup-import-progress") {
        const payload = parseLocalBackupImportProgress(data);
        return payload === null
            ? null
            : { event: "local-backup-import-progress", data: payload };
    }
    if (eventName === "ready") {
        const payload = parseReadyEvent(data);
        return payload === null ? null : { event: "ready", data: payload };
    }
    if (eventName === "resync-required") {
        const payload = parseResyncRequiredEvent(data);
        return payload === null
            ? null
            : { event: "resync-required", data: payload };
    }
    return null;
}
