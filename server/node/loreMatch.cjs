function normalizeKeys(keys) {
    if (!Array.isArray(keys)) return [];
    return keys
        .map((key) => String(key ?? '').trim())
        .filter((key) => key.length > 0);
}

function buildMessageList(messages, request, username, charName) {
    const depth = Math.max(0, Math.floor(Number(request.searchDepth) || 0));
    const sliced = messages.slice(messages.length - depth, messages.length);
    return sliced.map((msg, index) => {
        const isUser = msg?.role === 'user';
        const displayName = isUser ? username : (msg?.displayName || charName);
        return {
            source: `message ${index} by ${isUser ? 'user' : 'char'}`,
            prompt: `\x01{{${displayName}}}:${String(msg?.data ?? '')}\x01`,
            data: String(msg?.data ?? ''),
        };
    });
}

function matchLoreRequest(messages, rawRequest, options = {}) {
    const request = { ...rawRequest, keys: normalizeKeys(rawRequest?.keys) };
    const logs = [];
    let messageList = buildMessageList(
        messages,
        request,
        String(options.username ?? ''),
        String(options.charName ?? ''),
    );
    if (request.regex) {
        for (const message of messageList) {
            for (const regexString of request.keys) {
                if (!regexString.startsWith('/')) return { matched: false, logs };
                const regexFlag = regexString.split('/').pop();
                if (!regexFlag) continue;
                request.keys[0] = regexString.replace('/' + regexFlag, '');
                try {
                    const regex = new RegExp(request.keys[0], regexFlag);
                    if (regex.test(message.data)) {
                        logs.push({
                            prompt: message.prompt,
                            source: message.source,
                            activated: regexString,
                        });
                        return { matched: true, logs };
                    }
                } catch {
                    return { matched: false, logs };
                }
            }
        }
        return { matched: false, logs };
    }

    messageList = messageList.map((message) => ({
        source: message.source,
        prompt: message.prompt.toLocaleLowerCase()
            .replace(/\{\{\/\/(.+?)\}\}/g, '')
            .replace(/\{\{comment:(.+?)\}\}/g, ''),
        data: message.data.toLocaleLowerCase()
            .replace(/\{\{\/\/(.+?)\}\}/g, '')
            .replace(/\{\{comment:(.+?)\}\}/g, ''),
    }));
    const allMode = request.all === true;
    let allModeMatched = true;
    for (const message of messageList) {
        let text = message.data;
        if (request.fullWordMatching) {
            const words = text.split(' ');
            for (const key of request.keys) {
                if (words.includes(key.toLocaleLowerCase())) {
                    logs.push({ prompt: message.prompt, source: message.source, activated: key });
                    if (!allMode) return { matched: true, logs };
                } else if (allMode) {
                    allModeMatched = false;
                }
            }
        } else {
            text = text.replace(/ /g, '');
            for (const key of request.keys) {
                const realKey = key.toLocaleLowerCase().replace(/ /g, '');
                if (text.includes(realKey)) {
                    logs.push({ prompt: message.prompt, source: message.source, activated: key });
                    if (!allMode) return { matched: true, logs };
                } else if (allMode) {
                    allModeMatched = false;
                }
            }
        }
    }
    return { matched: allMode && allModeMatched, logs };
}

function matchLoreBatch(messages, requests, options = {}) {
    if (!Array.isArray(messages) || !Array.isArray(requests)) {
        throw new TypeError('messages and requests must be arrays');
    }
    if (requests.length > 4096) throw new RangeError('Too many lore match requests');
    return requests.map((request) => matchLoreRequest(messages, request, options));
}

module.exports = { matchLoreRequest, matchLoreBatch };
