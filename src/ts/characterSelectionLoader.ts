export interface SelectionChat {
    id?: string
    messagesLoaded?: boolean
    detailsLoaded?: boolean
}

export interface SelectionCharacter {
    chaId?: string
    detailsLoaded?: boolean
    chatPage?: number
    chats?: SelectionChat[]
}

interface CharacterSelectionLoaderOptions {
    getCharacter: () => SelectionCharacter | undefined
    ensureCharacterDetails: (characterId: string) => Promise<void>
    preLoadChat: (chatIndex: number) => Promise<void>
}

function needsChatLoad(chat: SelectionChat | undefined): boolean {
    return Boolean(chat?.id && (
        chat.messagesLoaded === false || chat.detailsLoaded === false
    ))
}

export async function loadCharacterSelectionData({
    getCharacter,
    ensureCharacterDetails,
    preLoadChat,
}: CharacterSelectionLoaderOptions): Promise<void> {
    const initialCharacter = getCharacter()
    const initialChatPage = initialCharacter?.chatPage ?? 0
    const initialChat = initialCharacter?.chats?.[initialChatPage]
    const shouldLoadDetails = initialCharacter?.detailsLoaded === false && Boolean(initialCharacter.chaId)

    if (!shouldLoadDetails) {
        await preLoadChat(initialChatPage)
        return
    }

    if (initialChat?.id) {
        await Promise.all([
            ensureCharacterDetails(initialCharacter!.chaId!),
            preLoadChat(initialChatPage),
        ])
    } else {
        await ensureCharacterDetails(initialCharacter!.chaId!)
    }

    const currentCharacter = getCharacter()
    const currentChatPage = currentCharacter?.chatPage ?? 0
    const currentChat = currentCharacter?.chats?.[currentChatPage]
    const initialLoadCoveredCurrentChat = Boolean(
        initialChat?.id &&
        currentChat?.id === initialChat.id &&
        currentChatPage === initialChatPage
    )

    if (!initialLoadCoveredCurrentChat || needsChatLoad(currentChat)) {
        await preLoadChat(currentChatPage)
    }
}
