<script lang="ts">
    import BranchGraphModal from 'src/lib/Others/BranchGraphModal.svelte'
    import type { Chat } from 'src/ts/storage/database/schema'
    import type { SqlChatBranchGraphData } from 'src/ts/storage/sql/ISqlStorage'

    interface Props {
        initialChat: Chat
    }

    let { initialChat }: Props = $props()
    const getInitialChat = () => initialChat
    let chat = $state<Chat>(getInitialChat())
    let branchGraph = $state<SqlChatBranchGraphData | null>(null)

    export function setChat(next: Chat) {
        chat = next
    }

    export function setBranchGraph(next: SqlChatBranchGraphData | null) {
        branchGraph = next
    }
</script>

<BranchGraphModal {chat} {branchGraph} onselect={() => {}} onclose={() => {}} />
