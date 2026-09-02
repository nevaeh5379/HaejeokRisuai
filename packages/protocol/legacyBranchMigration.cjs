'use strict';

function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function messageSignature(message) {
    const cloned = { ...(message || {}) };
    delete cloned.chatId;
    return JSON.stringify(cloned, (_key, value) => value === undefined ? '__RISU_UNDEFINED__' : value);
}

function materializeLegacyTimeline(chat, branch) {
    const state = chat.branchState;
    if (!state || branch.id === state.activeBranchId) return cloneValue(chat.message || []);
    const base = Number.isInteger(state.baseMessageIndex) ? state.baseMessageIndex : -1;
    const prefix = (chat.message || []).slice(0, Math.max(0, base + 1));
    return [...cloneValue(prefix), ...cloneValue(branch.messages || [])];
}

function orderLegacyBranches(branches) {
    const byId = new Map(branches.map((branch) => [branch.id, branch]));
    const ordered = [];
    const visiting = new Set();
    const visited = new Set();
    const sorted = [...branches].sort((left, right) => {
        if (left.reason === 'root' && right.reason !== 'root') return -1;
        if (right.reason === 'root' && left.reason !== 'root') return 1;
        return Number(left.createdAt || 0) - Number(right.createdAt || 0);
    });
    const visit = (branch) => {
        if (!branch || visited.has(branch.id)) return;
        if (visiting.has(branch.id)) return;
        visiting.add(branch.id);
        if (branch.parentBranchId && byId.has(branch.parentBranchId)) visit(byId.get(branch.parentBranchId));
        visiting.delete(branch.id);
        visited.add(branch.id);
        ordered.push(branch);
    };
    sorted.forEach(visit);
    return ordered;
}

function buildLegacyBranchMigrationPlan(chat, idFactory) {
    const state = chat?.branchState;
    const sourceBranches = Array.isArray(state?.branches) ? state.branches.filter((branch) => branch?.id) : [];
    if (!chat?.id || sourceBranches.length <= 1) return null;
    if (typeof idFactory !== 'function') throw new TypeError('idFactory is required');

    const ordered = orderLegacyBranches(sourceBranches);
    const branchIds = new Set(ordered.map((branch) => branch.id));
    const root = ordered.find((branch) => branch.reason === 'root')
        || ordered.find((branch) => !branch.parentBranchId || !branchIds.has(branch.parentBranchId))
        || ordered[0];
    const paths = new Map();
    const nodeVariants = new Map();
    const usedIds = new Set();
    const messages = new Map();
    const links = new Map();

    const resolveNode = (branchId, message, parentMessageId, position) => {
        const rawId = typeof message?.chatId === 'string' && message.chatId ? message.chatId : null;
        const signature = messageSignature(message);
        const variantKey = `${rawId || '__NO_ID__'}\u0000${parentMessageId || '__ROOT__'}\u0000${signature}`;
        let resolvedId = nodeVariants.get(variantKey);
        if (!resolvedId) {
            if (rawId && !usedIds.has(rawId)) resolvedId = rawId;
            else {
                do { resolvedId = idFactory(); } while (!resolvedId || usedIds.has(resolvedId));
            }
            usedIds.add(resolvedId);
            nodeVariants.set(variantKey, resolvedId);
            const stored = cloneValue(message || {});
            stored.chatId = resolvedId;
            messages.set(resolvedId, { id: resolvedId, position, data: stored });
            links.set(resolvedId, {
                messageId: resolvedId,
                parentMessageId: parentMessageId || undefined,
                originBranchId: branchId,
            });
        }
        return resolvedId;
    };

    for (const branch of ordered) {
        const timeline = materializeLegacyTimeline(chat, branch);
        const path = [];
        let parentMessageId;
        for (let position = 0; position < timeline.length; position++) {
            const resolvedId = resolveNode(branch.id, timeline[position], parentMessageId, position);
            path.push(resolvedId);
            parentMessageId = resolvedId;
        }
        paths.set(branch.id, path);
    }

    const rows = ordered.map((branch) => {
        let parentBranchId = branch.parentBranchId && branchIds.has(branch.parentBranchId)
            ? branch.parentBranchId
            : undefined;
        if (branch.id === root.id) parentBranchId = undefined;
        else if (!parentBranchId) parentBranchId = root.id;
        const path = paths.get(branch.id) || [];
        const parentPath = parentBranchId ? (paths.get(parentBranchId) || []) : [];
        let common = 0;
        while (common < path.length && common < parentPath.length && path[common] === parentPath[common]) common++;
        const forkMessageId = common > 0 ? path[common - 1] : undefined;
        return {
            id: branch.id,
            parentBranchId,
            forkMessageId,
            headMessageId: path.at(-1),
            reason: branch.id === root.id ? 'root' : (branch.reason === 'reroll' ? 'reroll' : 'manual'),
            createdAt: Number(branch.createdAt || 0),
            runtimeState: {
                ...(Object.prototype.hasOwnProperty.call(branch, 'scriptstate') ? { scriptstate: cloneValue(branch.scriptstate) } : {}),
                ...(Object.prototype.hasOwnProperty.call(branch, 'GLGlobalVariables') ? { GLGlobalVariables: cloneValue(branch.GLGlobalVariables) } : {}),
                ...(Object.prototype.hasOwnProperty.call(branch, 'useLocallySetGlobalVariables') ? { useLocallySetGlobalVariables: branch.useLocallySetGlobalVariables } : {}),
            },
        };
    });

    const activeBranchId = branchIds.has(state.activeBranchId) ? state.activeBranchId : root.id;
    return {
        chatId: chat.id,
        activeBranchId,
        branches: rows,
        messages: [...messages.values()],
        links: [...links.values()],
    };
}

module.exports = { buildLegacyBranchMigrationPlan, materializeLegacyTimeline };
