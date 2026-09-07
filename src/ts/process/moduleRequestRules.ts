/** Literal, case-sensitive conditions for routing auxiliary requests to a module's model. */
export interface ModuleRequestRule {
  enabled: boolean;
  phrases: string[];
  sourceModuleId?: string;
  role?: "user" | "assistant" | "system";
  /** Optional advanced limit, counted from the end of the entire request. */
  lastMessages?: number;
  /** "any": match if any phrase matches (default). "all": all phrases in same message. "all_request": all phrases across entire request. */
  matchMode?: "any" | "all" | "all_request";
}

export interface RuleMessage {
  role: string;
  content: string;
}

export interface RuleModule {
  id: string;
  name: string;
  subModel?: string;
  subModelRequestRules?: ModuleRequestRule[];
}

export interface ModuleRuleDecision {
  status: "unmatched" | "matched" | "conflict";
  modules: { id: string; name: string }[];
  model?: string;
}

export function matchesModuleRequestRule(
  rule: ModuleRequestRule,
  messages: readonly RuleMessage[],
  sourceModuleId?: string,
): boolean {
  // Module imports are untrusted: malformed/empty conditions must never match all.
  if (!rule || rule.enabled !== true || !Array.isArray(rule.phrases))
    return false;
  if (rule.sourceModuleId && rule.sourceModuleId !== sourceModuleId)
    return false;
  if (rule.phrases.some((p) => typeof p !== "string")) return false;
  const phrases = rule.phrases
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0);
  if (!phrases.length) return false;
  if (
    rule.lastMessages !== undefined &&
    (!Number.isSafeInteger(rule.lastMessages) || rule.lastMessages < 1)
  )
    return false;
  const start =
    rule.lastMessages === undefined
      ? 0
      : Math.max(0, messages.length - rule.lastMessages);

  const mode = rule.matchMode ?? "any";

  if (mode === "all_request") {
    const candidateMessages = messages
      .slice(start)
      .filter((m) => !rule.role || m.role === rule.role);
    if (!candidateMessages.length) return false;
    const allContent = candidateMessages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    return phrases.every((phrase) => allContent.includes(phrase));
  }

  if (mode === "all") {
    for (let i = start; i < messages.length; i++) {
      const message = messages[i];
      if (rule.role && message.role !== rule.role) continue;
      if (
        typeof message.content === "string" &&
        phrases.every((phrase) => message.content.includes(phrase))
      )
        return true;
    }
    return false;
  }

  // Default mode ("any"): match if any phrase is present in any candidate message
  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (rule.role && message.role !== rule.role) continue;
    if (
      typeof message.content === "string" &&
      phrases.some((phrase) => message.content.includes(phrase))
    )
      return true;
  }
  return false;
}

export function getRuleMatchScore(
  rule: ModuleRequestRule,
  messages: readonly RuleMessage[],
): number {
  const phrases = rule.phrases
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0);
  const start =
    rule.lastMessages === undefined
      ? 0
      : Math.max(0, messages.length - rule.lastMessages);
  const candidateMessages = messages
    .slice(start)
    .filter((m) => !rule.role || m.role === rule.role);

  let maxMatchedLength = 0;
  for (const message of candidateMessages) {
    if (typeof message.content !== "string") continue;
    for (const phrase of phrases) {
      if (message.content.includes(phrase) && phrase.length > maxMatchedLength) {
        maxMatchedLength = phrase.length;
      }
    }
  }
  return maxMatchedLength;
}

export function resolveModuleRequestRules(
  modules: readonly RuleModule[],
  messages: readonly RuleMessage[],
  sourceModuleId?: string,
): ModuleRuleDecision {
  const matched = new Map<string, { module: RuleModule; score: number }>();
  for (const module of modules) {
    if (
      module.subModel &&
      Array.isArray(module.subModelRequestRules)
    ) {
      let maxScore = -1;
      for (const rule of module.subModelRequestRules) {
        // If user mistakenly configured the module itself as source, treat as any caller
        const effectiveRule =
          rule.sourceModuleId === module.id
            ? { ...rule, sourceModuleId: undefined }
            : rule;
        if (matchesModuleRequestRule(effectiveRule, messages, sourceModuleId)) {
          const score = getRuleMatchScore(effectiveRule, messages);
          if (score > maxScore) {
            maxScore = score;
          }
        }
      }
      if (maxScore >= 0) {
        matched.set(module.id, { module, score: maxScore });
      }
    }
  }

  const allMatches = [...matched.values()];
  if (allMatches.length === 0) {
    return { status: "unmatched", modules: [] };
  }
  if (allMatches.length === 1) {
    return {
      status: "matched",
      modules: [{ id: allMatches[0].module.id, name: allMatches[0].module.name }],
      model: allMatches[0].module.subModel,
    };
  }

  // Conflict resolution: prefer more specific (longer) match
  const maxScore = Math.max(...allMatches.map((m) => m.score));
  const bestMatches = allMatches.filter((m) => m.score === maxScore);

  if (bestMatches.length === 1) {
    return {
      status: "matched",
      modules: [{ id: bestMatches[0].module.id, name: bestMatches[0].module.name }],
      model: bestMatches[0].module.subModel,
    };
  }

  return {
    status: "conflict",
    modules: allMatches.map(({ module }) => ({ id: module.id, name: module.name })),
    model: undefined,
  };
}
