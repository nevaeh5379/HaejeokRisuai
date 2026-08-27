<script lang="ts">
    import { characterStore, settingsStore } from 'src/ts/stores/domain';
    import { language } from 'src/lang';
    import { getCharImage } from 'src/ts/characterImage';
    import { getPreparedNativeThumbnailSrc } from 'src/ts/globalApi.svelte';
    import SidebarAvatar from './SidebarAvatar.svelte';
    import {
        MessageSquareIcon,
        SearchIcon,
        XIcon,
        ClockIcon,
        UsersIcon,
        FolderIcon,
        MessageCircleIcon,
    } from '@lucide/svelte';

    interface Props {
        reseter?: () => void;
    }

    let { reseter = () => {} }: Props = $props();

    function recentThumbnail(loc: string) {
        return getPreparedNativeThumbnailSrc(loc) ?? getCharImage(loc, 'plain', { thumbnail: true });
    }

    let searchInput = $state('');

    const agoFormatter = new Intl.RelativeTimeFormat(
        typeof navigator !== 'undefined' ? navigator.languages : 'en',
        { style: 'short' }
    );

    function makeAgoText(time: number): string {
        if (!time || time <= 0) {
            return '';
        }
        const diff = Date.now() - time;
        if (diff < 60000) {
            const sec = Math.max(1, Math.floor(diff / 1000));
            return agoFormatter.format(-sec, 'second');
        }
        if (diff < 3600000) {
            const min = Math.floor(diff / 60000);
            return agoFormatter.format(-min, 'minute');
        }
        if (diff < 86400000) {
            const hour = Math.floor(diff / 3600000);
            return agoFormatter.format(-hour, 'hour');
        }
        if (diff < 604800000) {
            const day = Math.floor(diff / 86400000);
            return agoFormatter.format(-day, 'day');
        }
        if (diff < 2592000000) {
            const week = Math.floor(diff / 604800000);
            return agoFormatter.format(-week, 'week');
        }
        if (diff < 31536000000) {
            const month = Math.floor(diff / 2592000000);
            return agoFormatter.format(-month, 'month');
        }
        const year = Math.floor(diff / 31536000000);
        return agoFormatter.format(-year, 'year');
    }

    interface SessionItem {
        charIndex: number;
        chatIndex: number;
        characterName: string;
        characterImage?: string;
        characterId?: string;
        isGroup: boolean;
        chatName: string;
        folderName?: string;
        lastMessageSnippet: string;
        timestamp: number;
        agoText: string;
    }

    function cleanSnippet(text: string): string {
        if (!text) return '';
        return text
            .replace(/!\[.*?\]\(.*?\)/g, '') // remove markdown images
            .replace(/\[.*?\]\(.*?\)/g, '') // remove markdown links
            .replace(/<[^>]*>/g, '') // remove HTML tags
            .replace(/[\r\n\t]+/g, ' ') // collapse whitespaces
            .trim();
    }

    let allSessions = $derived.by<SessionItem[]>(() => {
        const characters = characterStore.characters ?? [];
        const sessions: SessionItem[] = [];

        for (let charIdx = 0; charIdx < characters.length; charIdx++) {
            const char = characters[charIdx];
            if (!char || char.trashTime) continue;

            const chats = char.chats ?? [];
            const isGroup = char.type === 'group';

            for (let chatIdx = 0; chatIdx < chats.length; chatIdx++) {
                const chat = chats[chatIdx];
                if (!chat) continue;

                const lastMsg =
                    chat.message && chat.message.length > 0
                        ? chat.message[chat.message.length - 1]
                        : null;

                const rawSnippet = lastMsg?.data ?? '';
                const snippet = cleanSnippet(rawSnippet);

                const timestamp =
                    chat.lastDate ||
                    lastMsg?.time ||
                    (chatIdx === char.chatPage ? char.lastInteraction : 0) ||
                    0;

                let folderName: string | undefined = undefined;
                if (chat.folderId && char.chatFolders) {
                    const folder = char.chatFolders.find((f) => f.id === chat.folderId);
                    folderName = folder?.name;
                }

                sessions.push({
                    charIndex: charIdx,
                    chatIndex: chatIdx,
                    characterName: char.name ?? 'Unknown',
                    characterImage: char.image,
                    characterId: char.chaId,
                    isGroup,
                    chatName: chat.name || `${language.Chat} ${chatIdx + 1}`,
                    folderName,
                    lastMessageSnippet: snippet,
                    timestamp,
                    agoText: makeAgoText(timestamp),
                });
            }
        }

        // Sort descending by latest interaction/message time
        return sessions
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 50);
    });

    let filteredSessions = $derived.by(() => {
        const query = searchInput.trim().toLowerCase();
        if (!query) return allSessions;

        return allSessions.filter((session) => {
            return (
                session.characterName.toLowerCase().includes(query) ||
                session.chatName.toLowerCase().includes(query) ||
                session.lastMessageSnippet.toLowerCase().includes(query) ||
                (session.folderName &&
                    session.folderName.toLowerCase().includes(query))
            );
        });
    });

    async function selectSession(item: SessionItem) {
        const { changeChar } = await import('../../ts/characters');
        const { changeChatTo } = await import('../../ts/globalApi.svelte');

        const char = characterStore.characters[item.charIndex];
        if (!char) return;

        char.chatPage = item.chatIndex;
        await changeChar(item.charIndex, { reseter });
        changeChatTo(item.chatIndex);
    }
</script>

<div class="flex flex-col w-full h-full min-h-0 select-none">
    <!-- Header -->
    <div class="flex items-center justify-between mb-3 px-1 shrink-0">
        <div class="flex items-center gap-2">
            <ClockIcon size={18} class="text-textcolor2" />
            <h2 class="text-base font-bold text-textcolor m-0">
                {language.recentSessions ?? 'Recent Sessions'}
            </h2>
        </div>
        {#if allSessions.length > 0}
            <span
                class="text-xs px-2 py-0.5 rounded-full bg-textcolor/10 text-textcolor2 font-mono"
            >
                {allSessions.length}
            </span>
        {/if}
    </div>

    <!-- Search Input -->
    {#if allSessions.length > 3}
        <div class="relative mb-3 shrink-0">
            <SearchIcon
                size={16}
                class="absolute left-2.5 top-1/2 -translate-y-1/2 text-textcolor2 pointer-events-none"
            />
            <input
                type="text"
                bind:value={searchInput}
                placeholder={language.searchSessions ?? 'Search sessions...'}
                class="w-full bg-bgcolor border border-darkborderc rounded-lg pl-8 pr-8 py-1.5 text-xs text-textcolor placeholder-textcolor2/60 focus:outline-none focus:border-selected transition-colors"
            />
            {#if searchInput}
                <button
                    class="absolute right-2 top-1/2 -translate-y-1/2 text-textcolor2 hover:text-textcolor p-0.5 rounded cursor-pointer"
                    onclick={() => (searchInput = '')}
                >
                    <XIcon size={14} />
                </button>
            {/if}
        </div>
    {/if}

    <!-- Session List -->
    <div
        class="flex flex-col gap-1.5 overflow-y-auto grow min-h-0 pr-1 rs-custom-scroll"
    >
        {#if allSessions.length === 0}
            <!-- Empty state when no chats exist at all -->
            <div
                class="flex flex-col items-center justify-center text-center p-6 my-auto text-textcolor2"
            >
                <div
                    class="w-12 h-12 rounded-full bg-textcolor/5 flex items-center justify-center mb-3"
                >
                    <MessageSquareIcon size={24} class="text-textcolor2" />
                </div>
                <h3 class="text-sm font-semibold text-textcolor mb-1">
                    Welcome to RisuAI!
                </h3>
                <p class="text-xs text-textcolor2 max-w-xs">
                    {language.noRecentSessions ?? 'Select a bot to start chatting'}
                </p>
            </div>
        {:else if filteredSessions.length === 0}
            <!-- Empty state when search has no matches -->
            <div
                class="flex flex-col items-center justify-center text-center p-6 my-auto text-textcolor2"
            >
                <SearchIcon size={24} class="text-textcolor2/60 mb-2" />
                <p class="text-xs text-textcolor2">
                    {language.noMatchingSessions ?? 'No sessions found matching your search'}
                </p>
            </div>
        {:else}
            {#each filteredSessions as session (`${session.charIndex}-${session.chatIndex}`)}
                <button
                    type="button"
                    class="flex items-center gap-2.5 p-2 rounded-lg text-left transition-all bg-bgcolor/40 hover:bg-bgcolor border border-darkborderc/40 hover:border-selected/60 group w-full cursor-pointer overflow-hidden relative shrink-0"
                    onclick={() => void selectSession(session)}
                >
                    <!-- Avatar with Group Badge -->
                    <div class="relative shrink-0">
                        <SidebarAvatar
                            src={session.characterImage
                                ? () => recentThumbnail(session.characterImage!)
                                : '/none.webp'}
                            size="40"
                            rounded={settingsStore.state.roundIcons}
                            name={session.characterName}
                            chaId={session.characterId}
                        />
                        {#if session.isGroup}
                            <div
                                class="absolute -bottom-1 -right-1 bg-selected text-white rounded-full p-0.5 shadow"
                                title="Group Chat"
                            >
                                <UsersIcon size={10} />
                            </div>
                        {/if}
                    </div>

                    <!-- Content -->
                    <div class="flex flex-col grow min-w-0">
                        <!-- Top Line: Character Name & Ago Text -->
                        <div class="flex items-center justify-between gap-1 w-full">
                            <span
                                class="font-semibold text-xs text-textcolor truncate group-hover:text-selected transition-colors"
                            >
                                {session.characterName}
                            </span>
                            {#if session.agoText}
                                <span
                                    class="text-[10px] text-textcolor2/70 shrink-0 font-mono"
                                >
                                    {session.agoText}
                                </span>
                            {/if}
                        </div>

                        <!-- Mid Line: Chat Name / Folder -->
                        <div
                            class="flex items-center gap-1 text-[11px] text-textcolor2 truncate mt-0.5"
                        >
                            <MessageCircleIcon
                                size={11}
                                class="shrink-0 text-textcolor2/60"
                            />
                            {#if session.folderName}
                                <span
                                    class="inline-flex items-center gap-0.5 text-[10px] px-1 py-0.2 rounded bg-textcolor/5 text-textcolor2 shrink-0 max-w-[80px] truncate"
                                >
                                    <FolderIcon size={9} />
                                    {session.folderName}
                                </span>
                            {/if}
                            <span class="truncate font-medium text-textcolor2">
                                {session.chatName}
                            </span>
                        </div>

                        <!-- Bottom Line: Last Message Snippet (if available) -->
                        {#if session.lastMessageSnippet}
                            <p
                                class="text-[10px] text-textcolor2/60 truncate mt-0.5 m-0 font-normal"
                            >
                                {session.lastMessageSnippet}
                            </p>
                        {/if}
                    </div>
                </button>
            {/each}
        {/if}
    </div>
</div>
