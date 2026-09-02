<script lang="ts">
    import { CheckIcon, EyeIcon, PlusIcon, RotateCcwIcon, TrashIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { alertConfirm, alertInput, alertNormal } from 'src/ts/alert'
    import {
        applyCharacterSnapshot,
        createCharacterSnapshot,
        getCharacterSnapshots,
        syncCharacterSnapshotAssetReferences,
    } from 'src/ts/characterSnapshots'
    import { characterStore } from 'src/ts/stores/domain'
    import { selectedCharID } from 'src/ts/stores.svelte'
    import type { character, CharacterSnapshot, groupChat } from 'src/ts/storage/database/schema'

    let previewCharacterId = $state<string | null>(null)
    let previewSnapshotId = $state<string | null>(null)

    const selectedIndex = $derived($selectedCharID)
    const currentCharacter = $derived(characterStore.characters[selectedIndex] as character | groupChat | undefined)
    const snapshots = $derived.by(() => {
        if (!currentCharacter || currentCharacter.type === 'group') return []
        return [...getCharacterSnapshots(currentCharacter)].sort((a, b) => b.createdAt - a.createdAt)
    })
    function clearPreviewState() {
        previewCharacterId = null
        previewSnapshotId = null
    }

    function revertPreview() {
        if (!previewCharacterId) return
        characterStore.endTemporaryCharacterOverride(previewCharacterId, false)
        clearPreviewState()
    }

    async function keepPreview() {
        if (!previewCharacterId) return
        characterStore.endTemporaryCharacterOverride(previewCharacterId, true)
        clearPreviewState()
        await characterStore.flush()
        alertNormal(language.characterSnapshots.previewKept)
    }

    async function addSnapshot() {
        const char = currentCharacter
        if (!char || char.type === 'group' || previewCharacterId) return
        const defaultName = `${language.characterSnapshots.defaultName} ${snapshots.length + 1}`
        const name = await alertInput(language.characterSnapshots.namePrompt, undefined, defaultName)
        if (!name?.trim()) return
        const snapshot = createCharacterSnapshot(char, name)
        char.snapshots = [...getCharacterSnapshots(char), snapshot]
        syncCharacterSnapshotAssetReferences(char)
        characterStore.markCharacterDirty(char.chaId)
        await characterStore.flush()
        alertNormal(language.characterSnapshots.created)
    }

    async function previewSnapshot(snapshot: CharacterSnapshot) {
        const char = currentCharacter
        if (!char || char.type === 'group') return
        const restored = applyCharacterSnapshot(char, snapshot)
        const started = await characterStore.beginTemporaryCharacterOverride(selectedIndex, restored)
        if (!started) {
            alertNormal(language.characterSnapshots.previewFailed)
            return
        }
        previewCharacterId = char.chaId
        previewSnapshotId = snapshot.id
    }

    async function restoreSnapshot(snapshot: CharacterSnapshot) {
        const char = currentCharacter
        if (!char || char.type === 'group' || previewCharacterId) return
        const confirmed = await alertConfirm(
            language.characterSnapshots.restoreConfirm.replace('{name}', snapshot.name),
        )
        if (!confirmed) return
        const restored = applyCharacterSnapshot(char, snapshot)
        characterStore.setCharacterByIndex(selectedIndex, restored)
        await characterStore.flush()
        alertNormal(language.characterSnapshots.restored)
    }

    async function deleteSnapshot(snapshot: CharacterSnapshot) {
        const char = currentCharacter
        if (!char || char.type === 'group' || previewCharacterId) return
        const confirmed = await alertConfirm(
            language.characterSnapshots.deleteConfirm.replace('{name}', snapshot.name),
        )
        if (!confirmed) return
        char.snapshots = getCharacterSnapshots(char).filter((item) => item.id !== snapshot.id)
        syncCharacterSnapshotAssetReferences(char)
        characterStore.markCharacterDirty(char.chaId)
        await characterStore.flush()
    }

    $effect(() => {
        const selectedCharacterId = currentCharacter?.chaId ?? null
        previewCharacterId = selectedCharacterId && characterStore.hasTemporaryCharacterOverride(selectedCharacterId)
            ? selectedCharacterId
            : null
        if (!previewCharacterId) previewSnapshotId = null
    })
</script>
<div class="flex flex-col gap-3">
    <div class="rounded-lg border border-darkborderc bg-darkbg/30 p-3">
        <div class="flex items-start justify-between gap-3">
            <div>
                <h2 class="text-lg font-bold text-textcolor">{language.characterSnapshots.title}</h2>
                <p class="mt-1 text-xs text-textcolor2">{language.characterSnapshots.description}</p>
            </div>
            <button
                class="flex shrink-0 items-center gap-1 rounded-md border border-darkborderc px-2.5 py-1.5 text-sm text-textcolor hover:bg-selected disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!!previewCharacterId}
                onclick={addSnapshot}
            >
                <PlusIcon size={16} />
                <span>{language.characterSnapshots.create}</span>
            </button>
        </div>
    </div>

    {#if previewCharacterId}
        <div class="rounded-lg border border-blue-500/50 bg-blue-500/10 p-3">
            <div class="font-semibold text-textcolor">{language.characterSnapshots.previewing}</div>
            <p class="mt-1 text-xs text-textcolor2">{language.characterSnapshots.previewDescription}</p>
            <div class="mt-3 flex gap-2">
                <button class="flex items-center gap-1 rounded-md bg-selected px-3 py-1.5 text-sm text-textcolor hover:brightness-110" onclick={revertPreview}>
                    <RotateCcwIcon size={15} />
                    <span>{language.characterSnapshots.revertPreview}</span>
                </button>
                <button class="flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500" onclick={keepPreview}>
                    <CheckIcon size={15} />
                    <span>{language.characterSnapshots.keepPreview}</span>
                </button>
            </div>
        </div>
    {/if}
    {#if snapshots.length === 0}
        <div class="rounded-lg border border-dashed border-darkborderc p-6 text-center text-sm text-textcolor2">
            {language.characterSnapshots.empty}
        </div>
    {:else}
        <div class="flex flex-col gap-2">
            {#each snapshots as snapshot (snapshot.id)}
                <div class="rounded-lg border border-darkborderc bg-darkbg/20 p-3">
                    <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                            <div class="truncate font-medium text-textcolor">{snapshot.name}</div>
                            <div class="mt-0.5 text-xs text-textcolor2">
                                {new Date(snapshot.createdAt).toLocaleString()}
                            </div>
                        </div>
                        {#if previewSnapshotId === snapshot.id}
                            <span class="shrink-0 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs text-blue-300">
                                {language.characterSnapshots.previewBadge}
                            </span>
                        {/if}
                    </div>
                    <div class="mt-3 flex flex-wrap gap-2">
                        <button
                            class="flex items-center gap-1 rounded-md border border-darkborderc px-2 py-1 text-xs text-textcolor hover:bg-selected"
                            onclick={() => previewSnapshot(snapshot)}
                        >
                            <EyeIcon size={14} />
                            <span>{language.characterSnapshots.preview}</span>
                        </button>
                        <button
                            class="flex items-center gap-1 rounded-md border border-darkborderc px-2 py-1 text-xs text-textcolor hover:bg-selected disabled:opacity-40"
                            disabled={!!previewCharacterId}
                            onclick={() => restoreSnapshot(snapshot)}
                        >
                            <RotateCcwIcon size={14} />
                            <span>{language.characterSnapshots.restore}</span>
                        </button>
                        <button
                            class="flex items-center gap-1 rounded-md border border-red-500/30 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                            disabled={!!previewCharacterId}
                            onclick={() => deleteSnapshot(snapshot)}
                        >
                            <TrashIcon size={14} />
                            <span>{language.characterSnapshots.delete}</span>
                        </button>
                    </div>
                </div>
            {/each}
        </div>
    {/if}
</div>
