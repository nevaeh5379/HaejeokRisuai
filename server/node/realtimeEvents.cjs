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

    const rootUpsertKeys = (payload?.root?.upserts ?? [])
        .map((entry) => entry?.key)
        .filter((key) => typeof key === 'string' && key);
    const rootDeleteKeys = (payload?.root?.deletes ?? [])
        .filter((key) => typeof key === 'string' && key);
    const pluginStorageUpsertKeys = (payload?.pluginStorage?.upserts ?? [])
        .map((entry) => entry?.key)
        .filter((key) => typeof key === 'string' && key);
    const pluginStorageDeleteKeys = (payload?.pluginStorage?.deletes ?? [])
        .filter((key) => typeof key === 'string' && key);

    return {
        chatIds: [...chatIds],
        characterIds: [...characterIds],
        rootUpsertKeys: [...new Set(rootUpsertKeys)],
        rootDeleteKeys: [...new Set(rootDeleteKeys)],
        rootChanged: Boolean(payload?.replaceAll || rootUpsertKeys.length || rootDeleteKeys.length),
        pluginStorageUpsertKeys: [...new Set(pluginStorageUpsertKeys)],
        pluginStorageDeleteKeys: [...new Set(pluginStorageDeleteKeys)],
        pluginStorageCleared: payload?.pluginStorage?.clear === true,
    };
}

function createRealtimeEventHub({ heartbeatMs = 15_000, historyLimit = 512, generationMaxAgeMs = 60 * 60 * 1000 } = {}) {
    const clients = new Set();
    const history = [];
    const activeGenerations = new Map();
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

    function pruneGenerationStates() {
        const cutoff = Date.now() - generationMaxAgeMs;
        for (const [chatId, state] of activeGenerations) {
            if ((state.updatedAt ?? 0) < cutoff) activeGenerations.delete(chatId);
        }
    }

    function updateGenerationState(input, sourceClientId) {
        const chatId = typeof input?.chatId === 'string' ? input.chatId.trim() : '';
        const lifecycleId = typeof input?.lifecycleId === 'string' ? input.lifecycleId.trim() : '';
        const state = input?.state;
        if (!chatId || chatId.length > 256 || !lifecycleId || lifecycleId.length > 128 ||
            !['started', 'finished', 'failed', 'aborted'].includes(state)) return null;
        pruneGenerationStates();
        const record = {
            chatId,
            lifecycleId,
            state,
            sourceClientId: normalizeClientId(sourceClientId),
            error: state === 'failed' && typeof input?.error === 'string' ? input.error.slice(0, 8000) : undefined,
            updatedAt: Date.now(),
        };
        if (state === 'started') {
            activeGenerations.set(chatId, record);
        } else if (activeGenerations.get(chatId)?.lifecycleId === lifecycleId) {
            activeGenerations.delete(chatId);
        }
        broadcast('generation-state', record);
        return record;
    }

    function listActiveGenerations() {
        pruneGenerationStates();
        return [...activeGenerations.values()];
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
            data: {
                clientId: client.clientId,
                connectedAt: Date.now(),
                latestEventId: sequence,
                activeGenerations: listActiveGenerations(),
            },
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
        updateGenerationState,
        listActiveGenerations,
        clientCount: () => clients.size,
        latestEventId: () => sequence,
    };
}

module.exports = {
    createRealtimeEventHub,
    describeSqlCommitChange,
    normalizeClientId,
};
