'use strict';

function normalizeClientId(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= 128 ? trimmed : null;
}

function describeSqlCommitChange(payload) {
    const chatIds = new Set();
    const characterIds = new Set();
    const addChat = (id) => { if (typeof id === 'string' && id) chatIds.add(id); };
    const addCharacter = (id) => { if (typeof id === 'string' && id) characterIds.add(id); };

    for (const row of payload?.messages ?? []) addChat(row?.chatId);
    for (const row of payload?.messageManifests ?? []) addChat(row?.chatId);
    for (const row of payload?.messageDeletes ?? []) addChat(row?.chatId);
    for (const row of payload?.chats ?? []) {
        addChat(row?.id);
        addCharacter(row?.characterId);
    }
    for (const row of payload?.characters ?? []) addCharacter(row?.id);
    for (const row of payload?.chatManifests ?? []) addCharacter(row?.characterId);

    return {
        chatIds: [...chatIds],
        characterIds: [...characterIds],
        rootChanged: Boolean(payload?.replaceAll || payload?.root?.upserts?.length || payload?.root?.deletes?.length),
    };
}

function createRealtimeEventHub({ heartbeatMs = 15_000 } = {}) {
    const clients = new Set();
    let sequence = 0;

    function writeEvent(res, event, data) {
        const id = ++sequence;
        res.write(`id: ${id}\n`);
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify({ ...data, eventId: id })}\n\n`);
    }

    function broadcast(event, data) {
        for (const client of [...clients]) {
            if (client.res.destroyed || client.res.writableEnded) {
                clients.delete(client);
                continue;
            }
            try {
                writeEvent(client.res, event, data);
            } catch {
                clients.delete(client);
            }
        }
    }

    function connect(req, res) {
        res.status(200);
        res.set('content-type', 'text/event-stream; charset=utf-8');
        res.set('cache-control', 'no-cache, no-transform');
        res.set('connection', 'keep-alive');
        res.set('x-accel-buffering', 'no');
        res.flushHeaders();
        const client = {
            res,
            clientId: normalizeClientId(req.headers['x-risu-client-id']),
        };
        clients.add(client);
        writeEvent(res, 'ready', { clientId: client.clientId, connectedAt: Date.now() });

        const heartbeat = setInterval(() => {
            if (res.destroyed || res.writableEnded) return;
            res.write(`: heartbeat ${Date.now()}\n\n`);
        }, heartbeatMs);
        heartbeat.unref?.();

        const close = () => {
            clearInterval(heartbeat);
            clients.delete(client);
        };
        req.once('close', close);
        res.once('close', close);
    }

    return {
        connect,
        broadcast,
        clientCount: () => clients.size,
    };
}

module.exports = {
    createRealtimeEventHub,
    describeSqlCommitChange,
    normalizeClientId,
};
