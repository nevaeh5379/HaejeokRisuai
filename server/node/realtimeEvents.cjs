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

function createRealtimeEventHub({ heartbeatMs = 15_000, historyLimit = 512 } = {}) {
    const clients = new Set();
    const history = [];
    let sequence = 0;

    function writeEvent(res, record) {
        if (record.id != null) res.write(`id: ${record.id}\n`);
        res.write(`event: ${record.event}\n`);
        res.write(`data: ${JSON.stringify(record.data)}\n\n`);
    }

    function makeBroadcastEvent(event, data) {
        const id = ++sequence;
        return { id, event, data: { ...data, eventId: id } };
    }

    function broadcast(event, data) {
        const record = makeBroadcastEvent(event, data);
        history.push(record);
        if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
        for (const client of [...clients]) {
            if (client.res.destroyed || client.res.writableEnded) {
                clients.delete(client);
                continue;
            }
            try {
                writeEvent(client.res, record);
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
        const rawLastEventId = req.headers['last-event-id'];
        const lastEventId = Number(Array.isArray(rawLastEventId) ? rawLastEventId[0] : rawLastEventId);
        const hasLastEventId = Number.isSafeInteger(lastEventId) && lastEventId >= 0;
        const oldestRetainedId = history[0]?.id ?? sequence + 1;
        const replayGap = hasLastEventId && (
            lastEventId > sequence ||
            (lastEventId < sequence && lastEventId < oldestRetainedId - 1)
        );

        if (replayGap) {
            writeEvent(res, {
                event: 'resync-required',
                data: { latestEventId: sequence, oldestRetainedId },
            });
        } else if (hasLastEventId) {
            for (const record of history) {
                if (record.id > lastEventId) writeEvent(res, record);
            }
        }

        clients.add(client);
        writeEvent(res, {
            event: 'ready',
            data: { clientId: client.clientId, connectedAt: Date.now(), latestEventId: sequence },
        });

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
        latestEventId: () => sequence,
    };
}

module.exports = {
    createRealtimeEventHub,
    describeSqlCommitChange,
    normalizeClientId,
};
