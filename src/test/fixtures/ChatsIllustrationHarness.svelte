<script lang="ts">
    import Chats from 'src/lib/ChatScreens/Chats.svelte'
    import { characterStore } from 'src/ts/stores/domain'
    import type { character } from 'src/ts/storage/database/schema'

    let { initialCharacter }: { initialCharacter: character } = $props()
    const initial = () => initialCharacter
    let currentCharacter = $state(initial())
    let characters = $state([initial()])
    characterStore.characters = characters

    export function hydrate(next: character) {
        currentCharacter = next
        characters[0] = currentCharacter
    }
</script>

<Chats messages={currentCharacter.chats[0].message} {currentCharacter}
    currentUsername="User" userIcon="" hideButtons={true}
    targetCharacterIndex={0} targetChatIndex={0} />
