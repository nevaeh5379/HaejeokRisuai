<script lang="ts">
    import BranchGraphModal from 'src/lib/Others/BranchGraphModal.svelte'
    import type { Chat } from 'src/ts/storage/database/schema'

    interface Props {
        initialChat: Chat
    }

    let { initialChat }: Props = $props()
    const getInitialChat = () => initialChat
    let chat = $state<Chat>(getInitialChat())

    export function setChat(next: Chat) {
        chat = next
    }
</script>

<BranchGraphModal {chat} onselect={() => {}} onclose={() => {}} />
