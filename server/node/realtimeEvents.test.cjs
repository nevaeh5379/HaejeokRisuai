'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const {
    createRealtimeEventHub,
    describeSqlCommitChange,
} = require('./realtimeEvents.cjs');

test('describeSqlCommitChange extracts affected chat and character ids', () => {
    const change = describeSqlCommitChange({
        action: 'message',
        root: { upserts: [], deletes: [] },
        characters: [{ id: 'char-a' }],
        chats: [{ id: 'chat-a', characterId: 'char-a' }],
        messages: [
            { id: 'msg-a', chatId: 'chat-a' },
            { id: 'msg-b', chatId: 'chat-b' },
        ],
        messageManifests: [{ chatId: 'chat-b', ids: ['msg-b'] }],
    });

    assert.deepEqual(change.chatIds.sort(), ['chat-a', 'chat-b']);
    assert.deepEqual(change.characterIds, ['char-a']);
    assert.equal(change.rootChanged, false);
});

class FakeResponse extends EventEmitter {
    constructor() {
        super();
        this.chunks = [];
        this.destroyed = false;
        this.writableEnded = false;
    }
    status() { return this; }
    set() { return this; }
    flushHeaders() {}
    write(chunk) {
        this.chunks.push(String(chunk));
        return true;
    }
}

test('realtime hub streams ready and broadcast events to connected clients', () => {
    const hub = createRealtimeEventHub({ heartbeatMs: 60_000 });
    const req = new EventEmitter();
    req.headers = { 'x-risu-client-id': 'device-a' };
    const res = new FakeResponse();

    hub.connect(req, res);
    hub.broadcast('database-change', { revision: 7, chatIds: ['chat-a'] });
    const output = res.chunks.join('');
    assert.match(output, /event: ready/);
    assert.match(output, /event: database-change/);
    assert.match(output, /"revision":7/);
    assert.match(output, /"chatIds":\["chat-a"\]/);
    assert.equal(hub.clientCount(), 1);
    req.emit('close');
    assert.equal(hub.clientCount(), 0);
});
