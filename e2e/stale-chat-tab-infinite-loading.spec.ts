import { expect, test } from "./fixtures";

/**
 * Regression spec for the user report:
 *   "채팅을 닫거나 새로 열거나하면 '불러오는중입니다' 에서 무한대기"
 *
 * Original bug: deleting a chat/character left chat tabs referencing the
 * deleted target behind, and navigateToChatTab() activated a tab BEFORE
 * validating its target. The stale active tab deadlocked DefaultChatScreen
 * on its "Loading Chat Data" gate with no way to escape (the gate branch
 * renders no tab bar), and closing/reopening the chat never recovered.
 *
 * Fixed behavior covered here:
 *   1. Deleting a chat/character prunes the tabs that reference it
 *      (pruneChatTargets in the delete handlers, pruneCharacter in
 *      removeChar) so a stale tab never lingers.
 *   2. navigateToChatTab() validates the target BEFORE activating the tab
 *      and prunes a stale tab instead of activating it — exercised by
 *      injecting a stale tab the way another window / remote sync would.
 *   3. Closing and reopening a valid character never shows the loading gate.
 *
 * Deletions are performed through the same store mutations the real delete
 * UIs perform (splice / removeChar), so the test exercises the state layer
 * without depending on dialog selectors.
 */

async function waitForAppReady(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForFunction(
    () =>
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

const LOADING_GATE = /Loading Chat Data|채팅 데이터 로딩 중/;

test.describe("Stale chat tabs must not deadlock the chat screen", () => {
  test("deleting a chat prunes its tab; clicking a stale tab never deadlocks", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await waitForAppReady(page);

    // ── Phase 1: healthy character, second chat in its own tab ──
    const setup = await page.evaluate(async () => {
      const charUrl = "/src/ts/characters.ts";
      const { createNewCharacter, changeChar } = (await import(
        /* @vite-ignore */ charUrl
      )) as {
        createNewCharacter: () => number;
        changeChar: (idx: number) => Promise<void>;
      };
      const idx = createNewCharacter();
      await changeChar(idx);
      const storeUrl = "/src/ts/stores/domain/characterStore.svelte.ts";
      const { characterStore } = (await import(
        /* @vite-ignore */ storeUrl
      )) as { characterStore: any };
      return {
        idx,
        chaId: characterStore.characters[idx].chaId as string,
      };
    });

    // The initial tab is created by ChatTabs' syncActiveTarget effect once
    // the (lazy-loaded) ChatScreen chunk has mounted.
    const tabList = page.locator("[data-chat-tab-list]");
    await expect(tabList).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-chat-tab-id]")).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(page.getByText(LOADING_GATE)).toHaveCount(0);

    // Add a second chat, then open it in a second tab via the real "+"
    // button (addFromCurrent duplicates the CURRENT chat and activates it).
    // Only afterwards move the selection to chat 2 (changeChatTo is what the
    // chat-list UI calls): syncActiveTarget re-points the ACTIVE tab to
    // chat 2, so the first tab keeps pointing at chat 1:
    //   [T1 → chat1 (bg), T2 → chat2 (active)]
    await page.evaluate(async () => {
      const storeUrl = "/src/ts/stores/domain/characterStore.svelte.ts";
      const { characterStore } = (await import(
        /* @vite-ignore */ storeUrl
      )) as { characterStore: any };
      const char = characterStore.characters[characterStore.selectedId];
      const chat2 = {
        message: [],
        note: "",
        name: "Chat 2",
        localLore: [],
        fmIndex: -1,
        id: crypto.randomUUID(),
      };
      char.chats.push(chat2);
      characterStore.markChatManifestDirty(char.chaId);
    });
    await page.locator("[data-tab-add]").click();
    await expect(
      page.locator("[data-chat-tab-id]"),
      "two tabs should exist",
    ).toHaveCount(2, { timeout: 10_000 });
    await page.evaluate(async () => {
      const apiUrl = "/src/ts/globalApi.svelte.ts";
      const { changeChatTo } = (await import(
        /* @vite-ignore */ apiUrl
      )) as { changeChatTo: (index: number) => void };
      changeChatTo(1);
    });

    // Switch back to chat 1's tab (pure UI click) so chat 2's tab becomes a
    // background tab.
    const firstTabId = await page
      .locator("[data-chat-tab-id]")
      .first()
      .getAttribute("data-chat-tab-id");
    await page.locator(`[data-chat-tab-id="${firstTabId}"]`).click();
    await expect(
      page.getByText(LOADING_GATE),
      "switching to a healthy tab must not show the gate",
    ).toHaveCount(0);

    // ── Phase 2: delete the chat the background tab points at ──
    // Mirrors SideChatList/MobileChatList delete handlers (splice). The
    // delete handler must prune the tab that referenced the deleted chat.
    await page.evaluate(async () => {
      const storeUrl = "/src/ts/stores/domain/characterStore.svelte.ts";
      const { characterStore } = (await import(
        /* @vite-ignore */ storeUrl
      )) as { characterStore: any };
      const tabsUrl = "/src/ts/chatTabs.svelte.ts";
      const { pruneChatTargets } = (await import(
        /* @vite-ignore */ tabsUrl
      )) as { pruneChatTargets: (chatId: string) => void };
      const char = characterStore.characters[characterStore.selectedId];
      const deletedChatId = char.chats[1].id;
      char.chats.splice(1, 1);
      characterStore.markChatManifestDirty(char.chaId);
      characterStore.markCharacterDirty(char.chaId);
      // Same propagation the delete UI performs.
      pruneChatTargets(deletedChatId);
    });

    // The pruned tab disappears and the app stays healthy.
    await expect(
      page.locator("[data-chat-tab-id]"),
      "the tab of the deleted chat must be pruned",
    ).toHaveCount(1, { timeout: 10_000 });
    await expect(
      page.getByText(LOADING_GATE),
      "healthy state must not show the loading gate",
    ).toHaveCount(0);
    // The chat view (message composer) must still be rendered.
    await expect(page.locator(".default-chat-pane")).toBeVisible();

    // ── Phase 2b: a stale tab restored by another window/sync must be ──
    // rejected by navigateToChatTab instead of being activated.
    await page.evaluate(async ({ chaId }) => {
      const tabsUrl = "/src/ts/chatTabs.svelte.ts";
      const { chatTabsStore } = (await import(
        /* @vite-ignore */ tabsUrl
      )) as { chatTabsStore: any };
      chatTabsStore.tabs.push({
        id: crypto.randomUUID(),
        groupId: chatTabsStore.focusedGroupId,
        characterId: chaId,
        chatId: "deleted-chat-id",
        unread: false,
        draft: "",
        translatedDraft: "",
        fileInput: [],
      });
    }, { chaId: setup.chaId });
    await expect(page.locator("[data-chat-tab-id]")).toHaveCount(2, {
      timeout: 10_000,
    });
    await page
      .locator('[title$="· Chat"]')
      .last()
      .click();

    // The stale tab must be pruned (not activated) and the view stays put.
    await expect(
      page.getByText(LOADING_GATE),
      "clicking a stale tab must never show the loading gate",
    ).toHaveCount(0, { timeout: 10_000 });
    await expect(
      page.locator("[data-chat-tab-id]"),
      "the stale tab must be pruned",
    ).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(".default-chat-pane")).toBeVisible();

    // ── Phase 3: the reported user flow — close the chat, open it again ──
    // Home button behavior (Sidebar home handler / MobileHeader): deselect.
    await page.evaluate(async () => {
      const storesUrl = "/src/ts/stores.svelte.ts";
      const { selectedCharID } = (await import(
        /* @vite-ignore */ storesUrl
      )) as { selectedCharID: any };
      selectedCharID.set(-1);
    });
    await page.waitForTimeout(200);
    await page.evaluate(
      async ({ idx }) => {
        const charUrl = "/src/ts/characters.ts";
        const { changeChar } = (await import(
          /* @vite-ignore */ charUrl
        )) as { changeChar: (idx: number) => Promise<void> };
        await changeChar(idx);
      },
      { idx: setup.idx },
    );

    // The remaining tab is valid, so reopening must show the chat again.
    await expect(page.locator(".default-chat-pane")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText(LOADING_GATE),
      "reopening a valid character must not get stuck on the loading gate",
    ).toHaveCount(0, { timeout: 10_000 });

    const diagnosis = await page.evaluate(async () => {
      const storeUrl = "/src/ts/stores/domain/characterStore.svelte.ts";
      const { characterStore } = (await import(
        /* @vite-ignore */ storeUrl
      )) as { characterStore: any };
      const tabsUrl = "/src/ts/chatTabs.svelte.ts";
      const { chatTabsStore } = (await import(
        /* @vite-ignore */ tabsUrl
      )) as { chatTabsStore: any };
      const active = chatTabsStore.activeTab;
      const char = characterStore.characters[characterStore.selectedId];
      return {
        activeTabChatId: active?.chatId,
        chatExists: active
          ? char?.chats?.some((chat: any) => chat.id === active.chatId)
          : null,
        chatCount: char?.chats?.length,
      };
    });
    expect(diagnosis.chatExists).toBe(true);
  });

  test("deleting a character prunes its tabs; stale tabs are rejected", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await waitForAppReady(page);

    // Character A with two tabs, then switch to character B so that the
    // first tab becomes a background tab referencing character A.
    const setup = await page.evaluate(async () => {
      const charUrl = "/src/ts/characters.ts";
      const { createNewCharacter, changeChar } = (await import(
        /* @vite-ignore */ charUrl
      )) as {
        createNewCharacter: () => number;
        changeChar: (idx: number) => Promise<void>;
      };
      const idxA = createNewCharacter();
      await changeChar(idxA);
      const storeUrl = "/src/ts/stores/domain/characterStore.svelte.ts";
      const { characterStore } = (await import(
        /* @vite-ignore */ storeUrl
      )) as { characterStore: any };
      return {
        idxA,
        chaIdA: characterStore.characters[idxA].chaId as string,
      };
    });

    await expect(page.locator("[data-chat-tab-list]")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("[data-chat-tab-id]")).toHaveCount(1, {
      timeout: 10_000,
    });
    await page.locator("[data-tab-add]").click();
    await expect(page.locator("[data-chat-tab-id]")).toHaveCount(2, {
      timeout: 10_000,
    });

    // Switch to character B. syncActiveTarget re-points the *active* tab to
    // B; the background tab still references character A.
    await page.evaluate(async () => {
      const charUrl = "/src/ts/characters.ts";
      const { createNewCharacter, changeChar } = (await import(
        /* @vite-ignore */ charUrl
      )) as {
        createNewCharacter: () => number;
        changeChar: (idx: number) => Promise<void>;
      };
      const idxB = createNewCharacter();
      await changeChar(idxB);
    });
    await expect(page.locator("[data-chat-tab-list]")).toBeVisible();

    // Delete character A through the real removeChar API (permanentForce
    // skips the confirm dialogs). This is what the trash UI calls. removeChar
    // must prune A's tabs so none of them can deadlock the screen later.
    await page.evaluate(
      async ({ chaIdA }) => {
        const charUrl = "/src/ts/characters.ts";
        const { removeChar } = (await import(/* @vite-ignore */ charUrl)) as {
          removeChar: (
            id: string,
            name: string,
            type: "permanentForce",
          ) => Promise<void>;
        };
        await removeChar(chaIdA, "A", "permanentForce");
      },
      { chaIdA: setup.chaIdA },
    );

    // removeChar deselects (selectedCharID = -1) → main menu. Reopen the
    // remaining character; no tab may reference the deleted character.
    await page.evaluate(async () => {
      const charUrl = "/src/ts/characters.ts";
      const { changeChar } = (await import(
        /* @vite-ignore */ charUrl
      )) as { changeChar: (idx: number) => Promise<void> };
      const storeUrl = "/src/ts/stores/domain/characterStore.svelte.ts";
      const { characterStore } = (await import(
        /* @vite-ignore */ storeUrl
      )) as { characterStore: any };
      const idxB = characterStore.characters.findIndex(
        (character: any) => character?.chaId && character.type === "character",
      );
      await changeChar(idxB);
    });
    await expect(page.locator("[data-chat-tab-list]")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator("[data-chat-tab-id]"),
      "tabs of the deleted character must be pruned",
    ).toHaveCount(1);
    await expect(
      page.getByText(LOADING_GATE),
      "reopening after character deletion must not show the gate",
    ).toHaveCount(0);

    // Re-inject a stale tab for the deleted character (as another window or
    // remote sync could) and try to activate it: navigateToChatTab must
    // prune it instead of activating it.
    await page.evaluate(async ({ chaIdA }) => {
      const tabsUrl = "/src/ts/chatTabs.svelte.ts";
      const { chatTabsStore } = (await import(
        /* @vite-ignore */ tabsUrl
      )) as { chatTabsStore: any };
      chatTabsStore.tabs.push({
        id: crypto.randomUUID(),
        groupId: chatTabsStore.focusedGroupId,
        characterId: chaIdA,
        chatId: "deleted-chat",
        unread: false,
        draft: "",
        translatedDraft: "",
        fileInput: [],
      });
    }, { chaIdA: setup.chaIdA });
    await expect(page.locator("[data-chat-tab-id]")).toHaveCount(2, {
      timeout: 10_000,
    });
    await page.locator("[data-chat-tab-id]").last().click();

    await expect(
      page.getByText(LOADING_GATE),
      "tab of a deleted character must not deadlock the screen",
    ).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator("[data-chat-tab-id]")).toHaveCount(1);
    await expect(page.locator(".default-chat-pane")).toBeVisible();
  });
});