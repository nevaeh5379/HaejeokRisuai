<script lang="ts">
  import { tick } from "svelte";
  import { v4 } from "uuid";
  import type Sortable from "sortablejs/modular/sortable.core.esm.js";
  import {
    DownloadIcon,
    PencilIcon,
    HardDriveUploadIcon,
    MenuIcon,
    TrashIcon,
    SplitIcon,
    FolderPlusIcon,
    BookmarkCheckIcon,
    PlusIcon,
  } from "@lucide/svelte";

  import type {
    Chat,
    ChatFolder,
    character,
    groupChat,
  } from "../../ts/storage/database/schema";
  import {
    ReloadGUIPointer,
    selectedCharID,
    bookmarkListOpen,
  } from "src/ts/stores.svelte";
  import {
    characterStore,
    personaStore,
    messageStore,
  } from "src/ts/stores/domain";

  import CheckInput from "../UI/GUI/CheckInput.svelte";
  import Button from "../UI/GUI/Button.svelte";
  import TextInput from "../UI/GUI/TextInput.svelte";

  import {
    alertChatOptions,
    alertConfirm,
    alertError,
    alertNormal,
    alertSelect,
    alertStore,
  } from "src/ts/alert";
  import { language } from "src/lang";
  import Toggles from "./Toggles.svelte";
  import { releaseInactiveChatMessages } from "src/ts/stores/domain/messageStore.svelte";
  import { getProtectedChatIds } from "src/ts/memory/chatWorkingSet";
  import { chatTabsStore, pruneChatTargets } from "src/ts/chatTabs.svelte";
  import { duplicateChat } from "src/ts/characters";

  interface Props {
    chara: character | groupChat;
  }

  let { chara = $bindable() }: Props = $props();
  let editMode = $state(false);

  let chatsStb: Sortable[] = [];
  let folderStb: Sortable | null = null;

  let folderEles: HTMLDivElement = $state();
  let listEle: HTMLDivElement = $state();
  let parentContainerEl: HTMLDivElement = $state();
  let bottomContainerEl: HTMLDivElement = $state();
  let separatorEl: HTMLDivElement | undefined = $state();
  let sorted = $state(0);
  let sortableLoadId = 0;
  let isResizing = $state(false);

  const MIN_CHAT_LIST_HEIGHT = 80;
  const MIN_BOTTOM_HEIGHT = 80;
  const STORAGE_KEY = "risu_sidechat_bottom_height";
  const FOLDER_COLORS = [
    "red",
    "green",
    "blue",
    "yellow",
    "indigo",
    "purple",
    "pink",
    "default",
  ] as const;

  let bottomHeight = $state(
    typeof localStorage !== "undefined"
      ? Math.max(
          MIN_BOTTOM_HEIGHT,
          parseInt(localStorage.getItem(STORAGE_KEY) || "220", 10) || 220,
        )
      : 220,
  );

  function getTopReservedHeight(): number {
    if (!parentContainerEl) return 150;
    const btn = parentContainerEl.firstElementChild as HTMLElement | null;
    let btnHeight = btn ? btn.offsetHeight : 42;
    if (btn) {
      const style = window.getComputedStyle(btn);
      btnHeight +=
        (parseFloat(style.marginTop) || 0) +
        (parseFloat(style.marginBottom) || 0);
    }
    let sepHeight = 20;
    const sep =
      separatorEl ??
      (parentContainerEl.querySelector(
        '[role="separator"]',
      ) as HTMLElement | null);
    if (sep) {
      const style = window.getComputedStyle(sep);
      sepHeight =
        sep.offsetHeight +
        (parseFloat(style.marginTop) || 0) +
        (parseFloat(style.marginBottom) || 0);
    }
    const listMarginTop = 8;
    return btnHeight + listMarginTop + MIN_CHAT_LIST_HEIGHT + sepHeight;
  }

  function getMaxBottomHeight(containerHeight: number): number {
    return Math.max(
      MIN_BOTTOM_HEIGHT,
      containerHeight - getTopReservedHeight(),
    );
  }

  $effect(() => {
    if (!parentContainerEl) return;
    const clampHeight = () => {
      const containerHeight = parentContainerEl.clientHeight;
      if (containerHeight <= 0) return;
      const maxHeight = getMaxBottomHeight(containerHeight);
      if (bottomHeight > maxHeight) {
        bottomHeight = maxHeight;
      }
    };
    clampHeight();
    const ro = new ResizeObserver(clampHeight);
    ro.observe(parentContainerEl);
    return () => ro.disconnect();
  });

  function startResize(event: PointerEvent) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    isResizing = true;

    const startY = event.clientY;
    const startHeight = bottomHeight;

    const target = event.currentTarget as HTMLElement;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {}

    function onPointerMove(e: PointerEvent) {
      const deltaY = startY - e.clientY;
      const containerHeight = parentContainerEl
        ? parentContainerEl.clientHeight
        : window.innerHeight;
      const maxHeight = getMaxBottomHeight(containerHeight);
      bottomHeight = Math.min(
        Math.max(startHeight + deltaY, MIN_BOTTOM_HEIGHT),
        maxHeight,
      );
    }

    function onPointerUp(e: PointerEvent) {
      isResizing = false;
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerup", onPointerUp);
      target.removeEventListener("pointercancel", onPointerUp);
      try {
        target.releasePointerCapture(e.pointerId);
      } catch {}
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, bottomHeight.toString());
      }
    }

    target.addEventListener("pointermove", onPointerMove);
    target.addEventListener("pointerup", onPointerUp);
    target.addEventListener("pointercancel", onPointerUp);
  }

  const sortableOptions = {
    delay: 300,
    delayOnTouchOnly: true,
    filter: ".no-sort",
    onMove: (event: { related: HTMLElement }) => {
      return !event.related.classList.contains("no-sort");
    },
  } as const;

  const destroySortable = () => {
    if (folderStb) {
      try {
        folderStb.destroy();
      } catch {}
      folderStb = null;
    }
    for (const sortable of chatsStb) {
      try {
        sortable.destroy();
      } catch {}
    }
    chatsStb = [];
  };

  const changeChatTo = (index: number) => {
    if (index < 0 || index >= chara.chats.length) return;
    chara.chatPage = index;
    ReloadGUIPointer.set(Math.random());
    releaseInactiveChatMessages(() =>
      getProtectedChatIds([chara.chats[index]?.id]),
    );
  };

  const syncSortedChats = (
    folders: Iterable<Element>,
    assignFolderId: boolean,
  ) => {
    const currentChat = chara.chats[chara.chatPage];
    const newChats: Chat[] = [];

    for (const folder of folders) {
      const folderIdx = parseInt(
        folder.getAttribute("data-risu-chat-folder-idx"),
      );
      const folderId = chara.chatFolders[folderIdx]?.id;
      folder
        .querySelectorAll("[data-risu-chat-idx]")
        .forEach((chatInFolder) => {
          const chatIdx = parseInt(
            chatInFolder.getAttribute("data-risu-chat-idx"),
          );
          const newChat = chara.chats[chatIdx];
          if (assignFolderId) {
            newChat.folderId = folderId;
          }
          newChats.push(newChat);
        });
    }

    listEle.querySelectorAll("[data-risu-chat-idx]").forEach((chatEle) => {
      const idx = parseInt(chatEle.getAttribute("data-risu-chat-idx"));
      const newChat = chara.chats[idx];
      if (!newChats.includes(newChat)) {
        if (assignFolderId && newChat.folderId != null) {
          newChat.folderId = null;
        }
        newChats.push(newChat);
      }
    });

    changeChatTo(newChats.indexOf(currentChat));
    chara.chats = newChats;
  };

  const createStb = async () => {
    const loadId = ++sortableLoadId;
    destroySortable();
    if (!editMode) return;

    await tick();
    const { default: Sortable } =
      await import("sortablejs/modular/sortable.core.esm.js");
    if (!editMode || loadId !== sortableLoadId || !listEle || !folderEles)
      return;

    for (let chat of listEle.querySelectorAll(".risu-chat")) {
      chatsStb.push(
        new Sortable(chat, {
          group: "chats",
          onEnd: async () => {
            syncSortedChats(
              listEle.querySelectorAll("[data-risu-chat-folder-idx]"),
              true,
            );
            try {
              this.destroy();
            } catch (e) {}
            sorted += 1;
          },
          ...sortableOptions,
        }),
      );
    }
    folderStb = Sortable.create(folderEles, {
      group: "folders",
      onEnd: async (event) => {
        const folders: HTMLElement[] = Array.from<HTMLElement>(
          event.to.children,
        );
        const newFolders: ChatFolder[] = folders.map((folder) => {
          const folderIdx = parseInt(
            folder.getAttribute("data-risu-chat-folder-idx"),
          );
          return chara.chatFolders[folderIdx];
        });

        syncSortedChats(folders, false);
        chara.chatFolders = newFolders;
        try {
          folderStb.destroy();
        } catch (e) {}
        sorted += 1;
      },
      ...sortableOptions,
    });
  };

  $effect(() => {
    editMode;
    sorted;
    void createStb();
    return () => {
      sortableLoadId += 1;
      destroySortable();
    };
  });

  const handleKeyActivate = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.currentTarget as HTMLElement).click();
    }
  };

  const toggleEditMode = () => {
    editMode = !editMode;
  };

  const handleFolderMenu = async (e: MouseEvent, folder: ChatFolder) => {
    e.stopPropagation();
    const sel = parseInt(
      await alertSelect([language.changeFolderColor, language.cancel]),
    );
    if (sel === 0) {
      const colorSel = parseInt(await alertSelect([...FOLDER_COLORS]));
      folder.color = FOLDER_COLORS[colorSel];
    }
  };

  const handleDeleteFolder = async (
    e: MouseEvent,
    folder: ChatFolder,
    folderIdx: number,
  ) => {
    e.stopPropagation();
    const d = await alertConfirm(`${language.removeConfirm}${folder.name}`);
    if (d) {
      $ReloadGUIPointer += 1;
      const folders = chara.chatFolders;
      folders.splice(folderIdx, 1);
      chara.chats.forEach((chat) => {
        if (chat.folderId == folder.id) {
          chat.folderId = null;
        }
      });
      chara.chatFolders = folders;
    }
  };

  const handleChatMenu = async (chat: Chat, chatIdx: number) => {
    const option = await alertChatOptions();
    switch (option) {
      case 0: {
        await duplicateChat($selectedCharID, chatIdx, { selectNew: true });
        break;
      }
      case 1: {
        if (chat.bindedPersona) {
          const confirm = await alertConfirm(
            language.doYouWantToUnbindCurrentPersona,
          );
          if (confirm) {
            chat.bindedPersona = "";
            alertNormal(language.personaUnbindedSuccess);
          }
        } else {
          const confirm = await alertConfirm(
            language.doYouWantToBindCurrentPersona,
          );
          if (confirm) {
            const currentPersona = personaStore.activePersona;
            if (currentPersona) {
              if (!currentPersona.id) {
                currentPersona.id = v4();
              }
              chat.bindedPersona = currentPersona.id;
              alertNormal(language.personaBindedSuccess);
            }
          }
        }
        break;
      }
      case 2: {
        changeChatTo(chatIdx);
        const { createMultiuserRoom } = await import("src/ts/sync/multiuser");
        void createMultiuserRoom();
        break;
      }
    }
  };

  const handleExportChat = async (e: MouseEvent, chatIdx: number) => {
    e.stopPropagation();
    const { exportChat } = await import("src/ts/characters");
    await exportChat(chatIdx);
  };

  const handleDeleteChat = async (
    e: MouseEvent,
    chat: Chat,
    chatIdx: number,
  ) => {
    e.stopPropagation();
    if (chara.chats.length === 1) {
      alertError(language.errors.onlyOneChat);
      return;
    }
    const d = await alertConfirm(`${language.removeConfirm}${chat.name}`);
    if (d) {
      changeChatTo(0);
      $ReloadGUIPointer += 1;
      let chats = chara.chats;
      chats.splice(chatIdx, 1);
      chara.chats = chats;
      // Keep chat tabs consistent with the store: a tab that
      // still referenced the deleted chat would deadlock the
      // chat screen on its loading gate once activated.
      if (chat.id) {
        pruneChatTargets(chat.id);
      }
    }
  };
</script>

{#snippet actionButton(onclick: (e: MouseEvent) => void, Icon: typeof MenuIcon, mr = true)}
  <div
    role="button"
    tabindex="0"
    onkeydown={handleKeyActivate}
    class="text-textcolor2 hover:text-green-500 {mr
      ? 'mr-1'
      : ''} cursor-pointer"
    {onclick}
  >
    <Icon size={18} />
  </div>
{/snippet}

{#snippet chatItem(chat: Chat, chatIdx: number, inFolder = false)}
  <button
    data-risu-chat-idx={chatIdx}
    onclick={() => {
      if (!editMode) {
        changeChatTo(chatIdx);
        $ReloadGUIPointer += 1;
      }
    }}
    class="{inFolder
      ? 'risu-chats '
      : ''}rs-sidechat-item flex items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md [content-visibility:auto] [contain-intrinsic-size:40px]"
    class:bg-selected={chatIdx === chara.chatPage}
  >
    {#if editMode}
      <TextInput
        bind:value={chara.chats[chatIdx].name}
        className="grow min-w-0"
        padding={false}
      />
    {:else}
      <span class="flex items-center min-w-0 gap-1.5">
        <span class="truncate">{chat.name}</span>
      </span>
    {/if}
    <div class="rs-sidechat-actions grow flex justify-end">
      {@render actionButton(() => handleChatMenu(chat, chatIdx), MenuIcon)}
      {@render actionButton(toggleEditMode, PencilIcon)}
      {@render actionButton((e) => handleExportChat(e, chatIdx), DownloadIcon)}
      {@render actionButton(
        (e) => handleDeleteChat(e, chat, chatIdx),
        TrashIcon,
        false,
      )}
    </div>
  </button>
{/snippet}

<div
  bind:this={parentContainerEl}
  class="rs-sidechat-container flex flex-1 flex-col w-full min-h-0 overflow-hidden"
>
  <Button
    className="rs-sidechat-new-btn relative shrink-0 flex items-center justify-center gap-1.5"
    onclick={async () => {
      const cha = chara;
      const len = chara.chats.length;
      const newChat = {
        message: [],
        note: "",
        name: `New Chat ${len + 1}`,
        localLore: [],
        fmIndex: -1,
        id: v4(),
      };
      if (cha.type === "group") {
        const { findCharacterbyId } = await import("src/ts/util");
        cha.characters.forEach((c) => {
          newChat.message.push({
            chatId: v4(),
            saying: c,
            role: "char",
            data: findCharacterbyId(c).firstMessage,
          });
        });
      }
      chara.chats.unshift(newChat);
      if (newChat.id) {
        await messageStore.persistNewChat(
          chara.chaId,
          newChat.id,
          newChat.message,
        );
      }
      changeChatTo(0);
      $ReloadGUIPointer += 1;
    }}
  >
    <PlusIcon size={16} />
    <span>{language.newChat}</span>
  </Button>

  {#key sorted}
    <div
      class="flex flex-col mt-2 overflow-y-auto flex-1 min-h-[80px]"
      bind:this={listEle}
    >
      <!-- folder div -->
      <div class="flex flex-col" bind:this={folderEles}>
        <!-- chat folder -->
        {#each chara.chatFolders as folder, i}
          {@const folderChats = chara.chats
            .map((chat, idx) => ({ chat, idx }))
            .filter(({ chat }) => chat.folderId == folder.id)}
          <div
            data-risu-chat-folder-idx={i}
            class="rs-sidechat-folder flex flex-col mb-2 border-solid border-1 border-darkborderc cursor-pointer rounded-md"
          >
            <!-- folder header -->
            <button
              onclick={() => {
                if (!editMode) {
                  chara.chatFolders[i].folded = !folder.folded;
                  $ReloadGUIPointer += 1;
                }
              }}
              class="rs-sidechat-folder-header flex items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"
              class:bg-red-900={folder.color === "red"}
              class:bg-yellow-900={folder.color === "yellow"}
              class:bg-green-900={folder.color === "green"}
              class:bg-blue-900={folder.color === "blue"}
              class:bg-indigo-900={folder.color === "indigo"}
              class:bg-purple-900={folder.color === "purple"}
              class:bg-pink-900={folder.color === "pink"}
            >
              {#if editMode}
                <TextInput
                  bind:value={chara.chatFolders[i].name}
                  className="grow min-w-0"
                  padding={false}
                />
              {:else}
                <span>{folder.name}</span>
              {/if}
              <div class="grow flex justify-end">
                {@render actionButton(
                  (e) => handleFolderMenu(e, folder),
                  MenuIcon,
                )}
                {@render actionButton(toggleEditMode, PencilIcon)}
                {@render actionButton(
                  (e) => handleDeleteFolder(e, folder, i),
                  TrashIcon,
                  false,
                )}
              </div>
            </button>
            <!-- chats in folder -->
            <div
              class="risu-chat flex flex-col w-full text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md {folder.folded
                ? 'hidden'
                : ''}"
            >
              {#if folderChats.length === 0}
                <span class="no-sort flex justify-center text-textcolor2"
                  >Empty</span
                >
                <div></div>
              {:else}
                {#each folderChats as { chat, idx }}
                  {@render chatItem(chat, idx, true)}
                {/each}
              {/if}
            </div>
          </div>
        {/each}
      </div>
      <!-- chat without folder div -->
      <div class="risu-chat flex flex-col">
        {#each chara.chats as chat, i}
          {#if chat.folderId == null}
            {@render chatItem(chat, i, false)}
          {/if}
        {/each}
      </div>
    </div>
  {/key}

  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={separatorEl}
    role="separator"
    aria-orientation="horizontal"
    class="rs-sidechat-separator group relative flex items-center justify-center h-3 shrink-0 cursor-row-resize touch-none select-none my-1"
    class:bg-selected={isResizing}
    onpointerdown={startResize}
  >
    <div
      class="rs-sidechat-separator-line w-full h-px bg-selected/40 group-hover:bg-selected transition-colors"
    ></div>
    <div
      class="rs-sidechat-resize-handle absolute px-3 py-0.5 rounded-full bg-darkbg border border-selected/40 group-hover:border-selected flex items-center justify-center shadow-xs transition-colors pointer-events-none"
    >
      <div
        class="rs-sidechat-resize-grip w-6 h-0.5 rounded-full bg-textcolor2/50 group-hover:bg-selected"
      ></div>
    </div>
  </div>

  <div
    bind:this={bottomContainerEl}
    style="height: {bottomHeight}px;"
    class="flex flex-col shrink-0 min-h-[80px] overflow-hidden"
  >
    <div
      class="rs-sidechat-toolbar flex items-center px-1 py-1.5 shrink-0 border-b border-darkborderc/40 gap-2 mb-2"
    >
      <button
        class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
        onclick={async () => {
          const { exportAllChats } = await import("src/ts/characters");
          await exportAllChats();
        }}
      >
        <DownloadIcon size={18} />
      </button>
      <button
        class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
        onclick={async () => {
          const { importChat } = await import("src/ts/characters");
          await importChat();
        }}
      >
        <HardDriveUploadIcon size={18} />
      </button>
      <button
        class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
        onclick={toggleEditMode}
      >
        <PencilIcon size={18} />
      </button>
      <button
        class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
        title={language.branchGraphTitle}
        onclick={async () => {
          const focusedTab = chatTabsStore.activeTab;
          let characterIndex = $selectedCharID;
          let chatIndex = chara.chatPage;
          if (focusedTab) {
            const focusedCharacterIndex = characterStore.characters.findIndex(
              (character) => character.chaId === focusedTab.characterId,
            );
            const focusedChatIndex =
              characterStore.characters[
                focusedCharacterIndex
              ]?.chats?.findIndex((chat) => chat.id === focusedTab.chatId) ??
              -1;
            if (focusedCharacterIndex >= 0 && focusedChatIndex >= 0) {
              characterIndex = focusedCharacterIndex;
              chatIndex = focusedChatIndex;
            }
          }
          const activeChat =
            characterStore.characters[characterIndex]?.chats?.[chatIndex];
          if (!activeChat) return;
          activeChat.id ??= v4();
          const targetChatId = activeChat.id;
          const { preLoadChat } =
            await import("src/ts/process/coldstorage.svelte");
          await preLoadChat(characterIndex, chatIndex, { full: true });
          const loadedChat =
            characterStore.characters[characterIndex]?.chats?.[chatIndex];
          if (loadedChat?.id !== targetChatId) return;
          alertStore.set({
            type: "branches",
            msg: targetChatId,
          });
        }}
      >
        <SplitIcon size={18} />
      </button>
      <button
        class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
        onclick={() => {
          $bookmarkListOpen = true;
        }}
      >
        <BookmarkCheckIcon size={18} />
      </button>
      <button
        class="ml-auto text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
        onclick={() => {
          if (!chara.chatFolders) {
            chara.chatFolders = [];
          }
          const folders = chara.chatFolders;
          const length = chara.chatFolders.length;
          folders.unshift({
            id: v4(),
            name: `New Folder ${length + 1}`,
            folded: false,
          });
          chara.chatFolders = folders;
          $ReloadGUIPointer += 1;
        }}
      >
        <FolderPlusIcon size={18} />
      </button>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2 pr-0.5">
      {#if characterStore.characters[$selectedCharID]?.chaId !== "§playground"}
        <Toggles bind:chara noContainer />
      {/if}
      {#if chara.type === "group"}
        <div class="flex mt-2 items-center">
          <CheckInput
            bind:check={chara.orderByOrder}
            name={language.orderByOrder}
          />
        </div>
      {/if}
    </div>
  </div>
</div>
