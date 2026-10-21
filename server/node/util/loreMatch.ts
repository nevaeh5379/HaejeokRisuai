function normalizeKeys(keys?: any): string[] {
  if (!Array.isArray(keys)) return [];
  const result: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const trimmed = String(keys[i] ?? "").trim();
    if (trimmed.length > 0) {
      result.push(trimmed);
    }
  }
  return result;
}

const MAX_LORE_SEARCH_DEPTH: any = 10000;
const MAX_LORE_REGEX_PATTERN_LENGTH: any = 2048;
const LORE_REGEX_FLAGS: any = /^[dgimsuvy]*$/;

function parseLoreRegexLiteral(value?: any): any {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  const separator: any = value.lastIndexOf("/");
  if (separator <= 0) return null;
  const pattern: any = value.slice(1, separator);
  const flags: any = value.slice(separator + 1);
  if (pattern.length > MAX_LORE_REGEX_PATTERN_LENGTH) return null;
  if (!LORE_REGEX_FLAGS.test(flags)) return null;
  return { pattern, flags };
}

function buildMessageList(
  messages?: any,
  request?: any,
  username?: any,
  charName?: any,
): any[] {
  if (!Array.isArray(messages)) return [];
  const depth: any = Math.min(
    MAX_LORE_SEARCH_DEPTH,
    Math.max(0, Math.floor(Number(request.searchDepth) || 0)),
  );
  const start = Math.max(0, messages.length - depth);
  const count = messages.length - start;
  const result = new Array(count);
  for (let i = start; i < messages.length; i++) {
    const msg: any = messages[i];
    const isUser: any = msg?.role === "user";
    const displayName: any = isUser ? username : msg?.displayName || charName;
    const dataStr = String(msg?.data ?? "");
    result[i - start] = {
      source: `message ${i - start} by ${isUser ? "user" : "char"}`,
      prompt: `\x01{{${displayName}}}:${dataStr}\x01`,
      data: dataStr,
    };
  }
  return result;
}

function matchLoreRequest(
  messages?: any,
  rawRequest?: any,
  options: any = {},
): any {
  const request: any = { ...rawRequest, keys: normalizeKeys(rawRequest?.keys) };
  const logs: any = [];
  let messageList: any = buildMessageList(
    messages,
    request,
    String(options.username ?? ""),
    String(options.charName ?? ""),
  );
  if (
    !request.dontSearchWhenRecursive &&
    Array.isArray(options.recursivePrompts)
  ) {
    for (let i = 0; i < options.recursivePrompts.length; i++) {
      const item: any = options.recursivePrompts[i];
      messageList.push({
        source: "lorebook " + String(item?.source ?? ""),
        prompt: String(item?.prompt ?? ""),
        data: String(item?.data ?? ""),
      });
    }
  }
  if (request.regex) {
    for (const message of messageList) {
      for (const regexString of request.keys) {
        const parsedRegex: any = parseLoreRegexLiteral(regexString);
        if (!parsedRegex) return { matched: false, logs };
        try {
          // Lorebook regexes are explicitly authored by the user. The literal is
          // length-bounded and flags are allowlisted above before construction.
          const regex: any = new RegExp(parsedRegex.pattern, parsedRegex.flags); // lgtm[js/regex-injection]
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

  for (let i = 0; i < messageList.length; i++) {
    const message = messageList[i];
    message.prompt = message.prompt
      .toLocaleLowerCase()
      .replace(/\{\{\/\/(.+?)\}\}/g, "")
      .replace(/\{\{comment:(.+?)\}\}/g, "");
    message.data = message.data
      .toLocaleLowerCase()
      .replace(/\{\{\/\/(.+?)\}\}/g, "")
      .replace(/\{\{comment:(.+?)\}\}/g, "");
  }
  const allMode: any = request.all === true;
  let allModeMatched: any = true;
  for (const message of messageList) {
    let text: any = message.data;
    if (request.fullWordMatching) {
      const words: any = text.split(" ");
      for (const key of request.keys) {
        if (words.includes(key.toLocaleLowerCase())) {
          logs.push({
            prompt: message.prompt,
            source: message.source,
            activated: key,
          });
          if (!allMode) return { matched: true, logs };
        } else if (allMode) {
          allModeMatched = false;
        }
      }
    } else {
      text = text.replace(/ /g, "");
      for (const key of request.keys) {
        const realKey: any = key.toLocaleLowerCase().replace(/ /g, "");
        if (text.includes(realKey)) {
          logs.push({
            prompt: message.prompt,
            source: message.source,
            activated: key,
          });
          if (!allMode) return { matched: true, logs };
        } else if (allMode) {
          allModeMatched = false;
        }
      }
    }
  }
  return { matched: allMode && allModeMatched, logs };
}

function matchLoreBatch(
  messages?: any,
  requests?: any,
  options: any = {},
): any {
  if (!Array.isArray(messages) || !Array.isArray(requests)) {
    throw new TypeError("messages and requests must be arrays");
  }
  if (requests.length > 4096)
    throw new RangeError("Too many lore match requests");
  return requests.map((request?: any) =>
    matchLoreRequest(messages, request, options),
  );
}

export { matchLoreRequest, matchLoreBatch };
