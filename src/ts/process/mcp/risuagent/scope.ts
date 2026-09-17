/**
 * Request-scoped Risu context attachment for Risu Agent.
 *
 * The registry is keyed by the *agent's own* chat id (the SQL-backed session
 * that Risu Agent is generating into). It stores only stable IDs of the
 * explicitly attached character/chat so tool execution never has to guess from
 * array indexes or from the Risu Agent's synthetic character.
 *
 * This is intentionally in-memory only: attachments are a UI/runtime concern
 * and must not create a new persisted blob.
 */

export interface RisuAgentContextScope {
  /** Stable `chaId` of the explicitly attached character. */
  readonly characterId: string;
  /** Stable `Chat.id` of the explicitly attached chat, when one is attached. */
  readonly chatId?: string;
}

const scopeByAgentChatId = new Map<string, RisuAgentContextScope>();

function isValidScope(scope: RisuAgentContextScope | null): boolean {
  return Boolean(scope && scope.characterId);
}

/** Register (or replace) the attached context for an agent session. */
export function setRisuAgentContextScope(
  agentChatId: string | null | undefined,
  scope: RisuAgentContextScope | null,
): void {
  if (!agentChatId) return;
  if (!isValidScope(scope)) {
    scopeByAgentChatId.delete(agentChatId);
    return;
  }
  scopeByAgentChatId.set(agentChatId, {
    characterId: scope!.characterId,
    chatId: scope!.chatId,
  });
}

/** Resolve the attached context for an agent session, if any. */
export function getRisuAgentContextScope(
  agentChatId: string | null | undefined,
): RisuAgentContextScope | undefined {
  if (!agentChatId) return undefined;
  return scopeByAgentChatId.get(agentChatId);
}

/** Remove a single session's attachment. */
export function clearRisuAgentContextScope(
  agentChatId: string | null | undefined,
): void {
  if (!agentChatId) return;
  scopeByAgentChatId.delete(agentChatId);
}

/**
 * Test-only teardown. Production code must never clear every scope: an
 * in-flight generation may still need the scope it started with. Use
 * {@link clearRisuAgentContextScope} for the specific session.
 */
export function resetRisuAgentContextScopesForTesting(): void {
  scopeByAgentChatId.clear();
}
