import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { characterStore, settingsStore } from "src/ts/stores/domain";
import { MobileSearch, selectedCharID } from "src/ts/stores.svelte";
import type { Chat, character } from "@risuai/protocol/domain/database.ts";
import MobileCharacters from "src/lib/Mobile/MobileCharacters.svelte";
import MobileChatList from "src/lib/Mobile/MobileChatList.svelte";
import SideChatList from "src/lib/SideBars/SideChatList.svelte";

interface SortableRegistration {
  node: HTMLElement;
  options: { onEnd?: (event: { to: HTMLElement }) => Promise<void> };
}

const mocks = vi.hoisted(() => ({
  selectCharacter: vi.fn(),
  selectChat: vi.fn(),
  sortables: [] as SortableRegistration[],
}));

vi.mock("src/ts/characters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/ts/characters")>()),
  changeChar: mocks.selectCharacter,
}));
vi.mock("src/ts/globalApi.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/ts/globalApi.svelte")>()),
  changeChatTo: mocks.selectChat,
}));
vi.mock("src/ts/stores/domain/messageStore.svelte", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("src/ts/stores/domain/messageStore.svelte")
  >()),
  releaseInactiveChatMessages: vi.fn(),
}));
vi.mock("src/lib/SideBars/Toggles.svelte", () => ({ default: () => {} }));
vi.mock("sortablejs/modular/sortable.core.esm.js", () => {
  class Sortable {
    constructor(node: HTMLElement, options: SortableRegistration["options"]) {
      mocks.sortables.push({ node, options });
    }
    static create(node: HTMLElement, options: SortableRegistration["options"]) {
      return new Sortable(node, options);
    }
    destroy = vi.fn();
  }
  return { default: Sortable };
});

const apps: ReturnType<typeof mount>[] = [];

function render(component: Parameters<typeof mount>[0], props = {}) {
  const target = document.createElement("div");
  document.body.append(target);
  apps.push(mount(component, { target, props }));
  return target;
}

function chat(
  name: string,
  folderId?: string,
  id: string | undefined = name,
): Chat {
  return { id, name, folderId, message: [], note: "", localLore: [] };
}

function characterData(name: string, chats: Chat[] = []): character {
  return {
    type: "character",
    chaId: name,
    name,
    image: "",
    chats,
    chatPage: 0,
    chatFolders: [],
    lastInteraction: 0,
  } as character;
}

function mobileRow(target: HTMLElement, name: string) {
  const row = Array.from(
    target.querySelectorAll<HTMLElement>('[role="button"]'),
  ).find((node) =>
    Array.from(node.querySelectorAll("span")).some(
      (span) => span.textContent?.trim() === name,
    ),
  );
  expect(row, `Expected a row for ${name}`).toBeDefined();
  return row!;
}

function sidebarRow(target: HTMLElement, name: string) {
  const row = Array.from(
    target.querySelectorAll<HTMLButtonElement>(".rs-sidechat-item"),
  ).find(
    (node) => node.querySelector("span.truncate")?.textContent?.trim() === name,
  );
  expect(row, `Expected a chat row for ${name}`).toBeDefined();
  return row!;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  mocks.selectCharacter.mockClear();
  mocks.selectChat.mockClear();
  mocks.sortables.length = 0;
  selectedCharID.set(0);
  MobileSearch.set("");
  settingsStore.state.characterOrder = [];
  characterStore.characters = [];
});

afterEach(async () => {
  for (const app of apps.splice(0)) await unmount(app);
  document.body.replaceChildren();
  characterStore.characters = [];
  MobileSearch.set("");
  vi.restoreAllMocks();
});

describe("mobile character row identity", () => {
  it("preserves a character row when sorting and selects its original store index", async () => {
    characterStore.characters = [
      characterData("Zebra"),
      characterData("Alpha"),
    ];
    characterStore.characters[0].lastInteraction = 200;
    characterStore.characters[1].lastInteraction = 100;
    const target = render(MobileCharacters);
    await tick();
    const zebra = mobileRow(target, "Zebra");
    const alpha = mobileRow(target, "Alpha");

    target
      .querySelector<HTMLButtonElement>('[aria-label="Sort characters"]')!
      .click();
    await tick();
    const nameSort = Array.from(
      target.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Name");
    expect(nameSort).toBeDefined();
    nameSort!.click();
    await tick();
    expect(mobileRow(target, "Zebra")).toBe(zebra);
    expect(mobileRow(target, "Alpha")).toBe(alpha);
    expect(
      alpha.compareDocumentPosition(zebra) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    alpha.click();
    expect(mocks.selectCharacter).toHaveBeenCalledWith(1);
  });

  it("retains overlapping rows as the virtual scroll window moves", async () => {
    characterStore.characters = Array.from({ length: 40 }, (_, index) =>
      characterData(`Character ${String(index).padStart(2, "0")}`),
    );
    const target = render(MobileCharacters);
    await tick();
    const retained = mobileRow(target, "Character 08");
    const first = mobileRow(target, "Character 00");
    const scroller = first.parentElement!;
    scroller.scrollTop = 760;
    scroller.dispatchEvent(new Event("scroll"));
    await tick();
    expect(first.isConnected).toBe(false);
    expect(mobileRow(target, "Character 08")).toBe(retained);
    expect(scroller.querySelectorAll('[role="button"]').length).toBeLessThan(
      40,
    );
    retained.click();
    expect(mocks.selectCharacter).toHaveBeenCalledWith(8);
  });

  it("keeps ID-less character rows attached to the same object after filtering", async () => {
    characterStore.characters = [characterData("Alpha"), characterData("Beta")];
    characterStore.characters.forEach((character) => {
      character.chaId = "";
    });
    const target = render(MobileCharacters);
    await tick();
    const beta = mobileRow(target, "Beta");
    MobileSearch.set("Beta");
    await tick();
    expect(mobileRow(target, "Beta")).toBe(beta);
    beta.click();
    expect(mocks.selectCharacter).toHaveBeenCalledWith(1);
  });
});

describe.each([false, true])(
  "mobile chat row identity, folder=%s",
  (inFolder) => {
    it.each([false, true])(
      "preserves rows and updates selection indexes, ID-less=%s",
      async (idless) => {
        const folder = inFolder ? "folder" : undefined;
        characterStore.characters = [
          characterData("Owner", [
            chat("Alpha", folder, idless ? "" : "alpha"),
            chat("Beta", folder, idless ? "" : "beta"),
          ]),
        ];
        const owner = characterStore.characters[0];
        if (inFolder)
          owner.chatFolders = [{ id: "folder", name: "Folder", folded: false }];
        const target = render(MobileChatList);
        await tick();
        const beta = mobileRow(target, "Beta");
        owner.chats.reverse();
        await tick();
        expect(mobileRow(target, "Beta")).toBe(beta);
        beta.click();
        expect(mocks.selectChat).toHaveBeenCalledWith(0);

        const search = target.querySelector<HTMLInputElement>("input")!;
        search.value = "Beta";
        search.dispatchEvent(new Event("input", { bubbles: true }));
        await tick();
        expect(mobileRow(target, "Beta")).toBe(beta);
      },
    );
  },
);

describe.each([false, true])(
  "sidebar chat row identity, folder=%s",
  (inFolder) => {
    it("preserves chat rows through insertion and updates their click indexes", async () => {
      const folder = inFolder ? "folder" : undefined;
      characterStore.characters = [
        characterData("Owner", [chat("Alpha", folder), chat("Beta", folder)]),
      ];
      const owner = characterStore.characters[0];
      if (inFolder)
        owner.chatFolders = [{ id: "folder", name: "Folder", folded: false }];
      const target = render(SideChatList, { chara: owner });
      await tick();
      const beta = sidebarRow(target, "Beta");
      owner.chats.unshift(chat("New", folder));
      await tick();
      expect(sidebarRow(target, "Beta")).toBe(beta);
      expect(beta.dataset.risuChatIdx).toBe("2");
      beta.click();
      expect(owner.chatPage).toBe(2);
    });
  },
);

describe("sidebar drag synchronization", () => {
  async function setup() {
    characterStore.characters = [
      characterData("Owner", [
        chat("Alpha", "one"),
        chat("Beta", "one"),
        chat("Gamma", "two"),
      ]),
    ];
    const owner = characterStore.characters[0];
    owner.chatFolders = [
      { id: "one", name: "One", folded: false },
      { id: "two", name: "Two", folded: false },
    ];
    const target = render(SideChatList, { chara: owner });
    await tick();
    const editButton = target.querySelector<HTMLButtonElement>(
      ".rs-sidechat-toolbar > button:nth-child(3)",
    )!;
    editButton.click();
    await vi.waitFor(() =>
      expect(
        mocks.sortables.some(({ node }) =>
          node.classList.contains("risu-chat"),
        ),
      ).toBe(true),
    );
    return { owner, target };
  }

  function dragTo(source: HTMLElement, destination: HTMLElement) {
    destination.append(source);
    const registration = mocks.sortables.find(
      ({ node }) => node === destination,
    )!;
    return registration.options.onEnd!({ to: destination });
  }

  it("keeps the selected chat after Sortable reorders its DOM nodes", async () => {
    const { owner, target } = await setup();
    const alpha = target.querySelector<HTMLButtonElement>(
      '[data-risu-chat-idx="0"]',
    )!;
    await dragTo(alpha, alpha.parentElement!);
    await tick();
    expect(owner.chats.map((chat) => chat.name)).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
    ]);
    expect(owner.chats[owner.chatPage].id).toBe("Alpha");
    const inputs = Array.from(
      target.querySelectorAll<HTMLInputElement>(".rs-sidechat-item input"),
    );
    expect(inputs.map((input) => input.value)).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
    ]);
  });

  it("updates folder membership and preserves selection after a cross-folder drag", async () => {
    const { owner, target } = await setup();
    const alpha = target.querySelector<HTMLButtonElement>(
      '[data-risu-chat-idx="0"]',
    )!;
    const gamma = target.querySelector<HTMLButtonElement>(
      '[data-risu-chat-idx="2"]',
    )!;
    await dragTo(alpha, gamma.parentElement!);
    await tick();
    expect(owner.chats.map((chat) => chat.name)).toEqual([
      "Beta",
      "Gamma",
      "Alpha",
    ]);
    expect(owner.chats.find((chat) => chat.name === "Alpha")?.folderId).toBe(
      "two",
    );
    expect(owner.chats[owner.chatPage].id).toBe("Alpha");
    expect(
      target.querySelectorAll(
        '[data-risu-chat-folder-idx="0"] .rs-sidechat-item',
      ),
    ).toHaveLength(1);
    expect(
      target.querySelectorAll(
        '[data-risu-chat-folder-idx="1"] .rs-sidechat-item',
      ),
    ).toHaveLength(2);
  });
});
