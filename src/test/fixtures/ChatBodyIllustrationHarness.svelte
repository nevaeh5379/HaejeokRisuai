<script lang="ts">
    import ChatBody from 'src/lib/ChatScreens/ChatBody.svelte'
    import type { Message } from 'src/ts/storage/database/schema'
    import { characterStore } from 'src/ts/stores/domain/characterStore.svelte'
    import { settingsStore } from 'src/ts/stores/domain'

    let { initialMessage }: { initialMessage: Message } = $props()
    const getInitialMessage = () => initialMessage
    let message = $state(getInitialMessage())
    let characters = $state(characterStore.characters)
    characterStore.characters = characters
    characters[0].chats[0].message[0] = getInitialMessage()
    let root = $state<HTMLDivElement>()
    let chatTarget = $state({ characterId: 'character', chatId: 'chat' })
    let settings = $state(settingsStore.state)
    Object.defineProperty(settingsStore, 'state', { get: () => settings, configurable: true })

    export function setMessage(next: Message) {
        message = next
        characters[0].chats[0].message[0] = message
        chatTarget = { ...chatTarget }
    }

    export function setImageSettings(width: number, hidden: boolean) {
        settings.illustration = { ...settings.illustration, displayWidth: width }
        settings.hideAllImages = hidden
    }
</script>

<div bind:this={root}>
    <ChatBody sourceMessage={message} msgDisplay={message.data} bodyRoot={root}
        {chatTarget}
        role="char" modelShortName="" translated={false} translating={false} retranslate={false} />
</div>
