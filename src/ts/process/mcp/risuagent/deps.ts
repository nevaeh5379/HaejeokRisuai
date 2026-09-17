import type { character } from "../../../storage/database/schema";
import type { SqlMessagePage } from "../../../storage/sql/ISqlStorage";
import { characterStore } from "../../../stores/domain/characterStore.svelte";
import { getSqlStorage } from "../../../storage/sql/sqlStorageFactory";

/**
 * Injectable boundary for the read-only Risu Agent access layer. Production
 * uses the SQL-backed store; tests can supply a lightweight fake without
 * booting the Svelte rune stores.
 */
export interface RisuAgentAccessDependencies {
  /**
   * Resolve a character by stable id. Implementations may lazily hydrate
   * details, but must re-resolve by id after any await.
   */
  resolveCharacter(characterId: string): Promise<character | null>;
  /** Read a bounded page of an existing chat without loading the whole chat. */
  loadChatMessagePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ): Promise<SqlMessagePage>;
}

export const defaultRisuAgentAccessDependencies: RisuAgentAccessDependencies = {
  async resolveCharacter(characterId: string): Promise<character | null> {
    const summary = characterStore.getById(characterId);
    if (!summary || summary.type === "group") return null;
    if (summary.detailsLoaded === false) {
      await characterStore.ensureCharacterDetails(characterId);
    }
    // Re-resolve after the await: selection/order may have changed.
    const resolved = characterStore.getById(characterId);
    if (!resolved || resolved.type === "group") return null;
    return resolved as character;
  },
  async loadChatMessagePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ): Promise<SqlMessagePage> {
    const storage = await getSqlStorage();
    return await storage.loadChatMessagePage(chatId, before, limit);
  },
};
