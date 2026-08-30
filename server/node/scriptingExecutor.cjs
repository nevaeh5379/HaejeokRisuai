'use strict';

/**
 * Node-server-side Lua scripting executor.
 *
 * In Node mode the character Lua scripts (chat triggers, edit triggers,
 * button triggers) are executed here, in the server process, instead of in
 * the browser. The engine lifecycle mirrors the client implementation in
 * src/ts/process/scriptings.ts:
 *   - one persistent engine per script "mode" (input, output, start,
 *     onButtonClick, editRequest/editDisplay/editInput/editOutput, custom)
 *   - the engine is recreated whenever the script code changes, so user
 *     script globals persist across runs while the server is alive
 *   - a run executes the mode entry function with a per-run access key and
 *     returns { res, stopSending, chat, charChanges, ... }
 *
 * APIs that need browser resources (UI dialogs, LLM requests, the message
 * parser, inlay/asset generation, similarity search) are bridged back to the
 * originating client through the realtime event stream (`scripting-call`
 * events) and answered via /api/scripting/call-response.
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_ENGINES = 64;
const MAX_PENDING_CALLS_PER_RUN = 64;
const MAX_TOTAL_PENDING_CALLS = 256;
const CALL_TIMEOUT_MS = 300000;
const MAX_SLEEP_MS = 300000;
const MAX_REQUEST_CHARS = 120;
const REQUEST_RATE_LIMIT = { windowMs: 60000, max: 5 };
const BANNED_REQUEST_PREFIXES = [
    'https://realm.risuai.net',
    'https://risuai.net',
    'https://risuai.xyz',
];

class AsyncMutex {
    constructor() {
        this.queue = [];
        this.isLocked = false;
    }

    acquire() {
        return new Promise((resolve) => {
            this.queue.push({ resolve });
            this.dispatch();
        });
    }

    async runExclusive(callback) {
        const release = await this.acquire();
        try {
            return await callback();
        } finally {
            release();
        }
    }

    dispatch() {
        if (this.isLocked) return;
        const next = this.queue.shift();
        if (!next) return;
        this.isLocked = true;
        next.resolve(() => {
            this.isLocked = false;
            this.dispatch();
        });
    }
}

function parseKeyValue(template) {
    if (!template || typeof template !== 'string') return [];
    const pairs = [];
    for (const line of template.split('\n')) {
        const [key, value] = line.split('=');
        if (key && value) pairs.push([key, value]);
    }
    return pairs;
}

function normalizeMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    if (typeof message.role !== 'string') return null;
    return { ...message, data: typeof message.data === 'string' ? message.data : '' };
}

function normalizeLoreBook(book) {
    if (!book || typeof book !== 'object' || Array.isArray(book)) return null;
    if (typeof book.comment !== 'string') return null;
    return {
        ...book,
        content: typeof book.content === 'string' ? book.content : '',
        contentParsed: typeof book.contentParsed === 'string' ? book.contentParsed : '',
    };
}

function normalizeRunPayload(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw Object.assign(new TypeError('scripting run payload must be an object'), { code: 'invalid_scripting_run' });
    }
    if (typeof raw.runId !== 'string' || raw.runId.length === 0 || raw.runId.length > 128) {
        throw Object.assign(new TypeError('scripting runId is invalid'), { code: 'invalid_scripting_run' });
    }
    if (typeof raw.mode !== 'string' || raw.mode.length === 0 || raw.mode.length > 256) {
        throw Object.assign(new TypeError('scripting mode is invalid'), { code: 'invalid_scripting_run' });
    }
    if (typeof raw.code !== 'string' || raw.code.length > 1024 * 1024) {
        throw Object.assign(new TypeError('scripting code is invalid'), { code: 'invalid_scripting_run' });
    }
    if (raw.data !== undefined && typeof raw.data !== 'string' && !Array.isArray(raw.data)) {
        throw Object.assign(new TypeError('scripting data must be a string or array'), { code: 'invalid_scripting_run' });
    }
    if (raw.meta !== undefined && (typeof raw.meta !== 'object' || Array.isArray(raw.meta))) {
        throw Object.assign(new TypeError('scripting meta must be an object'), { code: 'invalid_scripting_run' });
    }
    const chat = raw.chat && typeof raw.chat === 'object' && !Array.isArray(raw.chat) ? raw.chat : {};
    const char = raw.char && typeof raw.char === 'object' && !Array.isArray(raw.char) ? raw.char : {};
    const target = raw.target && typeof raw.target === 'object' && !Array.isArray(raw.target) ? raw.target : {};
    const settings = raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings) ? raw.settings : {};
    const messages = Array.isArray(chat.message) ? chat.message.map(normalizeMessage).filter(Boolean) : [];
    const localLore = Array.isArray(chat.localLore) ? chat.localLore.map(normalizeLoreBook).filter(Boolean) : [];
    const globalLore = Array.isArray(char.globalLore) ? char.globalLore.map(normalizeLoreBook).filter(Boolean) : [];
    const moduleLorebooks = Array.isArray(raw.moduleLorebooks) ? raw.moduleLorebooks.map(normalizeLoreBook).filter(Boolean) : [];
    const encoding = typeof raw.encoding === 'string' && raw.encoding.length > 0 && raw.encoding.length <= 64
        ? raw.encoding
        : 'o200k_base';
    return {
        runId: raw.runId,
        clientId: typeof raw.clientId === 'string' ? raw.clientId.slice(0, 128) : '',
        mode: raw.mode,
        code: raw.code,
        lowLevelAccess: raw.lowLevelAccess === true,
        data: raw.data === undefined ? '' : raw.data,
        meta: raw.meta === undefined ? {} : raw.meta,
        triggerId: typeof raw.triggerId === 'string' ? raw.triggerId : null,
        varSnapshot: (raw.varSnapshot && typeof raw.varSnapshot === 'object' && !Array.isArray(raw.varSnapshot))
            ? {
                local: toStringMap(raw.varSnapshot.local),
                temp: toStringMap(raw.varSnapshot.temp),
                displayMode: raw.varSnapshot.displayMode === true,
            }
            : null,
        char: {
            type: typeof char.type === 'string' ? char.type : 'character',
            chaId: typeof char.chaId === 'string' ? char.chaId : '',
            name: typeof char.name === 'string' ? char.name : '',
            desc: typeof char.desc === 'string' ? char.desc : '',
            firstMessage: typeof char.firstMessage === 'string' ? char.firstMessage : '',
            backgroundHTML: typeof char.backgroundHTML === 'string' ? char.backgroundHTML : '',
            defaultVariables: typeof char.defaultVariables === 'string' ? char.defaultVariables : '',
            globalLore,
        },
        chat: {
            id: typeof chat.id === 'string' ? chat.id : '',
            note: typeof chat.note === 'string' ? chat.note : '',
            scriptstate: chat.scriptstate && typeof chat.scriptstate === 'object' && !Array.isArray(chat.scriptstate)
                ? { ...chat.scriptstate }
                : {},
            GLGlobalVariables: chat.GLGlobalVariables && typeof chat.GLGlobalVariables === 'object' && !Array.isArray(chat.GLGlobalVariables)
                ? { ...chat.GLGlobalVariables }
                : {},
            useLocallySetGlobalVariables: chat.useLocallySetGlobalVariables === true,
            localLore,
            message: messages,
        },
        moduleLorebooks,
        target: {
            characterId: typeof target.characterId === 'string' ? target.characterId : '',
            chatId: typeof target.chatId === 'string' ? target.chatId : '',
            globalVariables: target.globalVariables && typeof target.globalVariables === 'object' && !Array.isArray(target.globalVariables)
                ? { ...target.globalVariables }
                : undefined,
            personaName: typeof target.personaName === 'string' ? target.personaName : '',
            personaDescription: typeof target.personaDescription === 'string' ? target.personaDescription : '',
        },
        settings: {
            globalChatVariables: settings.globalChatVariables && typeof settings.globalChatVariables === 'object' && !Array.isArray(settings.globalChatVariables)
                ? { ...settings.globalChatVariables }
                : {},
            templateDefaultVariables: typeof settings.templateDefaultVariables === 'string' ? settings.templateDefaultVariables : '',
        },
        encoding,
    };
}

/**
 * Same Lua preamble the client mounts before user code
 * (mirror of luaCodeWrapper in src/ts/process/scriptings.ts).
 */
function luaCodeWrapper(code) {
    return `
json = require 'json'

function getChat(id, index)
    return json.decode(getChatMain(id, index))
end

function getFullChat(id)
    return json.decode(getFullChatMain(id))
end

function getRecentChats(id, count)
    return json.decode(getRecentChatsMain(id, count))
end

function setFullChat(id, value)
    setFullChatMain(id, json.encode(value))
end

function log(value)
    logMain(json.encode(value))
end

function getLoreBooks(id, search)
    return json.decode(getLoreBooksMain(id, search))
end

-- On the server cbs is bridged to the client, so the host returns a promise.
-- Keep the client-facing contract (plain string result) by awaiting here.
local cbsHost = cbs
function cbs(value)
    local result = cbsHost(value)
    local ok, awaitFn = pcall(function() return result.await end)
    if ok and awaitFn ~= nil then
        return result:await()
    end
    return result
end


function loadLoreBooks(id)
    return json.decode(loadLoreBooksMain(id):await())
end

function LLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(LLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function axLLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(axLLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function getCharacterImage(id)
    return getCharacterImageMain(id):await()
end

function getPersonaImage(id)
    return getPersonaImageMain(id):await()
end

local editRequestFuncs = {}
local editDisplayFuncs = {}
local editInputFuncs = {}
local editOutputFuncs = {}

function listenEdit(type, func)
    if type == 'editRequest' then
        editRequestFuncs[#editRequestFuncs + 1] = func
        return
    end

    if type == 'editDisplay' then
        editDisplayFuncs[#editDisplayFuncs + 1] = func
        return
    end

    if type == 'editInput' then
        editInputFuncs[#editInputFuncs + 1] = func
        return
    end

    if type == 'editOutput' then
        editOutputFuncs[#editOutputFuncs + 1] = func
        return
    end

    throw('Invalid type')
end

function getState(id, name)
    local escapedName = "__"..name
    return json.decode(getChatVar(id, escapedName))
end

function setState(id, name, value)
    local escapedName = "__"..name
    setChatVar(id, escapedName, json.encode(value))
end

function setStateChanged(id, name, value)
    local escapedName = "__"..name
    return setChatVarChanged(id, escapedName, json.encode(value))
end

function async(callback)
    return function(...)
        local co = coroutine.create(callback)
        local safe, result = coroutine.resume(co, ...)

        return Promise.create(function(resolve, reject)
            local checkresult
            local step = function()
                if coroutine.status(co) == "dead" then
                    local send = safe and resolve or reject
                    return send(result)
                end

                safe, result = coroutine.resume(co)
                checkresult()
            end

            checkresult = function()
                if safe and result == Promise.resolve(result) then
                    result:finally(step)
                else
                    step()
                end
            end

            checkresult()
        end)
    end
end

-- Server-side dispatch trampoline: runs the mode entry function inside a
-- coroutine so that host APIs returning promises (LLM, alerts, ...) can be
-- awaited with :await() from any mode. The browser wasmoon build cannot yield
-- inside direct JavaScript->Lua calls, so the client only gets this guarantee
-- for edit modes (callListenMain). The server routes every direct mode through
-- the same coroutine wrapper.
__risu_run_mode = async(function(mode, id, data, meta)
    if mode == 'input' then
        local fn = rawget(_G, 'onInput')
        if fn == nil then return nil end
        return fn(id)
    end
    if mode == 'output' then
        local fn = rawget(_G, 'onOutput')
        if fn == nil then return nil end
        return fn(id)
    end
    if mode == 'start' then
        local fn = rawget(_G, 'onStart')
        if fn == nil then return nil end
        return fn(id)
    end
    if mode == 'onButtonClick' then
        local fn = rawget(_G, 'onButtonClick')
        if fn == nil then return nil end
        return fn(id, data)
    end
    local fn = rawget(_G, mode)
    if fn == nil then return nil end
    return fn(id)
end)

callListenMain = async(function(type, id, value, meta)
    local realValue = json.decode(value)
    local realMeta = json.decode(meta)

    if type == 'editRequest' then
        for _, func in ipairs(editRequestFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editDisplay' then
        for _, func in ipairs(editDisplayFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editInput' then
        for _, func in ipairs(editInputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editOutput' then
        for _, func in ipairs(editOutputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    return json.encode(realValue)
end)

-- Reports how many edit listeners the loaded code registered. The client
-- caches this per code and skips the server round trip entirely for edit
-- modes with zero listeners (the common case when a chat re-render runs
-- every triggerlua trigger in editDisplay mode).
function __risu_edit_listener_counts()
    return json.encode({
        editRequest = #editRequestFuncs,
        editDisplay = #editDisplayFuncs,
        editInput = #editInputFuncs,
        editOutput = #editOutputFuncs,
    })
end

${code}
`;
}

function toStringMap(value) {
    const result = {};
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, entry] of Object.entries(value)) {
            if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
                result[key] = String(entry);
            }
        }
    }
    return result;
}

function makeRunContext(payload) {
    const accessKey = crypto.randomUUID();
    // Client parity (scriptings.ts accessKey tiers): editDisplay runs only
    // get the chat-var tier (ScriptingEditDisplayIds). Every other mode gets
    // the safe tier (ScriptingSafeIds) and, with lowLevelAccess, the
    // low-level tier. In particular reloadDisplay()/reloadChat() are ignored
    // for editDisplay runs on the client; allowing them here would loop:
    // display render -> editDisplay run -> reloadDisplay -> re-render -> ...
    const editDisplayMode = payload.mode === 'editDisplay';
    return {
        runId: payload.runId,
        clientId: payload.clientId,
        varSnapshot: payload.varSnapshot,
        varWrites: new Map(),
        char: payload.char,
        chat: payload.chat,
        moduleLorebooks: payload.moduleLorebooks,
        target: payload.target,
        settings: payload.settings,
        encoding: payload.encoding,
        data: payload.data,
        meta: payload.meta,
        triggerId: payload.triggerId,
        accessKey,
        allowedIds: new Set([accessKey]),
        safeIds: editDisplayMode ? new Set() : new Set([accessKey]),
        lowLevelIds:
            payload.lowLevelAccess && !editDisplayMode
                ? new Set([accessKey])
                : new Set(),
        stopSending: false,
        messagesMutated: false,
        chatFieldsMutated: false,
        charChanges: {},
        reloadDisplay: false,
        reloadChatIndexes: new Set(),
        errors: [],
    };
}

function createNodeScriptingExecutor({
    broadcast,
    jsonLuaPath = path.join(__dirname, '..', '..', 'public', 'lua', 'json.lua'),
    countTokensBatch,
    fetchImpl = typeof fetch === 'function' ? fetch : undefined,
    now = () => Date.now(),
} = {}) {
    if (typeof broadcast !== 'function') throw new TypeError('broadcast is required');
    if (typeof countTokensBatch !== 'function') throw new TypeError('countTokensBatch is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');

    let luaFactory = null;
    let luaFactoryPromise = null;
    const engines = new Map();
    const pendingCalls = new Map(); // runId -> Map(callId -> { resolve, timer })
    let requestWindowStart = 0;
    let requestWindowCount = 0;

    async function ensureLuaFactory() {
        if (luaFactory) return luaFactory;
        if (!luaFactoryPromise) {
            luaFactoryPromise = (async () => {
                const { LuaFactory } = require('wasmoon');
                const factory = new LuaFactory();
                let code = '';
                for (let i = 0; i < 3; i += 1) {
                    try {
                        code = await fs.readFile(jsonLuaPath, 'utf8');
                        break;
                    } catch {
                        // retry, mirroring the client fetch behaviour
                    }
                }
                await factory.mountFile('json.lua', code);
                return factory;
            })().finally(() => {
                luaFactoryPromise = null;
            });
        }
        const factory = await luaFactoryPromise;
        luaFactory = factory;
        return factory;
    }

    function requestClientCall(ctx, kind, args) {
        if (!pendingCalls.has(ctx.runId)) pendingCalls.set(ctx.runId, new Map());
        const calls = pendingCalls.get(ctx.runId);
        if (calls.size >= MAX_PENDING_CALLS_PER_RUN || totalPendingCalls() >= MAX_TOTAL_PENDING_CALLS) {
            return Promise.resolve({ result: undefined, error: 'too many concurrent scripting calls' });
        }
        const callId = crypto.randomUUID();
        const promise = new Promise((resolve) => {
            const timer = setTimeout(() => {
                calls.delete(callId);
                if (calls.size === 0) pendingCalls.delete(ctx.runId);
                resolve({ result: undefined, error: `scripting call timed out after ${CALL_TIMEOUT_MS / 1000}s` });
            }, CALL_TIMEOUT_MS);
            calls.set(callId, { resolve, timer });
        });
        try {
            broadcast('scripting-call', {
                runId: ctx.runId,
                clientId: ctx.clientId,
                callId,
                kind,
                args,
            });
        } catch (error) {
            const entry = calls.get(callId);
            if (entry) {
                clearTimeout(entry.timer);
                calls.delete(callId);
                if (calls.size === 0) pendingCalls.delete(ctx.runId);
            }
            return Promise.resolve({ result: undefined, error: 'failed to notify client' });
        }
        return promise;
    }

    function totalPendingCalls() {
        let total = 0;
        for (const calls of pendingCalls.values()) total += calls.size;
        return total;
    }

    function resolvePendingCall(runId, callId, response) {
        const calls = pendingCalls.get(runId);
        const entry = calls && calls.get(callId);
        if (!entry) return false;
        clearTimeout(entry.timer);
        calls.delete(callId);
        if (calls.size === 0) pendingCalls.delete(runId);
        entry.resolve({
            result: response && response.result !== undefined ? response.result : undefined,
            error: response && typeof response.error === 'string' ? response.error : undefined,
        });
        return true;
    }

    function failCall(ctx, kind, message) {
        ctx.errors.push(`${kind}: ${message}`);
        return { result: undefined, error: message };
    }

    function declareApis(state) {
        const ctxOf = () => state.ctx;

        // Variable resolution mirrors the trigger engine's getVar order:
        // in-script writes, trigger-local scope, chat scriptstate, defaults,
        // display temp vars. When a varSnapshot is present the run is a
        // trigger-scoped execution and writes are collected (varWrites) for
        // replay through the client's trigger closure instead of mutating the
        // chat scriptstate directly.
        const resolveVar = (ctx, key) => {
            const written = ctx.varWrites.get(key);
            if (written !== undefined) return written;
            if (ctx.varSnapshot && ctx.varSnapshot.local[key] !== undefined) {
                return ctx.varSnapshot.local[key];
            }
            const state = ctx.chat.scriptstate['$' + key];
            if (state !== undefined && state !== null) return String(state);
            const defaults = parseKeyValue(ctx.char.defaultVariables).concat(parseKeyValue(ctx.settings.templateDefaultVariables));
            const found = defaults.find((pair) => pair[0] === key);
            if (found) return found[1];
            if (ctx.varSnapshot && ctx.varSnapshot.displayMode && ctx.varSnapshot.temp[key] !== undefined) {
                return ctx.varSnapshot.temp[key];
            }
            return 'null';
        };
        state.engine.global.set('getChatVar', (id, key) => {
            const ctx = ctxOf();
            return resolveVar(ctx, key);
        });
        state.engine.global.set('setChatVar', (id, key, value) => {
            const ctx = ctxOf();
            if (!ctx.allowedIds.has(id)) return;
            const changed = resolveVar(ctx, key) !== String(value);
            if (ctx.varSnapshot) {
                ctx.varWrites.set(key, String(value));
                return changed;
            }
            const stateKey = '$' + key;
            if (ctx.chat.scriptstate[stateKey] === value) return false;
            ctx.chat.scriptstate[stateKey] = value;
            ctx.chatFieldsMutated = true;
            return true;
        });
        state.engine.global.set('setChatVarChanged', (id, key, value) => {
            const ctx = ctxOf();
            if (!ctx.allowedIds.has(id)) return;
            const changed = resolveVar(ctx, key) !== String(value);
            if (ctx.varSnapshot) {
                ctx.varWrites.set(key, String(value));
                return changed ? true : undefined;
            }
            const stateKey = '$' + key;
            if (ctx.chat.scriptstate[stateKey] === value) return;
            ctx.chat.scriptstate[stateKey] = value;
            ctx.chatFieldsMutated = true;
            return true;
        });
        state.engine.global.set('getGlobalVar', (id, key) => {
            const ctx = ctxOf();
            if (ctx.target.globalVariables && ctx.target.globalVariables[key] !== undefined) {
                return ctx.target.globalVariables[key];
            }
            if (ctx.chat.GLGlobalVariables[key] !== undefined) return ctx.chat.GLGlobalVariables[key];
            if (ctx.settings.globalChatVariables[key] !== undefined) return ctx.settings.globalChatVariables[key];
            return 'null';
        });
        state.engine.global.set('stopChat', (id) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            ctx.stopSending = true;
        });
        state.engine.global.set('alertError', (id, value) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            return requestClientCall(ctx, 'alertError', { value: typeof value === 'string' ? value : String(value) }).then(() => undefined);
        });
        state.engine.global.set('alertNormal', (id, value) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            return requestClientCall(ctx, 'alertNormal', { value: typeof value === 'string' ? value : String(value) }).then(() => undefined);
        });
        state.engine.global.set('alertInput', (id, value) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            const call = requestClientCall(ctx, 'alertInput', { value: typeof value === 'string' ? value : String(value) });
            return call.then((response) => (response.error ? undefined : response.result));
        });
        state.engine.global.set('alertSelect', (id, value) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            const items = Array.isArray(value) ? value.map((v) => String(v)) : [String(value)];
            const call = requestClientCall(ctx, 'alertSelect', { value: items });
            return call.then((response) => (response.error ? undefined : response.result));
        });
        state.engine.global.set('alertConfirm', (id, value) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            const call = requestClientCall(ctx, 'alertConfirm', { value: typeof value === 'string' ? value : String(value) });
            return call.then((response) => (response.error ? false : response.result === true));
        });
        state.engine.global.set('getChatMain', (id, index) => {
            const ctx = ctxOf();
            const message = ctx.chat.message.at(typeof index === 'number' ? index : Number(index));
            if (!message) return JSON.stringify(null);
            return JSON.stringify({ role: message.role, data: message.data, time: message.time ?? 0 });
        });
        state.engine.global.set('getChatData', (id, index) => {
            const ctx = ctxOf();
            const message = ctx.chat.message.at(typeof index === 'number' ? index : Number(index));
            return message ? message.data : '';
        });
        state.engine.global.set('getChatRole', (id, index) => {
            const ctx = ctxOf();
            const message = ctx.chat.message.at(typeof index === 'number' ? index : Number(index));
            return message ? message.role : '';
        });
        state.engine.global.set('getRecentChatsMain', (id, count) => {
            const ctx = ctxOf();
            const safeCount = Math.max(0, Math.floor(count || 0));
            const start = Math.max(0, ctx.chat.message.length - safeCount);
            return JSON.stringify(ctx.chat.message.slice(start).map((v) => ({
                role: v.role,
                data: v.data,
                time: v.time ?? 0,
            })));
        });
        state.engine.global.set('setChat', (id, index, value) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            const message = ctx.chat.message.at(typeof index === 'number' ? index : Number(index));
            if (message) {
                const newValue = value ?? '';
                if (message.data !== newValue) {
                    message.data = newValue;
                    ctx.messagesMutated = true;
                }
            }
        });
        state.engine.global.set('setChatRole', (id, index, value) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            const message = ctx.chat.message.at(typeof index === 'number' ? index : Number(index));
            if (message) {
                message.role = value === 'user' ? 'user' : 'char';
                ctx.messagesMutated = true;
            }
        });
        state.engine.global.set('cutChat', (id, start, end) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            ctx.chat.message = ctx.chat.message.slice(start, end);
            ctx.messagesMutated = true;
        });
        state.engine.global.set('removeChat', (id, index) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            if (ctx.chat.message.splice(index, 1).length > 0) {
                ctx.messagesMutated = true;
            }
        });
        state.engine.global.set('addChat', (id, role, value) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            ctx.chat.message.push({ role: role === 'user' ? 'user' : 'char', data: value ?? '' });
            ctx.messagesMutated = true;
        });
        state.engine.global.set('insertChat', (id, index, role, value) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            ctx.chat.message.splice(index, 0, { role: role === 'user' ? 'user' : 'char', data: value ?? '' });
            ctx.messagesMutated = true;
        });
        state.engine.global.set('getTokens', async (id, value) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            try {
                const counts = await countTokensBatch([String(value)], ctx.encoding);
                return counts[0] ?? 0;
            } catch (error) {
                ctx.errors.push(`getTokens: ${error.message}`);
                return 0;
            }
        });
        state.engine.global.set('getChatLength', (id) => {
            const ctx = ctxOf();
            return ctx.chat.message.length;
        });
        state.engine.global.set('getFullChatMain', (id) => {
            const ctx = ctxOf();
            return JSON.stringify(ctx.chat.message.map((v) => ({
                role: v.role,
                data: v.data,
                time: v.time ?? 0,
            })));
        });
        state.engine.global.set('sleep', (id, time) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            const ms = Math.min(Math.max(0, Math.floor(Number(time) || 0)), MAX_SLEEP_MS);
            return new Promise((resolve) => {
                setTimeout(() => resolve(true), ms);
            });
        });
        state.engine.global.set('cbs', (value) => {
            const ctx = ctxOf();
            const rawValue = typeof value === 'string' ? value : String(value);
            return requestClientCall(ctx, 'cbs', { value: rawValue }).then((call) => {
                if (call.error || typeof call.result !== 'string') return rawValue;
                return call.result;
            });
        });
        state.engine.global.set('setFullChatMain', (id, value) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            let parsed;
            try {
                parsed = JSON.parse(value);
            } catch {
                return;
            }
            if (!Array.isArray(parsed)) return;
            const previous = ctx.chat.message;
            ctx.chat.message = parsed.map((v, index) => ({
                ...(previous[index] ?? {}),
                role: v.role,
                data: v.data,
            }));
            ctx.messagesMutated = true;
        });
        state.engine.global.set('logMain', (value) => {
            try {
                console.log(JSON.parse(value));
            } catch {
                console.log(value);
            }
        });
        state.engine.global.set('reloadDisplay', (id) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            ctx.reloadDisplay = true;
        });
        state.engine.global.set('reloadChat', (id, index) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            ctx.reloadChatIndexes.add(typeof index === 'number' ? index : Number(index));
        });
        state.engine.global.set('similarity', async (id, source, value) => {
            const ctx = ctxOf();
            if (!ctx.lowLevelIds.has(id)) return;
            const call = await requestClientCall(ctx, 'similarity', {
                source: typeof source === 'string' ? source : '',
                value: Array.isArray(value) ? value.map((v) => String(v)) : [String(value)],
            });
            if (call.error) return failCall(ctx, 'similarity', call.error);
            return call.result;
        });
        state.engine.global.set('request', async (id, url) => {
            const ctx = ctxOf();
            if (!ctx.lowLevelIds.has(id)) return;
            if (now() - requestWindowStart > REQUEST_RATE_LIMIT.windowMs) {
                requestWindowStart = now();
                requestWindowCount = 0;
            }
            if (requestWindowCount > REQUEST_RATE_LIMIT.max) {
                return JSON.stringify({ status: 429, data: 'Too many requests. you can request 5 times per minute' });
            }
            requestWindowCount += 1;
            try {
                if (typeof url !== 'string' || url.length > MAX_REQUEST_CHARS) {
                    return JSON.stringify({ status: 413, data: 'URL to large. max is 120 characters' });
                }
                if (!url.startsWith('https://')) {
                    return JSON.stringify({ status: 400, data: 'Only https requests are allowed' });
                }
                for (const banned of BANNED_REQUEST_PREFIXES) {
                    if (url.startsWith(banned)) {
                        return JSON.stringify({ status: 400, data: 'request to ' + url + ' is not allowed' });
                    }
                }
                const response = await fetchImpl(url, { method: 'GET' });
                const text = await response.text();
                return JSON.stringify({ status: response.status, data: text });
            } catch (error) {
                return JSON.stringify({ status: 400, data: 'internal error' });
            }
        });
        state.engine.global.set('generateImage', async (id, value, negValue = '') => {
            const ctx = ctxOf();
            if (!ctx.lowLevelIds.has(id)) return;
            if (ctx.char.type !== 'character') return 'Error: Image generation requires a character';
            const call = await requestClientCall(ctx, 'generateImage', {
                value: typeof value === 'string' ? value : '',
                negValue: typeof negValue === 'string' ? negValue : '',
            });
            if (call.error) return `Error: ${call.error}`;
            return typeof call.result === 'string' ? call.result : 'Error: Image generation failed';
        });
        state.engine.global.set('getCharacterImageMain', async (id) => {
            const ctx = ctxOf();
            if (ctx.char.type !== 'character') return '';
            const call = await requestClientCall(ctx, 'getCharacterImage', {});
            if (call.error) {
                ctx.errors.push(`getCharacterImage: ${call.error}`);
                return '';
            }
            return typeof call.result === 'string' ? call.result : '';
        });
        state.engine.global.set('getPersonaImageMain', async (id) => {
            const ctx = ctxOf();
            const call = await requestClientCall(ctx, 'getPersonaImage', {});
            if (call.error) {
                ctx.errors.push(`getPersonaImage: ${call.error}`);
                return '';
            }
            return typeof call.result === 'string' ? call.result : '';
        });
        state.engine.global.set('hash', async (id, value) => {
            return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
        });
        state.engine.global.set('LLMMain', async (id, promptStr, useMultimodal = false, optionsStr = '') => {
            const ctx = ctxOf();
            if (!ctx.lowLevelIds.has(id)) return;
            let prompt;
            try {
                prompt = JSON.parse(promptStr);
            } catch {
                return JSON.stringify({ success: false, result: 'Error: invalid prompt' });
            }
            if (!Array.isArray(prompt)) {
                return JSON.stringify({ success: false, result: 'Error: invalid prompt' });
            }
            const call = await requestClientCall(ctx, 'llm', {
                target: 'model',
                prompt,
                useMultimodal: useMultimodal === true,
                options: parseLuaOptions(optionsStr),
            });
            if (call.error) return JSON.stringify({ success: false, result: 'Error: ' + call.error });
            return JSON.stringify(call.result ?? { success: false, result: 'Error: empty LLM response' });
        });
        state.engine.global.set('simpleLLM', async (id, prompt) => {
            const ctx = ctxOf();
            if (!ctx.lowLevelIds.has(id)) return;
            const call = await requestClientCall(ctx, 'llm', {
                target: 'model',
                prompt: [{ role: 'user', content: typeof prompt === 'string' ? prompt : '' }],
                useMultimodal: false,
                options: {},
            });
            if (call.error) return { success: false, result: 'Error: ' + call.error };
            return call.result ?? { success: false, result: 'Error: empty LLM response' };
        });
        state.engine.global.set('axLLMMain', async (id, promptStr, useMultimodal = false, optionsStr = '') => {
            const ctx = ctxOf();
            if (!ctx.lowLevelIds.has(id)) return;
            let prompt;
            try {
                prompt = JSON.parse(promptStr);
            } catch {
                return JSON.stringify({ success: false, result: 'Error: invalid prompt' });
            }
            if (!Array.isArray(prompt)) {
                return JSON.stringify({ success: false, result: 'Error: invalid prompt' });
            }
            const call = await requestClientCall(ctx, 'llm', {
                target: 'otherAx',
                prompt,
                useMultimodal: useMultimodal === true,
                options: parseLuaOptions(optionsStr),
            });
            if (call.error) return JSON.stringify({ success: false, result: 'Error: ' + call.error });
            return JSON.stringify(call.result ?? { success: false, result: 'Error: empty LLM response' });
        });
        state.engine.global.set('getName', (id) => {
            const ctx = ctxOf();
            return ctx.char.name ?? '';
        });
        state.engine.global.set('setName', (id, name) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            if (typeof name !== 'string') throw 'Invalid data type';
            ctx.charChanges.name = name;
        });
        state.engine.global.set('getDescription', (id) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            if (ctx.char.type === 'group') throw 'Character is a group';
            return ctx.char.desc;
        });
        state.engine.global.set('setDescription', (id, desc) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            if (typeof desc !== 'string') throw 'Invalid data type';
            if (ctx.char.type === 'group') throw 'Character is a group';
            ctx.charChanges.desc = desc;
        });
        state.engine.global.set('getCharacterFirstMessage', (id) => {
            const ctx = ctxOf();
            return ctx.char.firstMessage ?? '';
        });
        state.engine.global.set('setCharacterFirstMessage', (id, data) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            if (typeof data !== 'string') return false;
            ctx.charChanges.firstMessage = data;
            return true;
        });
        state.engine.global.set('getPersonaName', (id) => {
            const ctx = ctxOf();
            return ctx.target.personaName;
        });
        state.engine.global.set('getPersonaDescription', (id) => {
            const ctx = ctxOf();
            return ctx.target.personaDescription;
        });
        state.engine.global.set('getAuthorsNote', (id) => {
            const ctx = ctxOf();
            return ctx.chat.note ?? '';
        });
        state.engine.global.set('getBackgroundEmbedding', (id) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            return ctx.char.backgroundHTML ?? '';
        });
        state.engine.global.set('setBackgroundEmbedding', (id, data) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            if (typeof data !== 'string') return false;
            ctx.charChanges.backgroundHTML = data;
            return true;
        });
        state.engine.global.set('getLoreBooksMain', (id, search) => {
            const ctx = ctxOf();
            if (ctx.char.type === 'group') return JSON.stringify([]);
            const sources = [
                ctx.chat.localLore,
                ctx.char.globalLore,
                ctx.moduleLorebooks,
            ];
            const found = [];
            for (const source of sources) {
                for (const book of source) {
                    if (book.comment === search) {
                        found.push({ ...book, content: book.contentParsed ?? book.content });
                    }
                }
            }
            return JSON.stringify(found);
        });
        state.engine.global.set('upsertLocalLoreBook', (id, name, content, options) => {
            const ctx = ctxOf();
            if (!ctx.safeIds.has(id)) return;
            if (ctx.char.type !== 'character') return;
            const opts = options && typeof options === 'object' ? options : {};
            const alwaysActive = opts.alwaysActive === true;
            const insertOrder = Number.isInteger(opts.insertOrder) ? opts.insertOrder : 100;
            const key = typeof opts.key === 'string' ? opts.key : '';
            const regex = opts.regex === true;
            const secondKey = typeof opts.secondKey === 'string' ? opts.secondKey : '';
            const next = ctx.chat.localLore.filter((book) => book.comment !== name);
            next.push({
                alwaysActive,
                comment: name,
                content: typeof content === 'string' ? content : '',
                contentParsed: typeof content === 'string' ? content : '',
                insertorder: insertOrder,
                mode: 'normal',
                key,
                secondkey: secondKey,
                selective: Boolean(secondKey),
                useRegex: regex,
            });
            ctx.chat.localLore = next;
            ctx.chatFieldsMutated = true;
        });
        state.engine.global.set('loadLoreBooksMain', async (id, reserve) => {
            const ctx = ctxOf();
            if (!ctx.lowLevelIds.has(id)) return;
            if (ctx.char.type !== 'character') return JSON.stringify([]);
            const call = await requestClientCall(ctx, 'loadLoreBooks', {
                reserve: Number.isFinite(reserve) ? Math.floor(Number(reserve)) : 0,
            });
            if (call.error) return JSON.stringify([]);
            return JSON.stringify(Array.isArray(call.result) ? call.result : []);
        });
        state.engine.global.set('getCharacterLastMessage', (id) => {
            const ctx = ctxOf();
            let pointer = ctx.chat.message.length - 1;
            while (pointer >= 0) {
                if (ctx.chat.message[pointer].role === 'char') {
                    return ctx.chat.message[pointer].data;
                }
                pointer -= 1;
            }
            return ctx.char.firstMessage ?? '';
        });
        state.engine.global.set('getUserLastMessage', (id) => {
            const ctx = ctxOf();
            let pointer = ctx.chat.message.length - 1;
            while (pointer >= 0) {
                if (ctx.chat.message[pointer].role === 'user') {
                    return ctx.chat.message[pointer].data;
                }
                pointer -= 1;
            }
            return '';
        });
    }

    function parseLuaOptions(optionsStr) {
        if (!optionsStr) return {};
        try {
            const parsed = JSON.parse(optionsStr);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            return {};
        }
    }

    async function getOrCreateEngine(mode, code) {
        let state = engines.get(mode);
        if (state && state.code === code) return state;
        if (state) {
            try {
                state.engine.global.close();
            } catch {
                // engine may already be closed
            }
        }
        state = { code, engine: null, mutex: new AsyncMutex(), ctx: null };
        engines.set(mode, state);
        if (engines.size > MAX_ENGINES) {
            for (const key of engines.keys()) {
                if (key !== mode) {
                    try {
                        engines.get(key).engine?.global.close();
                    } catch {
                        // ignore
                    }
                    engines.delete(key);
                    break;
                }
            }
        }
        const factory = await ensureLuaFactory();
        state.engine = await factory.createEngine({ injectObjects: true });
        declareApis(state);
        await state.engine.doString(luaCodeWrapper(code));
        return state;
    }

    const EDIT_MODES = ['editRequest', 'editDisplay', 'editInput', 'editOutput'];
    const MAX_BATCH_EDITS = 512;

    async function getEditListenerCounts(state) {
        try {
            const counts = state.engine.global.get('__risu_edit_listener_counts');
            if (typeof counts !== 'function') return undefined;
            return JSON.parse(String(counts()));
        } catch {
            return undefined;
        }
    }

    function buildRunResponse(ctx) {
        return {
            stopSending: ctx.stopSending === true,
            messagesMutated: ctx.messagesMutated === true,
            chatFieldsMutated: ctx.chatFieldsMutated === true,
            chat: {
                message: ctx.chat.message,
                scriptstate: ctx.chat.scriptstate,
                GLGlobalVariables: ctx.chat.GLGlobalVariables,
                localLore: ctx.chat.localLore,
                note: ctx.chat.note,
            },
            varWrites: ctx.varWrites.size > 0 ? [...ctx.varWrites.entries()] : undefined,
            charChanges: Object.keys(ctx.charChanges).length > 0 ? ctx.charChanges : undefined,
            reloadDisplay: ctx.reloadDisplay === true,
            reloadChat: ctx.reloadChatIndexes.size > 0 ? [...ctx.reloadChatIndexes] : undefined,
            errors: ctx.errors.length > 0 ? ctx.errors : undefined,
        };
    }

    async function run(rawPayload) {
        const payload = normalizeRunPayload(rawPayload);
        const state = await getOrCreateEngine(payload.mode, payload.code);
        return state.mutex.runExclusive(async () => {
            const ctx = makeRunContext(payload);
            state.ctx = ctx;
            let res;
            const mode = payload.mode;
            const luaEngine = state.engine;
            try {
                if (EDIT_MODES.includes(mode)) {
                    const func = luaEngine.global.get('callListenMain');
                    if (func) {
                        res = await func(
                            mode,
                            ctx.accessKey,
                            JSON.stringify(ctx.data),
                            JSON.stringify(ctx.meta),
                        );
                        if (typeof res === 'string') res = JSON.parse(res);
                    }
                } else {
                    // Route every direct mode through the coroutine trampoline so
                    // promise-returning host APIs can be awaited inside them.
                    const runner = luaEngine.global.get('__risu_run_mode');
                    if (runner) {
                        res = await runner(mode, ctx.accessKey, ctx.data, ctx.meta);
                    }
                }
                if (res === false) {
                    ctx.stopSending = true;
                }
            } catch (error) {
                ctx.errors.push(String(error?.message ?? error));
            } finally {
                state.ctx = null;
            }
            return {
                ok: true,
                res,
                ...buildRunResponse(ctx),
                editListeners: EDIT_MODES.includes(mode) ? await getEditListenerCounts(state) : undefined,
            };
        });
    }

    async function runEditBatch(rawPayload) {
        if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
            throw Object.assign(new TypeError('scripting edit batch payload must be an object'), { code: 'invalid_scripting_run' });
        }
        if (!Array.isArray(rawPayload.edits) || rawPayload.edits.length === 0) {
            throw Object.assign(new TypeError('scripting edit batch requires edits'), { code: 'invalid_scripting_run' });
        }
        if (rawPayload.edits.length > MAX_BATCH_EDITS) {
            throw Object.assign(new TypeError(`scripting edit batch exceeds ${MAX_BATCH_EDITS} edits`), { code: 'invalid_scripting_run' });
        }
        const payload = normalizeRunPayload(rawPayload);
        if (!EDIT_MODES.includes(payload.mode)) {
            throw Object.assign(new TypeError('scripting edit batch requires an edit mode'), { code: 'invalid_scripting_run' });
        }
        const edits = rawPayload.edits.map((edit, index) => {
            if (!edit || typeof edit !== 'object' || Array.isArray(edit) ||
                typeof edit.editId !== 'string' || edit.editId.length === 0 || edit.editId.length > 128) {
                throw Object.assign(new TypeError(`scripting edit batch entry ${index} is invalid`), { code: 'invalid_scripting_run' });
            }
            const data = edit.data === undefined ? '' : edit.data;
            if (typeof data !== 'string' && !Array.isArray(data)) {
                throw Object.assign(new TypeError(`scripting edit batch entry ${index} data is invalid`), { code: 'invalid_scripting_run' });
            }
            const meta = edit.meta && typeof edit.meta === 'object' && !Array.isArray(edit.meta) ? edit.meta : {};
            return { editId: edit.editId, data, meta };
        });
        const state = await getOrCreateEngine(payload.mode, payload.code);
        return state.mutex.runExclusive(async () => {
            const ctx = makeRunContext(payload);
            state.ctx = ctx;
            const func = state.engine.global.get('callListenMain');
            const results = [];
            if (func) {
                for (const edit of edits) {
                    let res;
                    try {
                        res = await func(
                            payload.mode,
                            ctx.accessKey,
                            JSON.stringify(edit.data),
                            JSON.stringify(edit.meta),
                        );
                        if (typeof res === 'string') res = JSON.parse(res);
                    } catch (error) {
                        ctx.errors.push(String(error?.message ?? error));
                    }
                    results.push({ editId: edit.editId, res });
                }
            }
            state.ctx = null;
            return {
                ok: true,
                edits: results,
                ...buildRunResponse(ctx),
                editListeners: await getEditListenerCounts(state),
            };
        });
    }

    function handleInvalidScriptingError(error, res, next) {
        if (error?.code === 'invalid_scripting_run' || error instanceof TypeError || error instanceof RangeError) {
            res.status(400).send({ error: error.message });
            return true;
        }
        next(error);
        return false;
    }

    function registerRoutes(app, { auth, limiter } = {}) {
        const guards = limiter ? [limiter] : [];
        app.post('/api/scripting/run', ...guards, async (req, res, next) => {
            if (auth && !await auth(req, res)) return;
            try {
                res.send(await run(req.body));
            } catch (error) {
                handleInvalidScriptingError(error, res, next);
            }
        });
        app.post('/api/scripting/edit-batch', ...guards, async (req, res, next) => {
            if (auth && !await auth(req, res)) return;
            try {
                res.send(await runEditBatch(req.body));
            } catch (error) {
                handleInvalidScriptingError(error, res, next);
            }
        });
        app.post('/api/scripting/call-response', ...guards, async (req, res, next) => {
            if (auth && !await auth(req, res)) return;
            const body = req.body;
            if (!body || typeof body !== 'object' ||
                typeof body.runId !== 'string' || body.runId.length === 0 || body.runId.length > 128 ||
                typeof body.callId !== 'string' || body.callId.length === 0 || body.callId.length > 128) {
                res.status(400).send({ error: 'invalid scripting call response' });
                return;
            }
            try {
                const handled = resolvePendingCall(body.runId, body.callId, body);
                res.send({ handled });
            } catch (error) {
                next(error);
            }
        });
    }

    function closeAll() {
        for (const state of engines.values()) {
            try {
                state.engine?.global.close();
            } catch {
                // ignore
            }
        }
        engines.clear();
        for (const calls of pendingCalls.values()) {
            for (const entry of calls.values()) clearTimeout(entry.timer);
        }
        pendingCalls.clear();
    }

    return {
        run,
        runEditBatch,
        registerRoutes,
        resolvePendingCall,
        closeAll,
    };
}

module.exports = {
    createNodeScriptingExecutor,
    luaCodeWrapper,
    parseKeyValue,
    normalizeRunPayload,
};
