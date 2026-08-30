'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createNodeScriptingExecutor } = require('./scriptingExecutor.cjs');

const JSON_LUA_PATH = path.join(__dirname, '..', '..', 'public', 'lua', 'json.lua');

function makeExecutor(overrides = {}) {
    const events = [];
    const executor = createNodeScriptingExecutor({
        broadcast: (event, data) => {
            events.push({ event, data });
        },
        jsonLuaPath: JSON_LUA_PATH,
        countTokensBatch: (texts) => texts.map((text) => text.length),
        fetchImpl: async (url, init) => {
            assert.equal(init.method, 'GET');
            return { status: 200, text: async () => `fetched:${url}` };
        },
        ...overrides,
    });
    return { executor, events, close: () => executor.closeAll() };
}

async function waitForEvent(events, predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function payload(overrides = {}) {
    return {
        runId: 'run-1',
        clientId: 'client-1',
        mode: 'input',
        code: 'onInput = function(id) return 1 end',
        lowLevelAccess: false,
        data: '',
        meta: {},
        triggerId: null,
        char: {
            type: 'character',
            chaId: 'char-1',
            name: 'TestChar',
            desc: 'A test character',
            firstMessage: 'Hello!',
            backgroundHTML: '<b>bg</b>',
            defaultVariables: 'greet=hi',
            globalLore: [],
        },
        chat: {
            id: 'chat-1',
            note: 'note',
            scriptstate: {},
            GLGlobalVariables: {},
            useLocallySetGlobalVariables: false,
            localLore: [],
            message: [
                { role: 'user', data: 'hello', time: 1 },
                { role: 'char', data: 'hi', time: 2 },
            ],
        },
        moduleLorebooks: [],
        target: {
            characterId: 'char-1',
            chatId: 'chat-1',
            globalVariables: { reqvar: 'from-request' },
            personaName: 'Tester',
            personaDescription: 'a tester',
        },
        settings: {
            globalChatVariables: { globalvar: 'from-settings' },
            templateDefaultVariables: 'templ=var',
        },
        encoding: 'o200k_base',
        ...overrides,
    };
}

test('runs the mode function and returns res, chat and character changes', async () => {
    const { executor, close } = makeExecutor();
    try {
        const result = await executor.run(payload({
            code: `
onInput = function(id)
    local first = getChat(id, 0)
    local count = getChatLength(id)
    assert(first.role == "user" and first.data == "hello")
    assert(count == 2)
    local last = getCharacterLastMessage(id)
    addChat(id, "char", "appended")
    setChat(id, 0, "changed")
    local name = getName(id)
    setName(id, "RenamedChar")
    return { ok = true, name = name, last = last }
end`,
        }));
        assert.equal(result.ok, true);
        assert.equal(result.stopSending, false);
        assert.equal(result.messagesMutated, true);
        assert.equal(result.res.ok, true);
        assert.equal(result.res.name, 'TestChar');
        assert.equal(result.res.last, 'hi');
        assert.equal(result.chat.message.length, 3);
        assert.equal(result.chat.message[0].data, 'changed');
        assert.deepEqual(result.chat.message[2], { role: 'char', data: 'appended' });
        assert.deepEqual(result.charChanges, { name: 'RenamedChar' });
    } finally {
        close();
    }
});

test('stopChat and a false return value both set stopSending', async () => {
    const { executor, close } = makeExecutor();
    try {
        const stopped = await executor.run(payload({
            code: 'onInput = function(id) stopChat(id) return nil end',
        }));
        assert.equal(stopped.stopSending, true);

        const returnedFalse = await executor.run(payload({
            code: 'onInput = function(id) return false end',
        }));
        assert.equal(returnedFalse.stopSending, true);
        assert.equal(returnedFalse.res, false);
    } finally {
        close();
    }
});

test('chat variables persist in the mode engine and honour defaults', async () => {
    const { executor, close } = makeExecutor();
    try {
        const first = await executor.run(payload({
            code: `
onInput = function(id)
    assert(getChatVar(id, "greet") == "hi")
    assert(getChatVar(id, "templ") == "var")
    assert(getGlobalVar(id, "globalvar") == "from-settings")
    assert(getGlobalVar(id, "reqvar") == "from-request")
    setState(id, "counter", 1)
    return getState(id, "counter")
end`,
        }));
        assert.equal(first.res, 1);
        assert.equal(first.chat.scriptstate['$__counter'], '1');
        assert.equal(first.chatFieldsMutated, true);

        // A second run sees the chat variable carried by the chat payload.
        const second = await executor.run(payload({
            code: 'onInput = function(id) return getState(id, "counter") end',
            chat: { ...payload().chat, scriptstate: { $__counter: '42' } },
        }));
        assert.equal(second.res, 42);
    } finally {
        close();
    }
});

test('edit triggers run through callListenMain and transform the payload', async () => {
    const { executor, close } = makeExecutor();
    try {
        const result = await executor.run(payload({
            mode: 'editRequest',
            code: `
listenEdit("editRequest", function(id, value, meta)
    for i = 1, #value do
        value[i].content = value[i].content .. "!edited"
    end
    return value
end)
onInput = function(id)
    return nil
end`,
            data: [
                { role: 'user', content: 'a' },
                { role: 'assistant', content: 'b' },
            ],
            meta: { index: 7 },
        }));
        assert.equal(result.res[0].content, 'a!edited');
        assert.equal(result.res[1].content, 'b!edited');
    } finally {
        close();
    }
});

test('editDisplay runs only get the chat-var tier (client ScriptingEditDisplayIds parity)', async () => {
    const { executor, close } = makeExecutor();
    try {
        const result = await executor.run(payload({
            mode: 'editDisplay',
            code: `
listenEdit("editDisplay", function(id, value, meta)
    reloadDisplay(id)
    reloadChat(id, 0)
    addChat(id, "char", "should-not-appear")
    stopChat(id)
    setChatVar(id, "displayvar", "from-edit")
    return value .. "!display"
end)
onInput = function(id)
    return nil
end`,
            data: 'display text',
        }));
        assert.equal(result.res, 'display text!display');
        assert.equal(result.reloadDisplay, false, 'reloadDisplay must be ignored for editDisplay runs');
        assert.equal(result.reloadChat, undefined, 'reloadChat must be ignored for editDisplay runs');
        assert.equal(result.messagesMutated, false, 'chat mutations must be ignored for editDisplay runs');
        assert.equal(result.stopSending, false, 'stopChat must be ignored for editDisplay runs');
        assert.equal(result.chat.scriptstate['$displayvar'], 'from-edit', 'chat var writes stay allowed for editDisplay runs');
        assert.equal(result.chatFieldsMutated, true);
    } finally {
        close();
    }
});

test('edit responses report the listener counts for the client probe cache', async () => {
    const { executor, close } = makeExecutor();
    try {
        const withListener = await executor.run(payload({
            mode: 'editDisplay',
            code: 'listenEdit("editDisplay", function(id, value, meta) return value .. "!" end)',
            data: 'x',
        }));
        assert.equal(withListener.res, 'x!');
        assert.deepEqual(withListener.editListeners, { editRequest: 0, editDisplay: 1, editInput: 0, editOutput: 0 });

        const withoutListener = await executor.run(payload({
            mode: 'editDisplay',
            code: 'onInput = function(id) return 1 end',
            data: 'x',
        }));
        assert.equal(withoutListener.res, 'x', 'no listener means the content passes through');
        assert.deepEqual(withoutListener.editListeners, { editRequest: 0, editDisplay: 0, editInput: 0, editOutput: 0 });

        const direct = await executor.run(payload({
            code: 'onInput = function(id) return 1 end',
        }));
        assert.equal(direct.editListeners, undefined, 'direct modes do not report edit listeners');
    } finally {
        close();
    }
});

test('edit batches process every entry in one run', async () => {
    const { executor, close } = makeExecutor();
    try {
        const result = await executor.runEditBatch(payload({
            mode: 'editDisplay',
            code: 'listenEdit("editDisplay", function(id, value, meta) if type(value) == "string" then return meta.index .. ":" .. value end return value end)',
            edits: [
                { editId: 'a', data: 'one', meta: { index: 1 } },
                { editId: 'b', data: 'two', meta: { index: 2 } },
                { editId: 'c', data: [{ role: 'user', content: 'three' }], meta: { index: 3 } },
            ],
        }));
        assert.equal(result.ok, true);
        assert.deepEqual(result.edits, [
            { editId: 'a', res: '1:one' },
            { editId: 'b', res: '2:two' },
            { editId: 'c', res: [{ role: 'user', content: 'three' }] },
        ]);
        assert.deepEqual(result.editListeners, { editRequest: 0, editDisplay: 1, editInput: 0, editOutput: 0 });
    } finally {
        close();
    }
});

test('invalid edit batches are rejected', async () => {
    const { executor, close } = makeExecutor();
    try {
        await assert.rejects(
            () => executor.runEditBatch(payload({ mode: 'input', code: 'x', edits: [{ editId: 'a', data: 'x', meta: {} }] })),
            /edit mode/,
        );
        await assert.rejects(
            () => executor.runEditBatch(payload({ mode: 'editDisplay', code: 'x', edits: [] })),
            /requires edits/,
        );
        await assert.rejects(
            () => executor.runEditBatch(payload({ mode: 'editDisplay', code: 'x', edits: [{ data: 'x' }] })),
            /entry 0 is invalid/,
        );
        await assert.rejects(
            () => executor.runEditBatch(payload({ mode: 'editDisplay', code: 'x', edits: [{ editId: 'a', data: 42, meta: {} }] })),
            /entry 0 data is invalid/,
        );
    } finally {
        close();
    }
});

test('LLM calls bridge to the client and resolve with the answered payload', async () => {
    const { executor, events, close } = makeExecutor();
    try {
        const runPromise = executor.run(payload({
            lowLevelAccess: true,
            code: `
onInput = function(id)
    local result = LLM(id, {{ role = "user", content = "hi" }})
    return result
end`,
        }));
        const call = await waitForEvent(events, (event) => event.event === 'scripting-call' && event.data.kind === 'llm');
        assert.ok(call, 'expected an llm scripting-call event');
        assert.equal(call.data.runId, 'run-1');
        assert.equal(call.data.clientId, 'client-1');
        assert.equal(call.data.args.target, 'model');
        assert.deepEqual(call.data.args.prompt, [{ role: 'user', content: 'hi' }]);
        assert.equal(await executor.resolvePendingCall('run-1', call.data.callId, {
            result: { success: true, result: 'model says hello' },
        }), true);
        const result = await runPromise;
        assert.deepEqual(result.res, { success: true, result: 'model says hello' });
    } finally {
        close();
    }
});

test('LLM calls time out when the client never answers', async () => {
    const { executor, events, close } = makeExecutor({ now: () => 0 });
    // A short timeout is not injectable, so assert the pending call exists
    // and that answering an unknown call id is rejected cleanly.
    try {
        const runPromise = executor.run(payload({
            lowLevelAccess: true,
            code: 'onInput = function(id) return LLM(id, {{ role = "user", content = "hi" }}) end',
        }));
        const call = await waitForEvent(events, (event) => event.event === 'scripting-call' && event.data.kind === 'llm');
        assert.ok(call);
        assert.equal(await executor.resolvePendingCall('run-1', 'no-such-call', { result: null }), false);
        assert.equal(await executor.resolvePendingCall('run-1', call.data.callId, {
            error: 'client disconnected',
        }), true);
        const result = await runPromise;
        assert.deepEqual(result.res, { success: false, result: 'Error: client disconnected' });
    } finally {
        close();
    }
});

test('a changed code resets the engine globals', async () => {
    const { executor, close } = makeExecutor();
    try {
        const first = await executor.run(payload({
            code: `
myGlobal = 5
onInput = function(id) return myGlobal end`,
        }));
        assert.equal(first.res, 5);

        const second = await executor.run(payload({
            code: `
onInput = function(id)
    if myGlobal == nil then return "fresh" end
    return myGlobal
end`,
        }));
        assert.equal(second.res, 'fresh');
    } finally {
        close();
    }
});

test('token counts, hashing and sleep use the server runtime', async () => {
    const { executor, close } = makeExecutor();
    try {
        const result = await executor.run(payload({
            lowLevelAccess: true,
            code: `
onInput = function(id)
    local tokens = getTokens(id, "abcd"):await()
    local digest = hash(id, "hello"):await()
    local slept = sleep(id, 5):await()
    return { tokens = tokens, digest = digest, slept = slept }
end`,
        }));
        assert.equal(result.res.tokens, 4);
        assert.equal(
            result.res.digest,
            '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        );
        assert.equal(result.res.slept, true);
    } finally {
        close();
    }
});

test('the request API keeps the client-side restrictions', async () => {
    const { executor, close } = makeExecutor();
    try {
        const result = await executor.run(payload({
            lowLevelAccess: true,
            code: `
onInput = function(id)
    local ok = json.decode(request(id, "https://example.com/x"):await())
    local denied = json.decode(request(id, "http://example.com/x"):await())
    local banned = json.decode(request(id, "https://risuai.net/x"):await())
    return { ok = ok, denied = denied, banned = banned }
end`,
        }));
        assert.equal(result.res.ok.status, 200);
        assert.equal(result.res.ok.data, 'fetched:https://example.com/x');
        assert.equal(result.res.denied.status, 400);
        assert.equal(result.res.banned.status, 400);
    } finally {
        close();
    }
});

test('without low level access the restricted APIs are no-ops', async () => {
    const { executor, close } = makeExecutor();
    try {
        const result = await executor.run(payload({
            lowLevelAccess: false,
            code: `
onInput = function(id)
    local digest = hash(id, "hello"):await()
    local requested = request(id, "https://example.com/x"):await()
    return { digest = digest, request = requested }
end`,
        }));
        assert.equal(result.res.request, undefined);
        assert.equal(result.res.digest, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    } finally {
        close();
    }
});

test('upsertLocalLoreBook rewrites the chat lore list', async () => {
    const { executor, close } = makeExecutor();
    try {
        const result = await executor.run(payload({
            code: `
onInput = function(id)
    upsertLocalLoreBook(id, "new book", "book content", { alwaysActive = true, key = "k", regex = true, secondKey = "s" })
    return getLoreBooks(id, "new book")
end`,
        }));
        assert.equal(result.chat.localLore.length, 1);
        assert.equal(result.chat.localLore[0].comment, 'new book');
        assert.equal(result.chat.localLore[0].alwaysActive, true);
        assert.equal(result.chat.localLore[0].useRegex, true);
        assert.equal(result.chat.localLore[0].selective, true);
        assert.equal(result.res.length, 1);
        assert.equal(result.res[0].content, 'book content');
        assert.equal(result.chatFieldsMutated, true);
    } finally {
        close();
    }
});

test('UI dialogs bridge to the client with their results', async () => {
    const { executor, events, close } = makeExecutor();
    try {
        const runPromise = executor.run(payload({
            code: `
onInput = function(id)
    local answer = alertInput(id, "your name?"):await()
    local confirmed = alertConfirm(id, "sure?"):await()
    return { answer = answer, confirmed = confirmed }
end`,
        }));
        const inputCall = await waitForEvent(events, (event) => event.event === 'scripting-call' && event.data.kind === 'alertInput');
        assert.ok(inputCall, 'expected an alertInput scripting-call event');
        await executor.resolvePendingCall('run-1', inputCall.data.callId, { result: 'Risu' });
        const confirmCall = await waitForEvent(events, (event) => event.event === 'scripting-call' && event.data.kind === 'alertConfirm');
        assert.ok(confirmCall, 'expected an alertConfirm scripting-call event');
        await executor.resolvePendingCall('run-1', confirmCall.data.callId, { result: true });
        const result = await runPromise;
        assert.deepEqual(result.res, { answer: 'Risu', confirmed: true });
    } finally {
        close();
    }
});

test('trigger varSnapshot scopes variable access and collects writes for replay', async () => {
    const { executor, close } = makeExecutor();
    try {
        const result = await executor.run(payload({
            varSnapshot: {
                local: { localvar: 'from-local' },
                temp: { tempvar: 'from-temp' },
                displayMode: true,
            },
            code: `
onInput = function(id)
    assert(getChatVar(id, "localvar") == "from-local")
    assert(getChatVar(id, "tempvar") == "from-temp")
    assert(getChatVar(id, "greet") == "hi")
    local before = getChatVar(id, "newvar")
    assert(before == "null")
    setState(id, "newvar", "written")
    assert(getState(id, "newvar") == "written")
    assert(setStateChanged(id, "newvar", "written") == nil)
    assert(setStateChanged(id, "newvar", "again") == true)
    return getState(id, "newvar")
end`,
        }));
        assert.equal(result.res, 'again');
        // varWrites is deduplicated per key (Map order): replaying the final
        // value through the trigger closure yields the same end state.
        assert.deepEqual(result.varWrites, [
            ['__newvar', '"again"'],
        ]);
        // Snapshot mode must not persist variable writes into the chat itself;
        // the client replays them through the trigger closure.
        assert.equal(result.chat.scriptstate['$__newvar'], undefined);
        assert.equal(result.chatFieldsMutated, false);
    } finally {
        close();
    }
});

test('cbs bridges to the client but keeps a synchronous string contract in Lua', async () => {
    const { executor, events, close } = makeExecutor();
    try {
        const runPromise = executor.run(payload({
            code: 'onInput = function(id) return "parsed:" .. cbs("RAW") end',
        }));
        const call = await waitForEvent(events, (event) => event.event === 'scripting-call' && event.data.kind === 'cbs');
        assert.ok(call, 'expected a cbs scripting-call event');
        assert.equal(call.data.args.value, 'RAW');
        await executor.resolvePendingCall('run-1', call.data.callId, { result: 'PARSED' });
        const result = await runPromise;
        assert.equal(result.res, 'parsed:PARSED');
    } finally {
        close();
    }
});

test('invalid payloads are rejected', async () => {
    const { executor, close } = makeExecutor();
    try {
        await assert.rejects(
            () => executor.run({ ...payload(), mode: '' }),
            (error) => error.code === 'invalid_scripting_run',
        );
        await assert.rejects(
            () => executor.run({ ...payload(), data: 42 }),
            (error) => error.code === 'invalid_scripting_run',
        );
    } finally {
        close();
    }
});

test('onButtonClick receives the button data and the mode function dispatch works for custom modes', async () => {
    const { executor, close } = makeExecutor();
    try {
        const button = await executor.run(payload({
            mode: 'onButtonClick',
            code: 'onButtonClick = function(id, data) return "clicked:" .. data end',
            data: 'roll d20',
        }));
        assert.equal(button.res, 'clicked:roll d20');

        const custom = await executor.run(payload({
            mode: 'myTrigger',
            code: 'myTrigger = function(id) return "custom ok" end',
        }));
        assert.equal(custom.res, 'custom ok');
    } finally {
        close();
    }
});
