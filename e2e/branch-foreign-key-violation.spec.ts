import { createRequire } from "node:module";
import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import type { Chat } from "../src/ts/storage/database/schema";
import type {
  SqlChatBranchSummary,
  SqlCreateChatBranchInput,
} from "../src/ts/storage/sql/ISqlStorage";
import type { SqlBranchStorage } from "../src/ts/storage/sql/sqlStorageFactory";
import type { characterStore, messageStore } from "../src/ts/stores/domain";

type CharacterStoreType = typeof characterStore;
type MessageStoreType = typeof messageStore;

interface PostgresStorageInstance {
  initialize(): Promise<void>;
  pool: {
    query(sql: string, params?: unknown[]): Promise<unknown>;
    end(): Promise<void>;
  };
  createChatBranch(input: SqlCreateChatBranchInput): Promise<SqlChatBranchSummary>;
}

interface PostgresStorageConstructor {
  new (options: { connectionString: string }): PostgresStorageInstance;
}

const nodeRequire = createRequire(import.meta.url);

async function waitForAppReady(page: Page) {
  await page.goto("/");
  await page.waitForFunction(
    () =>
      !!document.body &&
      !document.body.innerText.includes("Initialising Database") &&
      !!navigator.serviceWorker.controller,
    undefined,
    { timeout: 120_000 },
  );

  const skipButton = page.getByRole("button", {
    name: /Skip & Explore|직접 설정할래요/i,
  });
  await skipButton.waitFor({ state: "visible", timeout: 30_000 });
  await skipButton.click();

  await page.waitForFunction(
    () =>
      !document.body.innerText.includes("Initialising Database") &&
      !document.body.innerText.includes("Welcome to Haejeok RisuAI"),
    undefined,
    { timeout: 30_000 },
  );

  await expect(page.getByText("Loading...")).toHaveCount(0, { timeout: 30_000 });
}

test.describe("branch foreign key constraint violation reproduction", () => {
  test("reproduce SQLite foreign key constraint failure in WebSqliteStorage", async ({
    page,
  }) => {
    await waitForAppReady(page);

    // 1. Directly create a character via the user interface (UI-driven E2E)
    const addCharacterButton = page
      .locator("button:has(svg path[d*='M12 6v6m0 0v6m0-6h6m-6 0H6'])")
      .first();
    await addCharacterButton.waitFor({ state: "visible", timeout: 30_000 });
    await addCharacterButton.click();

    const createFromScratchButton = page.getByRole("button", {
      name: /Create from Scratch|새 캐릭터 생성/i,
    });
    await createFromScratchButton.waitFor({ state: "visible", timeout: 10_000 });
    await createFromScratchButton.click();

    const characterOptionButton = page.getByRole("button", {
      name: /Character|캐릭터/i,
      exact: true,
    });
    await characterOptionButton.waitFor({ state: "visible", timeout: 10_000 });
    await characterOptionButton.click();

    // 2. Wait for character to be created and active
    await page.waitForFunction(async () => {
      const domainUrl = "/src/ts/stores/domain/index.ts";
      const { characterStore } = (await import(domainUrl)) as {
        characterStore: { characters: Array<{ chaId: string; chats: Array<{ id?: string }> }> };
      };
      return characterStore.characters.length > 0;
    });

    await page.evaluate(async () => {
      const domainUrl = "/src/ts/stores/domain/index.ts";
      const factoryUrl = "/src/ts/storage/sql/sqlStorageFactory.ts";

      const { characterStore, messageStore } = (await import(
        /* @vite-ignore */ domainUrl
      )) as { characterStore: CharacterStoreType; messageStore: MessageStoreType };
      const { getSqlBranchStorage } = (await import(
        /* @vite-ignore */ factoryUrl
      )) as { getSqlBranchStorage: () => Promise<SqlBranchStorage> };

      const character = characterStore.characters[characterStore.characters.length - 1];
      const chat = character.chats[0];
      chat.id ??= crypto.randomUUID();
      const chatId = chat.id;

      characterStore.markChatDirty(chatId);
      characterStore.markChatManifestDirty(character.chaId);
      await characterStore.flush();
      await messageStore.persistNewChat(character.chaId, chatId, []);

      const branchStorage = await getSqlBranchStorage();
      const branches: SqlChatBranchSummary[] =
        await branchStorage.listChatBranches(chatId);
      const rootBranch = branches.find(
        (b: SqlChatBranchSummary) => b.reason === "root",
      );

      // Intentionally insert a branch with a non-existent forkMessageId
      // SQLite enforces: FOREIGN KEY (chat_id, fork_message_id) REFERENCES messages(chat_id, id)
      // and throws SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed!
      await branchStorage.createChatBranch({
        id: crypto.randomUUID(),
        chatId,
        parentBranchId: rootBranch?.id,
        forkMessageId: "ghost-message-id-not-in-messages",
        reason: "manual",
        createdAt: Date.now(),
      });
    });
  });

  test("reproduce PostgreSQL branches_fork_message_fk failure in PostgresStorage", async () => {
    const connectionString =
      process.env.TEST_DATABASE_URL ||
      "postgresql://risuai:testpass@172.18.0.2:5432/risuai";

    const { PostgresStorage } = nodeRequire(
      "../server/node/storage/postgres/postgresStorage.cjs",
    ) as { PostgresStorage: PostgresStorageConstructor };

    const storage = new PostgresStorage({ connectionString });
    await storage.initialize();

    const charId = "repro-char-" + Date.now();
    const chatId = "repro-chat-" + Date.now();

    await storage.pool.query(
      "INSERT INTO character.characters (id, position, kind, name) VALUES ($1, 0, 'character', 'Reproduce') ON CONFLICT DO NOTHING",
      [charId],
    );
    await storage.pool.query(
      "INSERT INTO chat.chats (id, character_id, position, name) VALUES ($1, $2, 0, 'Reproduce Chat') ON CONFLICT DO NOTHING",
      [chatId, charId],
    );
    await storage.pool.query(
      "INSERT INTO chat.branches (chat_id, id, parent_branch_id, fork_message_id, head_message_id, reason, created_at) VALUES ($1, $2, NULL, NULL, NULL, 'root', $3) ON CONFLICT DO NOTHING",
      [chatId, chatId + ":root", Date.now()],
    );
    await storage.pool.query(
      "INSERT INTO chat.active_branches (chat_id, branch_id) VALUES ($1, $2) ON CONFLICT (chat_id) DO UPDATE SET branch_id = EXCLUDED.branch_id",
      [chatId, chatId + ":root"],
    );

    try {
      // Intentionally insert a branch with a non-existent fork_message_id
      // This violates branches_fork_message_fk and throws the exact PostgreSQL error
      await storage.createChatBranch({
        chatId,
        id: "violating-branch-id",
        parentBranchId: chatId + ":root",
        forkMessageId: "invalid-ghost-message-id",
        reason: "manual",
        createdAt: Date.now(),
      });
    } finally {
      await storage.pool.end();
    }
  });
});
