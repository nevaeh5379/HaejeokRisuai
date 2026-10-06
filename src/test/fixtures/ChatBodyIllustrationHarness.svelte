<script lang="ts">
    import ChatBody from 'src/lib/ChatScreens/ChatBody.svelte'
    import type { Message } from 'src/ts/storage/database/schema'

    let { initialMessage }: { initialMessage: Message } = $props()
    const getInitialMessage = () => initialMessage
    let message = $state(getInitialMessage())
    let root = $state<HTMLDivElement>()
    const chatTarget = { characterId: 'character', chatId: 'chat' }

    export function setMessage(next: Message) {
        message = next
    }
</script>

<div bind:this={root}>
    <ChatBody sourceMessage={message} msgDisplay={message.data} bodyRoot={root}
        {chatTarget}
        role="char" modelShortName="" translated={false} translating={false} retranslate={false} />
</div>
