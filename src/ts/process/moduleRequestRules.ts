/** Literal, case-sensitive conditions. All phrases must occur in one message. */
export interface ModuleRequestRule {
  enabled: boolean;
  phrases: string[];
  sourceModuleId?: string;
  role?: "user" | "assistant" | "system";
  /** Optional advanced limit, counted from the end of the entire request. */
  lastMessages?: number;
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
  if (
    !rule.phrases.length ||
    rule.phrases.some((p) => typeof p !== "string" || !p.trim())
  )
    return false;
  if (
    rule.lastMessages !== undefined &&
    (!Number.isSafeInteger(rule.lastMessages) || rule.lastMessages < 1)
  )
    return false;
  const start =
    rule.lastMessages === undefined
      ? 0
      : Math.max(0, messages.length - rule.lastMessages);
  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (rule.role && message.role !== rule.role) continue;
    if (
      typeof message.content === "string" &&
      rule.phrases.every((phrase) => message.content.includes(phrase))
    )
      return true;
  }
  return false;
}

export function resolveModuleRequestRules(
  modules: readonly RuleModule[],
  messages: readonly RuleMessage[],
  sourceModuleId?: string,
): ModuleRuleDecision {
  const matched = new Map<string, RuleModule>();
  for (const module of modules) {
    if (
      module.subModel &&
      Array.isArray(module.subModelRequestRules) &&
      module.subModelRequestRules.some((rule) =>
        matchesModuleRequestRule(rule, messages, sourceModuleId),
      )
    ) {
      matched.set(module.id, module);
    }
  }
  const matches = [...matched.values()];
  return {
    status:
      matches.length === 0
        ? "unmatched"
        : matches.length === 1
          ? "matched"
          : "conflict",
    modules: matches.map(({ id, name }) => ({ id, name })),
    model: matches.length === 1 ? matches[0].subModel : undefined,
  };
}
